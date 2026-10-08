export const INTERN_LIST_SOURCE_URL = "https://www.intern-list.com/";

export function isInternListSource(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    return url.hostname.replace(/^www\./u, "") === "intern-list.com" && url.pathname === "/"
      || url.hostname === "jobright.ai" && /^\/minisites-jobs\/intern\/(us|ca)\/[a-z_]+\/?$/u.test(url.pathname);
  } catch { return false; }
}

/** Old category query aliases now share one complete tab discovery crawl. */
export function internListSourceUrl(value: string): string {
  return isInternListSource(value) ? INTERN_LIST_SOURCE_URL : value;
}
