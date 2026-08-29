import { LISTING_ACTIONS_SCHEMA } from "./actions.js";

export const DATABASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS crawl_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT,
  cancel_requested_at TEXT,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
  options_json TEXT NOT NULL,
  sources_requested INTEGER NOT NULL DEFAULT 0,
  sources_settled INTEGER NOT NULL DEFAULT 0,
  sources_completed INTEGER NOT NULL DEFAULT 0,
  pages_visited INTEGER NOT NULL DEFAULT 0,
  potential_postings_inspected INTEGER NOT NULL DEFAULT 0,
  internships_discovered INTEGER NOT NULL DEFAULT 0,
  new_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  unchanged_count INTEGER NOT NULL DEFAULT 0,
  closed_count INTEGER NOT NULL DEFAULT 0,
  cache_hits INTEGER NOT NULL DEFAULT 0,
  unchanged_skips INTEGER NOT NULL DEFAULT 0,
  new_listings INTEGER NOT NULL DEFAULT 0,
  changed_listings INTEGER NOT NULL DEFAULT 0,
  retryable_failures INTEGER NOT NULL DEFAULT 0,
  detail_pages_fetched INTEGER NOT NULL DEFAULT 0,
  duplicate_listings_skipped INTEGER NOT NULL DEFAULT 0,
  irrelevant_listings_skipped INTEGER NOT NULL DEFAULT 0,
  http_requests INTEGER NOT NULL DEFAULT 0,
  browser_navigations INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  is_configured INTEGER NOT NULL DEFAULT 0 CHECK (is_configured IN (0, 1)),
  last_crawled_at TEXT,
  last_run_id INTEGER REFERENCES crawl_runs(id),
  last_status TEXT CHECK (last_status IN ('COMPLETED', 'FAILED'))
);

CREATE TABLE IF NOT EXISTS internships (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  company TEXT NOT NULL,
  normalized_company TEXT NOT NULL,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  location_key TEXT NOT NULL,
  application_url TEXT NOT NULL,
  posting_url TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN ('NEW', 'UPDATED', 'UNCHANGED', 'REMOVED_OR_CLOSED')),
  availability_status TEXT NOT NULL CHECK (availability_status IN ('open', 'closed', 'unknown')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  last_seen_run_id INTEGER NOT NULL REFERENCES crawl_runs(id),
  status_run_id INTEGER NOT NULL REFERENCES crawl_runs(id),
  miss_count INTEGER NOT NULL DEFAULT 0,
  canonical_url TEXT,
  canonical_application_url TEXT,
  canonical_posting_url TEXT,
  external_job_id TEXT,
  provider_identity TEXT,
  last_checked_at TEXT,
  etag TEXT,
  last_modified TEXT,
  failure_state TEXT NOT NULL DEFAULT 'none' CHECK (failure_state IN ('none', 'retryable', 'permanent')),
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_failure_at TEXT,
  last_failure_message TEXT
);

CREATE INDEX IF NOT EXISTS internships_application_url_idx ON internships(application_url);
CREATE INDEX IF NOT EXISTS internships_posting_url_idx ON internships(posting_url);
CREATE INDEX IF NOT EXISTS internships_job_identity_idx ON internships(normalized_company, job_id);
CREATE INDEX IF NOT EXISTS internships_fallback_identity_idx ON internships(normalized_company, normalized_title, location_key);

/*
 * Jobright detail resolution is deliberately outside the crawl transaction.
 * The crawler consumes this small durable map; a separate bounded resolver
 * refreshes it by reading the rendered Original Job Post href.
 */
