import type { Logger } from "../../utils/logger.js";
import type { ScoutSettings } from "../../domain/schemas.js";
import { GitHubSourceAdapter } from "../githubAdapter.js";
import { HttpClient } from "../http.js";
import { GreenhouseAdapter, LeverAdapter, WorkdayAdapter } from "./ats.js";
import { InternListAdapter } from "./internList.js";
import { EarlyCareerRadarAdapter } from "./earlyCareerRadar.js";
import { StaticHTMLAdapter } from "./static.js";
import type { SourceAdapter, SourceAdapterResult } from "./types.js";

/**
 * Known-source router implementing structured endpoint → direct HTTP → static
 * HTML/JSON → browser-required ordering. Browser fallback is represented as a
 * result rather than launched here, keeping transport policy deterministic.
 */
export class SourceAdapterRouter {
  private readonly adapters: SourceAdapter[];
  private readonly genericStatic: StaticHTMLAdapter;

  public constructor(
    settings: ScoutSettings,
    logger: Logger,
    http: HttpClient,
    adapters: SourceAdapter[] = [],
  ) {
    // More-specific adapters must precede generic/static routes.
    this.adapters = [
      new GitHubAdapterBridge(new GitHubSourceAdapter(logger, http)),
      new GreenhouseAdapter(http, logger),
      new LeverAdapter(http, logger),
      new WorkdayAdapter(http, logger),
      new InternListAdapter(http, logger),
      new EarlyCareerRadarAdapter(http, logger),
      ...adapters,
    ];
    this.genericStatic = new StaticHTMLAdapter(http, logger, () => true);
    void settings;
  }

  public route(sourceUrl: string): SourceAdapter | null {
    return this.adapters.find((adapter) => adapter.canHandle(sourceUrl)) ?? (this.genericStatic.canHandle(sourceUrl) ? this.genericStatic : null);
  }

  public async collect(sourceUrl: string): Promise<SourceAdapterResult> {
    const adapter = this.route(sourceUrl);
    if (!adapter) {
      return {
        snapshots: [],
        retrievalMethod: "browser required",
        retrievalUrls: [sourceUrl],
        attempts: 0,
        httpStatus: null,
        notes: ["No safe structured or static HTTP adapter is registered for this source."],
        failures: [],
        strategy: "browser_required",
        browserRequired: true,
      };
    }
    const result = await adapter.collect(sourceUrl);
    // A public structured endpoint can be temporarily unavailable (rate limit,
    // deprecation, or an unexpected response). Preserve the HTTP-first ladder
    // by trying the same source's static representation before asking the
    // browser lane to intervene. GitHub is intentionally excluded: it has its
    // own raw/API-only contract and must never route to Playwright.
    // Intern List's configured page is a robots-disallowed shell whose useful
    // content belongs to the structured Jobright feed. A failed feed must not
    // be replaced by a static/browser attempt against that shell.
    if (result.strategy === "structured_endpoint" && result.failures.length > 0 && result.snapshots.length === 0 && adapter.name !== "GitHub" && adapter.name !== "Intern List") {
      const fallback = await this.genericStatic.collect(sourceUrl);
      return {
        ...fallback,
        retrievalMethod: `${result.retrievalMethod}; static HTTP fallback`,
        notes: [...result.notes, ...fallback.notes],
        // The structured attempt is retained in notes for telemetry, but a
        // successful static fallback must not inherit its transient 4xx/5xx
        // failure as the effective source status. If the fallback itself
        // fails, its failures remain authoritative.
        failures: fallback.failures,
        attempts: result.attempts + fallback.attempts,
      };
    }
    return result;
  }
}

export { SourceAdapterRouter as AdapterRouter };

/** Preserve the existing GitHub result shape while exposing SourceAdapter. */
class GitHubAdapterBridge implements SourceAdapter {
  public readonly name = "GitHub";
  public readonly strategy = "structured_endpoint" as const;
  public constructor(private readonly adapter: GitHubSourceAdapter) {}
  public canHandle(sourceUrl: string): boolean { return this.adapter.canHandle(sourceUrl); }
  public async collect(sourceUrl: string): Promise<SourceAdapterResult> {
    const result = await this.adapter.collect(sourceUrl);
    return { ...result, failures: result.failures ?? [], strategy: "structured_endpoint" };
  }
}
