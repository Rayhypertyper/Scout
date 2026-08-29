import { describe, expect, it } from "vitest";

import { classifyLinkResponse } from "../src/verification/linkStatus.js";

describe("application link verification", () => {
  it("does not treat an inactive reCAPTCHA script on a visible job page as an access block", () => {
    expect(classifyLinkResponse(200, "https://job-boards.greenhouse.io/acme/jobs/123", "<script src='recaptcha.js'></script><h1>Software Intern</h1>"))
      .toBe("reachable");
  });

  it("recognizes actual access gates and signup redirects", () => {
    expect(classifyLinkResponse(403, "https://example.com/job", "Access denied")).toBe("access-controlled");
    expect(classifyLinkResponse(200, "https://example.com/signup?next=/job/1", "Create an account"))
      .toBe("access-controlled");
  });

  it("recognizes explicit closed-posting responses", () => {
    expect(classifyLinkResponse(200, "https://example.com/job/1", "This job is no longer available."))
      .toBe("closed");
    expect(classifyLinkResponse(
      200,
      "https://www.linkedin.com/jobs/view/123456789",
      "No longer accepting applications",
    )).toBe("closed");
    expect(classifyLinkResponse(
      200,
      "https://www.linkedin.com/jobs/view/123456789",
      "Sign in to continue. No longer accepting applications",
    )).toBe("closed");
    expect(classifyLinkResponse(
      200,
      "https://ca.linkedin.com/jobs/view/123456789",
      "Software Engineering Intern — Apply now",
    )).toBe("reachable");
  });

  it("recognizes HTTP 200 not-found pages", () => {
    expect(classifyLinkResponse(
      200,
      "https://example.com/job/1",
      "The page you are looking for doesn't exist.",
    )).toBe("closed");
    expect(classifyLinkResponse(
      200,
      "https://example.com/job/1",
      "Page not found",
    )).toBe("closed");
  });

  it("does not mistake ordinary closing-date language for an error page", () => {
    expect(classifyLinkResponse(
      200,
      "https://example.com/job/1",
      "This job posting will remain open until the position is filled. Applications will be accepted on an ongoing basis until the requisition is closed.",
    )).toBe("reachable");
  });
});
