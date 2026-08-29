import { performance as nodePerformance } from "node:perf_hooks";

/**
 * Operations used by the crawler's profiling hooks.  The profiler accepts
 * arbitrary operation names as well, but these names keep reports consistent
 * across adapters and workers.
 */
export const PROFILE_OPERATIONS = [
  "queue_wait",
  "http_connect",
  "http_fetch",
  "browser_navigation",
  "browser_render",
  "parsing",
  "dedupe",
  "relevance",
  "qualification",
  "database",
  "total",
] as const;

export type ProfileOperation = (typeof PROFILE_OPERATIONS)[number] | (string & {});

export const PROFILE_COUNTERS = [
  "urlsDiscovered",
  "urlsFetched",
  "httpRequests",
  "browserNavigations",
  "cacheHits",
  "unchangedSkips",
  "duplicates",
  "irrelevant",
  "detailPages",
  "successfulJobs",
  "failedSources",
  "retries",
] as const;

export type ProfileCounter = (typeof PROFILE_COUNTERS)[number] | (string & {});

export type SpanStatus = "ok" | "error" | "cancelled";

export interface SpanMetadata {
  url?: string;
  source?: string;
  domain?: string;
  queueWaitMs?: number;
  status?: SpanStatus;
  /** Additional fields are retained only on sampled span records. */
  [key: string]: unknown;
}

export interface SpanRecord {
  id: string;
  operation: string;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  status: SpanStatus;
  url?: string;
  source?: string;
  domain?: string;
  queueWaitMs?: number;
  metadata?: Readonly<Record<string, unknown>>;
}

/**
 * A latency aggregate keeps enough information for deterministic percentiles
 * while putting a hard cap on retained samples.  `count` and `totalMs` are
 * always complete even when the sample reservoir is full.
 */
export interface LatencyAggregate {
  count: number;
  totalMs: number;
  sumMs: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  averageMs: number;
  p50Ms: number | null;
  p95Ms: number | null;
  samplesRetained: number;
  sampled: boolean;
  samples?: number[];
}

export interface ProfilerOptions {
  /** Maximum completed span records retained in memory. */
  maxSpans?: number;
  /** Maximum latency samples retained per operation/domain/source aggregate. */
  maxSamplesPerAggregate?: number;
  /** Maximum distinct operation keys retained. */
  maxOperations?: number;
  /** Maximum distinct domains/sources retained. */
  maxDomains?: number;
  maxSources?: number;
  /** Deterministic sample rate for span records and aggregate samples. */
  sampleRate?: number;
  /** Monotonic clock, injectable for deterministic tests. */
  now?: () => number;
}

export interface ProfilerSnapshot {
  startedAtMs: number;
  finishedAtMs: number;
  durationMs: number;
  totalRuntimeMs: number;
  counters: Record<string, number>;
  operations: Record<string, LatencyAggregate>;
  /** Alias retained for callers that prefer the longer name. */
  perOperation: Record<string, LatencyAggregate>;
  domains: Record<string, LatencyAggregate>;
  /** Alias retained for callers that prefer the longer name. */
  perDomain: Record<string, LatencyAggregate>;
  domainOperations?: Record<string, Record<string, LatencyAggregate>>;
  sources: Record<string, LatencyAggregate>;
  perSource: Record<string, LatencyAggregate>;
  sourceOperations?: Record<string, Record<string, LatencyAggregate>>;
  spans: SpanRecord[];
  /** URL-indexed view of the bounded span buffer. */
  spansByUrl: Record<string, SpanRecord[]>;
  /** Alias for integrations that call URL spans simply `urlSpans`. */
  urlSpans: Record<string, SpanRecord[]>;
  droppedSpans: number;
  droppedDomains: number;
  droppedSources: number;
  droppedOperations: number;
}

export interface SpanHandle {
  readonly id: string;
  readonly operation: string;
  readonly startedAtMs: number;
  end(result?: SpanEndOptions): SpanRecord | undefined;
  /** `finish` and `stop` are convenient aliases for integration hooks. */
  finish(result?: SpanEndOptions): SpanRecord | undefined;
  stop(result?: SpanEndOptions): SpanRecord | undefined;
}

export interface SpanEndOptions {
  endedAtMs?: number;
  durationMs?: number;
  status?: SpanStatus;
  error?: unknown;
  metadata?: SpanMetadata;
}