CREATE TABLE IF NOT EXISTS jobright_destinations (
  jobright_url TEXT PRIMARY KEY,
  job_id TEXT,
  destination_url TEXT,
  resolved_at TEXT NOT NULL,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS jobright_destinations_job_id_idx ON jobright_destinations(job_id);

CREATE TABLE IF NOT EXISTS internship_sources (
  internship_id TEXT NOT NULL REFERENCES internships(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_seen_run_id INTEGER NOT NULL REFERENCES crawl_runs(id),
  PRIMARY KEY (internship_id, source_id)
);

CREATE TABLE IF NOT EXISTS run_internships (
  run_id INTEGER NOT NULL REFERENCES crawl_runs(id) ON DELETE CASCADE,
  internship_id TEXT NOT NULL REFERENCES internships(id) ON DELETE CASCADE,
  lifecycle_status TEXT NOT NULL,
  PRIMARY KEY (run_id, internship_id)
);

CREATE TABLE IF NOT EXISTS source_run_results (
  run_id INTEGER NOT NULL REFERENCES crawl_runs(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  settled INTEGER NOT NULL DEFAULT 0 CHECK (settled IN (0, 1)),
  completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
  pages_visited INTEGER NOT NULL DEFAULT 0,
  potential_postings_inspected INTEGER NOT NULL DEFAULT 0,
  jobs_discovered INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  duration_ms INTEGER,
  retrieval_mode TEXT NOT NULL DEFAULT 'configured_url' CHECK (retrieval_mode IN ('configured_url', 'public_alternate')),
  retrieval_urls_json TEXT NOT NULL DEFAULT '[]',
  coverage_notes_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'source_unavailable',
  retrieval_method TEXT,
  attempts INTEGER,
  http_status INTEGER,
  direct_application_links INTEGER,
  PRIMARY KEY (run_id, source_id)
);

-- Durable strategy/cache state is intentionally separate from source_run_results:
-- a strategy survives individual runs and can be updated by retrieval adapters
-- without rewriting the source history.
CREATE TABLE IF NOT EXISTS source_strategies (
  source_id INTEGER PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  adapter TEXT,
  requires_js INTEGER NOT NULL DEFAULT 0 CHECK (requires_js IN (0, 1)),
  last_success_at TEXT,
  last_failure_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  consecutive_failure_count INTEGER NOT NULL DEFAULT 0,
  average_latency_ms REAL,
  latency_samples INTEGER NOT NULL DEFAULT 0,
  last_status TEXT,
  last_http_status INTEGER,
  last_error TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

-- A sighting is the cheap listing-stage observation. It may point at a stored
-- internship, or remain an identity-only row when detail retrieval is skipped.
CREATE TABLE IF NOT EXISTS listing_sightings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES crawl_runs(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  internship_id TEXT REFERENCES internships(id) ON DELETE SET NULL,
  identity_key TEXT NOT NULL,
  canonical_url TEXT,
  external_job_id TEXT,
  provider_identity TEXT,
  content_hash_hint TEXT,
  etag TEXT,
  last_modified TEXT,
  state TEXT NOT NULL CHECK (state IN ('new', 'unchanged', 'possibly_changed', 'closed', 'retryable', 'failed')),
  observed_open INTEGER CHECK (observed_open IN (0, 1)),
  seen_at TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(run_id, source_id, identity_key)
);

CREATE INDEX IF NOT EXISTS listing_sightings_source_identity_idx
  ON listing_sightings(source_id, identity_key, checked_at);
CREATE INDEX IF NOT EXISTS listing_sightings_internship_idx
  ON listing_sightings(internship_id, checked_at);

CREATE TABLE IF NOT EXISTS crawl_run_metrics (
  run_id INTEGER NOT NULL REFERENCES crawl_runs(id) ON DELETE CASCADE,
  metric_key TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT 'count' CHECK (unit IN ('count', 'ms', 'bytes')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, metric_key)
);

CREATE TABLE IF NOT EXISTS failed_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES crawl_runs(id) ON DELETE CASCADE,
  source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  url TEXT NOT NULL,
  error_type TEXT NOT NULL,
  message TEXT NOT NULL,
  status_code INTEGER,
  retry_count INTEGER NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS failed_pages_run_idx ON failed_pages(run_id);

${LISTING_ACTIONS_SCHEMA}
`;
