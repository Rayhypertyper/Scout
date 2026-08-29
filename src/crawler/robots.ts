import type { Logger } from "../utils/logger.js";
import type { HttpClient } from "./http.js";
import type { Profiler } from "../observability/profiler.js";
import { performance } from "node:perf_hooks";

interface RobotRule {
  allow: boolean;
  path: string;
}

interface RobotPolicy {
  rules: RobotRule[];
  crawlDelayMs: number | null;
}

function parsePolicy(source: string, userAgent = "internshipscout"): RobotPolicy {
  const groups: Array<{ agents: string[]; rules: RobotRule[]; crawlDelayMs: number | null }> = [];
  let current: (typeof groups)[number] | null = null;
  let sawRule = false;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLocaleLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      if (!current || sawRule) {
        current = { agents: [], rules: [], crawlDelayMs: null };
        groups.push(current);
        sawRule = false;
      }
      current.agents.push(value.toLocaleLowerCase());
    } else if (current && (field === "allow" || field === "disallow")) {
      sawRule = true;
      if (value) current.rules.push({ allow: field === "allow", path: value });
    } else if (current && field === "crawl-delay") {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelayMs = seconds * 1_000;
    }
  }
  // Robots user-agent matching is case-insensitive and chooses the most
  // specific matching product token; a wildcard group is only a fallback.
  // Consider every token in a compound UA (for example
  // `Mozilla/5.0 InternshipScout/1.0`) so a generic browser token cannot mask
  // a configured crawler group that appears later in robots.txt.
  const normalizedUa = userAgent.toLocaleLowerCase();
  const tokens = normalizedUa.split(/[\s/()+,;:_-]/u).filter((part) => part.length > 2);
  const matchingGroups = groups
    .map((group) => {
      const specificity = group.agents
        .filter((agent) => agent !== "*")
        .map((agent) => agent.toLocaleLowerCase())
        .filter((agent) => normalizedUa.includes(agent) || tokens.some((token) => token === agent || token.includes(agent) || agent.includes(token)))
        .reduce((best, agent) => Math.max(best, agent.length), 0);
      return { group, specificity };
    })
    .filter(({ specificity }) => specificity > 0)
    .sort((left, right) => right.specificity - left.specificity);
  const group = matchingGroups[0]?.group ?? groups.find(({ agents }) => agents.some((agent) => agent.trim() === "*"));
  return group ? { rules: group.rules, crawlDelayMs: group.crawlDelayMs } : { rules: [], crawlDelayMs: null };
}

function rulePattern(rule: string): RegExp {
  const anchored = rule.endsWith("$");
  const source = (anchored ? rule.slice(0, -1) : rule)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`);
}

export class RobotsManager {
  private readonly policies = new Map<string, Promise<RobotPolicy>>();

  public constructor(
    private readonly userAgent: string,
    private readonly timeoutMs: number,
    private readonly logger: Logger,
    private readonly http?: HttpClient,
    private readonly profiler?: Profiler,
  ) {}

  public async check(value: string): Promise<{ allowed: boolean; crawlDelayMs: number | null }> {
    const url = new URL(value);
    const origin = url.origin;
    let policyPromise = this.policies.get(origin);
    if (!policyPromise) {
      policyPromise = this.load(origin);
      this.policies.set(origin, policyPromise);
    }
    const policy = await policyPromise;
    const matching = policy.rules
      .filter((rule) => rulePattern(rule.path).test(`${url.pathname}${url.search}`))
      .sort((left, right) => right.path.length - left.path.length)[0];
    return { allowed: matching?.allow ?? true, crawlDelayMs: policy.crawlDelayMs };
  }

  private async load(origin: string): Promise<RobotPolicy> {
    try {
      if (this.http) {
        const response = await this.http.get(`${origin}/robots.txt`, {
          cache: true,
          headers: { accept: "text/plain" },
          // Robots is a policy request, not a listing/detail fetch. It still
          // goes through the shared HTTP lane so domain limits and retries are
          // applied consistently.
          perHostDelayMs: 0,
        });
        if (response.status < 200 || response.status >= 300) return { rules: [], crawlDelayMs: null };
        return parsePolicy(response.body, this.userAgent);
      }
      const startedAt = performance.now();
      const response = await fetch(`${origin}/robots.txt`, {
        headers: { "user-agent": this.userAgent, accept: "text/plain" },
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 10_000)),
      });
      this.profiler?.recordSpan("http_fetch", performance.now() - startedAt, { url: `${origin}/robots.txt`, source: origin });
      if (!response.ok) return { rules: [], crawlDelayMs: null };
      return parsePolicy(await response.text(), this.userAgent);
    } catch (error) {
      this.logger.debug("ROBOTS", `Could not read ${origin}/robots.txt: ${error instanceof Error ? error.message : String(error)}`);
      return { rules: [], crawlDelayMs: null };
    }
  }
}