export type ProfileWork<T> = () => T | PromiseLike<T>;

const DEFAULT_MAX_SPANS = 2_000;
const DEFAULT_MAX_SAMPLES = 2_048;
const DEFAULT_MAX_OPERATIONS = 128;
const DEFAULT_MAX_DOMAINS = 512;
const DEFAULT_MAX_SOURCES = 256;
const OTHER_OPERATION = "__other__";
const OTHER_DOMAIN = "__other__";
const OTHER_SOURCE = "__other__";

function finiteNonNegative(value: number, fallback = 0): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function clampRate(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}

/** Normalize common spelling variants without changing custom operation names. */
export function normalizeOperation(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z0-9_]/g, "");
  const aliases: Record<string, string> = {
    queue: "queue_wait",
    queuewait: "queue_wait",
    wait: "queue_wait",
    connect: "http_connect",
    http: "http_fetch",
    fetch: "http_fetch",
    navigation: "browser_navigation",
    browser_nav: "browser_navigation",
    render: "browser_render",
    wait_render: "browser_render",
    parse: "parsing",
    parsing_html: "parsing",
    deduplication: "dedupe",
    relevance_filter: "relevance",
    qualification_extraction: "qualification",
    db: "database",
    database_write: "database",
    crawl: "total",
    total_processing: "total",
  };
  return (aliases[normalized] ?? normalized) || "unknown";
}

function domainFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function emptyAggregate(): LatencyAggregate {
  return {
    count: 0,
    totalMs: 0,
    sumMs: 0,
    minMs: Number.POSITIVE_INFINITY,
    maxMs: 0,
    meanMs: 0,
    averageMs: 0,
    p50Ms: null,
    p95Ms: null,
    samplesRetained: 0,
    sampled: false,
    samples: [],
  };
}

/** Nearest-rank percentile (p in [0, 1]) over a sorted copy. */
export function percentile(values: readonly number[], p: number): number | null {
  const finiteValues = values.filter((value) => Number.isFinite(value));
  if (finiteValues.length === 0) return null;
  const sorted = finiteValues.sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(Math.max(0, Math.min(1, p)) * sorted.length));
  return sorted[rank - 1] ?? null;
}

function finalizeAggregate(aggregate: LatencyAggregate): LatencyAggregate {
  const samples = aggregate.samples ?? [];
  const result: LatencyAggregate = {
    ...aggregate,
    minMs: aggregate.count > 0 ? aggregate.minMs : 0,
    meanMs: aggregate.count > 0 ? aggregate.totalMs / aggregate.count : 0,
    averageMs: aggregate.count > 0 ? aggregate.totalMs / aggregate.count : 0,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    samplesRetained: samples.length,
    sampled: aggregate.sampled || samples.length < aggregate.count,
    samples: [...samples],
  };
  return result;
}

function addSample(aggregate: LatencyAggregate, value: number, cap: number, retain = true): void {
  aggregate.count += 1;
  aggregate.totalMs += value;
  aggregate.sumMs += value;
  aggregate.minMs = Math.min(aggregate.minMs, value);
  aggregate.maxMs = Math.max(aggregate.maxMs, value);
  if (!retain) {
    aggregate.sampled = true;
    return;
  }
  const samples = aggregate.samples ?? (aggregate.samples = []);
  if (cap <= 0) {
    aggregate.sampled = true;
    return;
  }
  if (samples.length < cap) {
    samples.push(value);
    return;
  }
  // A deterministic ring reservoir retains recent observations while keeping
  // memory bounded. Percentiles are explicitly marked as sampled afterwards.
  samples[(aggregate.count - 1) % cap] = value;
  aggregate.sampled = true;
}

function retainAggregateSample(aggregate: LatencyAggregate, value: number, cap: number, cursor: number): number {
  const samples = aggregate.samples ?? (aggregate.samples = []);
  if (cap <= 0) {
    aggregate.sampled = true;
    return cursor + 1;
  }
  if (samples.length < cap) {
    samples.push(value);
    return cursor + 1;
  }
  samples[cursor % cap] = value;
  aggregate.sampled = true;
  return cursor + 1;
}

