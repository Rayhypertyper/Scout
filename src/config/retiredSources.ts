/** Retained only to recognize obsolete URLs in stored crawl history. */
export const RETIRED_JOBRIGHT_LIST_URL = "https://swan-api.jobright.ai/swan/mini-sites/list";

export const RETIRED_INTERN_LIST_MESSAGE = "The Jobright mini-sites list endpoint is retired because it is unavailable. Retrieve Intern List through its public HTML, sitemap, and server-rendered tab pages.";

/** Block the dead endpoint, including query/path variants and redirects to it. */
export function isRetiredInternListSource(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./u, "");
    return host === "swan-api.jobright.ai" && url.pathname.startsWith("/swan/mini-sites/list");
  } catch {
    return false;
  }
}
