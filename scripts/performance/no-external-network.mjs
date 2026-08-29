/* global URL */

/*
 * Loaded before the production dashboard in the benchmark child process.
 * The dashboard's normal board refresh uses fetch and is intentionally not
 * allowed to leave the local fixture. A synthetic RUNNING row prevents the
 * startup crawler; this guard is the last line of defence if that contract
 * changes while the benchmark is running.
 */
const originalFetch = globalThis.fetch;

function requestUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === "object" && "url" in input) return input.url;
  return String(input);
}

globalThis.fetch = async (input, init) => {
  const rawUrl = requestUrl(input);
  let url;
  try {
    url = new URL(rawUrl, "http://127.0.0.1");
  } catch {
    throw new Error(`[BENCHMARK NETWORK BLOCKED] invalid URL ${rawUrl}`);
  }
  const local = (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1")
    && (url.protocol === "http:" || url.protocol === "https:");
  if (!local) throw new Error(`[BENCHMARK NETWORK BLOCKED] ${url.href}`);
  return originalFetch(input, init);
};