function mergeAggregate(target: LatencyAggregate, incoming: LatencyAggregate, cap: number): void {
  if (incoming.count <= 0) return;
  const mergedCount = target.count + incoming.count;
  target.totalMs += incoming.totalMs;
  target.sumMs += incoming.sumMs;
  target.minMs = Math.min(target.minMs, incoming.minMs);
  target.maxMs = Math.max(target.maxMs, incoming.maxMs);
  const samples = incoming.samples ?? [];
  let cursor = target.samples?.length ?? 0;
  for (const value of samples) cursor = retainAggregateSample(target, value, cap, cursor);
  target.count = mergedCount;
  target.sampled = target.sampled || incoming.sampled || samples.length < incoming.count;
}

function snapshotAggregate(value: LatencyAggregate): LatencyAggregate {
  return finalizeAggregate(value);
}

function copyMetadata(metadata: SpanMetadata | undefined): Readonly<Record<string, unknown>> | undefined {
  if (!metadata) return undefined;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "url" || key === "source" || key === "domain" || key === "queueWaitMs" || key === "status") continue;
    copy[key] = value;
  }
  return Object.keys(copy).length > 0 ? Object.freeze(copy) : undefined;
}

function normalizeMetadata(value: SpanMetadata | string | undefined): SpanMetadata {
  if (typeof value === "string") return { url: value };
  return value ? { ...value } : {};
}

function combinedStatus(base: SpanMetadata, extra: SpanMetadata | undefined): SpanStatus | undefined {
  const candidate = extra?.status ?? base.status;
  return candidate === "ok" || candidate === "error" || candidate === "cancelled" ? candidate : undefined;
}

function cloneSpan(span: SpanRecord): SpanRecord {
  return {
    ...span,
    ...(span.metadata ? { metadata: { ...span.metadata } } : {}),
  };
}

/**
 * Low-overhead, synchronous metrics collector. JavaScript's event loop makes
 * each update atomic; no locks or synchronous file writes occur on hot paths.
 */
export class Profiler {
  private readonly now: () => number;
  private readonly maxSpans: number;
  private readonly maxSamplesPerAggregate: number;
  private readonly maxOperations: number;
  private readonly maxDomains: number;
  private readonly maxSources: number;
  private readonly sampleRate: number;
  private readonly counters: Record<string, number> = Object.create(null) as Record<string, number>;
  private readonly operations = new Map<string, LatencyAggregate>();
  private readonly domains = new Map<string, LatencyAggregate>();
  private readonly domainOperations = new Map<string, Map<string, LatencyAggregate>>();
  private readonly sources = new Map<string, LatencyAggregate>();
  private readonly sourceOperations = new Map<string, Map<string, LatencyAggregate>>();
  private readonly spans: SpanRecord[] = [];
  private sequence = 0;
  private nextSpanId = 0;
  private startedAtMs: number;
  private finishedAtMs: number;
  private droppedSpans = 0;
  private droppedDomains = 0;
  private droppedSources = 0;
  private droppedOperations = 0;

  public constructor(options: ProfilerOptions = {}) {
    this.now = options.now ?? (() => nodePerformance.now());
    this.maxSpans = positiveInteger(options.maxSpans, DEFAULT_MAX_SPANS);
    this.maxSamplesPerAggregate = positiveInteger(options.maxSamplesPerAggregate, DEFAULT_MAX_SAMPLES);
    this.maxOperations = positiveInteger(options.maxOperations, DEFAULT_MAX_OPERATIONS);
    this.maxDomains = positiveInteger(options.maxDomains, DEFAULT_MAX_DOMAINS);
    this.maxSources = positiveInteger(options.maxSources, DEFAULT_MAX_SOURCES);
    this.sampleRate = clampRate(options.sampleRate);
    this.startedAtMs = finiteNonNegative(this.now());
    this.finishedAtMs = this.startedAtMs;
    for (const counter of PROFILE_COUNTERS) this.counters[counter] = 0;
  }

  /** Start a fresh measurement interval while preserving no prior samples. */
  public reset(): void {
    for (const key of Object.keys(this.counters)) delete this.counters[key];
    for (const counter of PROFILE_COUNTERS) this.counters[counter] = 0;
    this.operations.clear();
    this.domains.clear();
    this.domainOperations.clear();
    this.sources.clear();
    this.sourceOperations.clear();
    this.spans.length = 0;
    this.sequence = 0;
    this.nextSpanId = 0;
    this.droppedSpans = 0;
    this.droppedDomains = 0;
    this.droppedSources = 0;
    this.droppedOperations = 0;
    this.startedAtMs = finiteNonNegative(this.now());
    this.finishedAtMs = this.startedAtMs;
  }

