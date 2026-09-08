/* global fetch, URLSearchParams */

/*
 * The browser client talks to a small set of dashboard endpoints.  Keeping
 * transport details here makes feature controllers independent of fetch and
 * preserves one place for response and error handling.
 */

function resolveFetch(fetchImpl) {
  if (typeof fetchImpl === "function") return fetchImpl;
  if (typeof fetch === "function") return fetch;
  throw new Error("Fetch is unavailable");
}

export async function readJsonResponse(response) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    payload = {};
  }
  if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status})`);
  return payload;
}

function withBaseUrl(baseUrl, path) {
  if (!baseUrl) return path;
  return `${String(baseUrl).replace(/\/$/u, "")}/${String(path).replace(/^\//u, "")}`;
}

export function createDashboardApi({ fetchImpl, baseUrl = "" } = {}) {
  const request = (path, init = {}) => resolveFetch(fetchImpl)(withBaseUrl(baseUrl, path), init);

  return {
    async getRolesPage(path, { signal } = {}) {
      const response = await request(path, { cache: "no-store", signal });
      return readJsonResponse(response);
    },

    async getRoleDetails(listingType, listingId, { signal } = {}) {
      const path = `/api/roles/${encodeURIComponent(listingType || "internship")}/${encodeURIComponent(listingId)}`;
      const response = await request(path, {
        cache: "no-store",
        signal,
        headers: { Accept: "application/json" },
      });
      return { payload: await readJsonResponse(response), response };
    },

    async getChanges({ etag = null, force = false } = {}) {
      const headers = { Accept: "application/json" };
      if (!force && etag) headers["If-None-Match"] = etag;
      const response = await request("/api/changes", { cache: "no-store", headers });
      if (response.status === 304) return { notModified: true, payload: null, response, etag: response.headers.get("ETag") };
      return { notModified: false, payload: await readJsonResponse(response), response, etag: response.headers.get("ETag") };
    },

    async getApplications() {
      const response = await request("/api/applications", { cache: "no-store", headers: { Accept: "application/json" } });
      return readJsonResponse(response);
    },

    async setApplicationStage(body) {
      const response = await request("/api/applications/status", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return readJsonResponse(response);
    },

    async saveAction(body, { signal } = {}) {
      const response = await request("/api/actions", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      return readJsonResponse(response);
    },

    async undoAction(listingType, listingId) {
      const query = new URLSearchParams({ listingType, listingId });
      const response = await request(`/api/actions?${query.toString()}`, {
        method: "DELETE",
        headers: { Accept: "application/json" },
      });
      return readJsonResponse(response);
    },

    async refresh() {
      const response = await request("/api/refresh", { method: "POST", cache: "no-store", headers: { Accept: "application/json" } });
      return readJsonResponse(response);
    },

    async terminate() {
      const response = await request("/api/terminate", { method: "POST", cache: "no-store", headers: { Accept: "application/json" } });
      return readJsonResponse(response);
    },

    async addSource(url) {
      const response = await request("/api/sources", {
        method: "POST",
        cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      return readJsonResponse(response);
    },
  };
}
