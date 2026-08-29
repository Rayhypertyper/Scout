import { classifyPageContent } from "./pageContent.js";

export type VerificationState = "reachable" | "closed" | "access-controlled" | "failed";

const ACCESS_PATTERNS = [
  /(?:complete|solve) the captcha/i,
  /captcha challenge/i,
  /verify (?:that )?you are human/i,
  /access denied/i,
  /sign in to (?:continue|view)/i,
  /log in to (?:continue|view)/i,
];

export function classifyLinkResponse(statusCode: number, finalUrl: string, body: string): VerificationState {
  const contentStatus = classifyPageContent(body);
  if (contentStatus?.state === "closed") return "closed";
  if ([401, 403, 407, 429].includes(statusCode)) return "access-controlled";
  if (
    ACCESS_PATTERNS.some((pattern) => pattern.test(body))
    || /\/(?:login|signin|signup)(?:[/?#]|$)/i.test(finalUrl)
  ) return "access-controlled";
  if (statusCode === 404 || statusCode === 410 || contentStatus?.state === "not-found") return "closed";
  return statusCode >= 200 && statusCode < 400 ? "reachable" : "failed";
}