  public increment(counter: ProfileCounter, amount = 1): number {
    const key = String(counter);
    const value = finiteNonNegative(amount, 0);
    this.counters[key] = (this.counters[key] ?? 0) + value;
    return this.counters[key];
  }

  public addCounter(counter: ProfileCounter, amount = 1): number {
    return this.increment(counter, amount);
  }

  public recordCounter(counter: ProfileCounter, amount = 1): number {
    return this.increment(counter, amount);
  }

  public getCounter(counter: ProfileCounter): number {
    return this.counters[String(counter)] ?? 0;
  }

  private boundedAggregate(map: Map<string, LatencyAggregate>, key: string, maxKeys: number, overflowKey: string, dropped: "domain" | "source" | "operation"): LatencyAggregate | undefined {
    const existing = map.get(key);
    if (existing) return existing;
    if (maxKeys <= 0) return undefined;
    if (map.size >= maxKeys) {
      let overflow = map.get(overflowKey);
      if (!overflow) {
        // Reserve one bounded bucket for overflow rather than allowing the
        // sentinel itself to exceed the configured key cap.
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
        overflow = emptyAggregate();
        map.set(overflowKey, overflow);
      }
      if (dropped === "domain") this.droppedDomains += 1;
      else if (dropped === "source") this.droppedSources += 1;
      else this.droppedOperations += 1;
      return overflow;
    }
    const aggregate = emptyAggregate();
    map.set(key, aggregate);
    return aggregate;
  }

  private aggregateOperation(operation: string): LatencyAggregate | undefined {
    return this.boundedAggregate(this.operations, operation, this.maxOperations, OTHER_OPERATION, "operation");
  }

  private aggregateDomain(domain: string): LatencyAggregate | undefined {
    return this.boundedAggregate(this.domains, domain, this.maxDomains, OTHER_DOMAIN, "domain");
  }

  private aggregateSource(source: string): LatencyAggregate | undefined {
    return this.boundedAggregate(this.sources, source, this.maxSources, OTHER_SOURCE, "source");
  }

  private aggregateNested(parent: Map<string, Map<string, LatencyAggregate>>, parentKey: string, operation: string, maxParents: number): LatencyAggregate | undefined {
    let operations = parent.get(parentKey);
    if (!operations) {
      if (parent.size >= maxParents) return undefined;
      operations = new Map<string, LatencyAggregate>();
      parent.set(parentKey, operations);
    }
    const existing = operations.get(operation);
    if (existing) return existing;
    if (operations.size >= this.maxOperations) return operations.get(OTHER_OPERATION) ?? (() => {
      const aggregate = emptyAggregate();
      operations?.set(OTHER_OPERATION, aggregate);
      return aggregate;
    })();
    const aggregate = emptyAggregate();
    operations.set(operation, aggregate);
    return aggregate;
  }

  private shouldSample(sequence: number): boolean {
    if (this.sampleRate >= 1) return true;
    if (this.sampleRate <= 0) return false;
    // Integer hash keeps sampling deterministic without Math.random().
    const hash = (Math.imul(sequence + 1, 2_654_435_761) >>> 0) / 4_294_967_296;
    return hash < this.sampleRate;
  }

  private retainSpan(span: SpanRecord): void {
    if (this.maxSpans <= 0 || !this.shouldSample(this.sequence)) {
      this.droppedSpans += 1;
      return;
    }
    if (this.spans.length < this.maxSpans) {
      this.spans.push(span);
      return;
    }
    this.spans[this.sequence % this.maxSpans] = span;
    this.droppedSpans += 1;
  }

  private recordCompletedSpan(span: SpanRecord): SpanRecord {
    this.sequence += 1;
    const duration = finiteNonNegative(span.durationMs);
    const operation = normalizeOperation(span.operation);
    const retainAggregateSample = this.shouldSample(this.sequence);
    const operationAggregate = this.aggregateOperation(operation);
    if (operationAggregate) addSample(operationAggregate, duration, this.maxSamplesPerAggregate, retainAggregateSample);
    const domain = span.domain ?? domainFromUrl(span.url);
    if (domain) {
      const domainAggregate = this.aggregateDomain(domain);
      if (domainAggregate) addSample(domainAggregate, duration, this.maxSamplesPerAggregate, retainAggregateSample);
      const nested = this.aggregateNested(this.domainOperations, domain, operation, this.maxDomains);
      if (nested) addSample(nested, duration, this.maxSamplesPerAggregate, retainAggregateSample);
    }
    if (span.source) {
      const source = span.source;
      const sourceAggregate = this.aggregateSource(source);
      if (sourceAggregate) addSample(sourceAggregate, duration, this.maxSamplesPerAggregate, retainAggregateSample);
      const nested = this.aggregateNested(this.sourceOperations, source, operation, this.maxSources);
      if (nested) addSample(nested, duration, this.maxSamplesPerAggregate, retainAggregateSample);
    }
    this.retainSpan({
      ...span,
      operation,
      durationMs: duration,
      ...(domain ? { domain } : {}),
    });
    this.finishedAtMs = Math.max(this.finishedAtMs, span.endedAtMs);
    return span;
  }

  public recordSpan(operationValue: string, durationMs: number, metadata: SpanMetadata = {}, status: SpanStatus = "ok"): SpanRecord {
    const operation = normalizeOperation(operationValue);
    const endedAtMs = finiteNonNegative(this.now());
    const duration = finiteNonNegative(durationMs);
    const startedAtMs = Math.max(0, endedAtMs - duration);
    const normalized = normalizeMetadata(metadata);
    const url = typeof normalized.url === "string" ? normalized.url : undefined;
    const source = typeof normalized.source === "string" ? normalized.source : undefined;
    const domain = typeof normalized.domain === "string" ? normalized.domain.toLowerCase() : domainFromUrl(url);
    const queueWaitMs = typeof normalized.queueWaitMs === "number" && Number.isFinite(normalized.queueWaitMs)
      ? finiteNonNegative(normalized.queueWaitMs)
      : undefined;
    const retainedMetadata = copyMetadata(normalized);
    const spanStatus = status === "ok" && (normalized.status === "error" || normalized.status === "cancelled") ? normalized.status : status;
    const span: SpanRecord = {
      id: `span-${++this.nextSpanId}`,
      operation,
      startedAtMs,
      endedAtMs,
      durationMs: duration,
      status: spanStatus,
      ...(url ? { url } : {}),
      ...(source ? { source } : {}),
      ...(domain ? { domain } : {}),
      ...(queueWaitMs !== undefined ? { queueWaitMs } : {}),
      ...(retainedMetadata ? { metadata: retainedMetadata } : {}),
    };
    return this.recordCompletedSpan(span);
  }

  /** Alias used by adapters that call measurements observations. */
  public observe(operation: string, durationMs: number, metadata: SpanMetadata = {}, status: SpanStatus = "ok"): SpanRecord {
    return this.recordSpan(operation, durationMs, metadata, status);
  }

  public record(operation: string, durationMs: number, metadata: SpanMetadata = {}, status: SpanStatus = "ok"): SpanRecord {
    return this.recordSpan(operation, durationMs, metadata, status);
  }

  public startSpan(operationValue: string, metadataValue: SpanMetadata | string = {}): SpanHandle {
    const operation = normalizeOperation(operationValue);
    const metadata = normalizeMetadata(metadataValue);
    const startedAtMs = finiteNonNegative(this.now());
    const id = `span-${++this.nextSpanId}`;
    let ended = false;
    const end = (result: SpanEndOptions = {}): SpanRecord | undefined => {
      if (ended) return undefined;
      ended = true;
      const endedAtMs = result.endedAtMs === undefined ? finiteNonNegative(this.now()) : finiteNonNegative(result.endedAtMs);
      const duration = result.durationMs === undefined
        ? Math.max(0, endedAtMs - startedAtMs)
        : finiteNonNegative(result.durationMs);
      const status = result.status ?? combinedStatus(metadata, result.metadata) ?? (result.error ? "error" : "ok");
      const combined: SpanMetadata = { ...metadata, ...(result.metadata ?? {}) };
      const url = typeof combined.url === "string" ? combined.url : undefined;
      const source = typeof combined.source === "string" ? combined.source : undefined;
      const domain = typeof combined.domain === "string" ? combined.domain.toLowerCase() : domainFromUrl(url);
      const queueWaitMs = typeof combined.queueWaitMs === "number" && Number.isFinite(combined.queueWaitMs)
        ? finiteNonNegative(combined.queueWaitMs)
        : undefined;
      const retainedMetadata = copyMetadata(combined);
      const span: SpanRecord = {
        id,
        operation,
        startedAtMs,
        endedAtMs,
        durationMs: duration,
        status,
        ...(url ? { url } : {}),
        ...(source ? { source } : {}),
        ...(domain ? { domain } : {}),
        ...(queueWaitMs !== undefined ? { queueWaitMs } : {}),
        ...(retainedMetadata ? { metadata: retainedMetadata } : {}),
      };
      return this.recordCompletedSpan(span);
    };
    const handle: SpanHandle = {
      id,
      operation,
      startedAtMs,
      end,
      finish: end,
      stop: end,
    };
    return handle;
  }

  public start(operation: string, metadata: SpanMetadata | string = {}): SpanHandle {
    return this.startSpan(operation, metadata);
  }

  public async measure<T>(operation: string, metadata: SpanMetadata, work: ProfileWork<T>): Promise<T>;
  public async measure<T>(operation: string, work: ProfileWork<T>, metadata?: SpanMetadata): Promise<T>;
  public async measure<T>(operation: string, metadataOrWork: SpanMetadata | ProfileWork<T>, maybeWorkOrMetadata?: ProfileWork<T> | SpanMetadata): Promise<T> {
    const metadata = typeof metadataOrWork === "function" ? (maybeWorkOrMetadata as SpanMetadata | undefined) ?? {} : metadataOrWork;
    const work = typeof metadataOrWork === "function" ? metadataOrWork : maybeWorkOrMetadata as ProfileWork<T>;
    if (typeof work !== "function") throw new TypeError("Profiler.measure requires a work function.");
    const span = this.startSpan(operation, metadata);
    try {
      const value = await work();
      span.end();
      return value;
    } catch (error) {
      span.end({ status: "error", error });
      throw error;
    }
  }

  public async time<T>(operation: string, work: ProfileWork<T>, metadata: SpanMetadata = {}): Promise<T> {
    return this.measure(operation, metadata, work);
  }

  private aggregateSnapshot(map: Map<string, LatencyAggregate>): Record<string, LatencyAggregate> {
    return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => [key, snapshotAggregate(value)]));
  }

  private nestedSnapshot(map: Map<string, Map<string, LatencyAggregate>>): Record<string, Record<string, LatencyAggregate>> {
    return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, operations]) => [
      key,
      Object.fromEntries([...operations.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([operation, value]) => [operation, snapshotAggregate(value)])),
    ]));
  }

  public snapshot(nowMs?: number): ProfilerSnapshot {
    const finishedAtMs = nowMs === undefined ? Math.max(this.finishedAtMs, finiteNonNegative(this.now())) : finiteNonNegative(nowMs);
    const operations = this.aggregateSnapshot(this.operations);
    const domains = this.aggregateSnapshot(this.domains);
    const domainOperations = this.nestedSnapshot(this.domainOperations);
    const sources = this.aggregateSnapshot(this.sources);
    const sourceOperations = this.nestedSnapshot(this.sourceOperations);
    const spans = this.spans.map(cloneSpan);
    const spansByUrl: Record<string, SpanRecord[]> = {};
    for (const span of spans) {
      if (!span.url) continue;
      const bucket = spansByUrl[span.url] ?? (spansByUrl[span.url] = []);
      bucket.push(span);
    }
    const counters: Record<string, number> = { ...this.counters };
    for (const counter of PROFILE_COUNTERS) counters[counter] ??= 0;
    const durationMs = Math.max(0, finishedAtMs - this.startedAtMs);
    return {
      startedAtMs: this.startedAtMs,
      finishedAtMs,
      durationMs,
      totalRuntimeMs: durationMs,
      counters,
      operations,
      perOperation: operations,
      domains,
      perDomain: domains,
      domainOperations,
      sources,
      perSource: sources,
      sourceOperations,
      spans,
      spansByUrl,
      urlSpans: spansByUrl,
      droppedSpans: this.droppedSpans,
      droppedDomains: this.droppedDomains,
      droppedSources: this.droppedSources,
      droppedOperations: this.droppedOperations,
    };
  }

  public finish(nowMs?: number): ProfilerSnapshot {
    return this.snapshot(nowMs);
  }

  /** Merge a worker snapshot into this collector without retaining unbounded data. */
  public merge(snapshot: ProfilerSnapshot | Partial<ProfilerSnapshot>): ProfilerSnapshot {
    for (const [counter, value] of Object.entries(snapshot.counters ?? {})) this.increment(counter, finiteNonNegative(value));
    this.mergeMap(this.operations, snapshot.operations ?? {}, this.maxOperations, OTHER_OPERATION, "operation");
    this.mergeMap(this.domains, snapshot.domains ?? {}, this.maxDomains, OTHER_DOMAIN, "domain");
    this.mergeMap(this.sources, snapshot.sources ?? {}, this.maxSources, OTHER_SOURCE, "source");
    this.mergeNestedMap(this.domainOperations, snapshot.domainOperations ?? {}, this.maxDomains);
    this.mergeNestedMap(this.sourceOperations, snapshot.sourceOperations ?? {}, this.maxSources);
    for (const span of snapshot.spans ?? []) {
      const copied: SpanRecord = { ...cloneSpan(span), id: `span-${++this.nextSpanId}` };
      this.sequence += 1;
      this.retainSpan(copied);
    }
    this.droppedSpans += finiteNonNegative(snapshot.droppedSpans ?? 0);
    this.droppedDomains += finiteNonNegative(snapshot.droppedDomains ?? 0);
    this.droppedSources += finiteNonNegative(snapshot.droppedSources ?? 0);
    this.droppedOperations += finiteNonNegative(snapshot.droppedOperations ?? 0);
    this.startedAtMs = Math.min(this.startedAtMs, finiteNonNegative(snapshot.startedAtMs ?? this.startedAtMs));
    this.finishedAtMs = Math.max(this.finishedAtMs, finiteNonNegative(snapshot.finishedAtMs ?? this.finishedAtMs));
    return this.snapshot();
  }

  private mergeMap(target: Map<string, LatencyAggregate>, incoming: Record<string, LatencyAggregate>, maxKeys: number, overflowKey: string, dropped: "domain" | "source" | "operation"): void {
    for (const [key, value] of Object.entries(incoming)) {
      const aggregate = this.boundedAggregate(target, key, maxKeys, overflowKey, dropped);
      if (aggregate) mergeAggregate(aggregate, value, this.maxSamplesPerAggregate);
    }
  }

  private mergeNestedMap(target: Map<string, Map<string, LatencyAggregate>>, incoming: Record<string, Record<string, LatencyAggregate>>, maxParents: number): void {
    for (const [parentKey, operations] of Object.entries(incoming)) {
      let destination = target.get(parentKey);
      if (!destination) {
        if (target.size >= maxParents || maxParents <= 0) continue;
        destination = new Map<string, LatencyAggregate>();
        target.set(parentKey, destination);
      }
      for (const [operation, aggregate] of Object.entries(operations)) {
        const existing = destination.get(operation);
        if (existing) mergeAggregate(existing, aggregate, this.maxSamplesPerAggregate);
        else if (destination.size < this.maxOperations && this.maxOperations > 0) {
          const copy = emptyAggregate();
          mergeAggregate(copy, aggregate, this.maxSamplesPerAggregate);
          destination.set(operation, copy);
        }
      }
    }
  }

  public static merge(snapshots: readonly (ProfilerSnapshot | Partial<ProfilerSnapshot>)[], options: ProfilerOptions = {}): ProfilerSnapshot {
    const profiler = new Profiler(options);
    for (const snapshot of snapshots) profiler.merge(snapshot);
    return profiler.snapshot();
  }
}

export const PerformanceProfiler = Profiler;
export const MetricsCollector = Profiler;

export function createProfiler(options: ProfilerOptions = {}): Profiler {
  return new Profiler(options);
}

export function mergeProfilerSnapshots(snapshots: readonly (ProfilerSnapshot | Partial<ProfilerSnapshot>)[], options: ProfilerOptions = {}): ProfilerSnapshot {
  return Profiler.merge(snapshots, options);
}
