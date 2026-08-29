/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

import { describe, expect, it } from "vitest";

// @ts-expect-error The browser client is JavaScript and has no emitted declaration file.
import { buildNotifications } from "../public/app.js";

describe("client deadline notifications", () => {
  it("turns server closing-soon records into durable notification items", () => {
    const notifications = buildNotifications({
      runs: [],
      deadlineNotifications: [{
        id: "deadline-internship-soon-1787594400000",
        listingType: "internship",
        listingId: "soon",
        company: "Northstar Labs",
        roleTitle: "Software Engineering Intern",
        postingUrl: "https://boards.greenhouse.io/northstar/jobs/100",
        deadline: "2026-08-24T18:00:00.000Z",
        deadlineAt: "2026-08-24T18:00:00.000Z",
        alertAt: "2026-08-23T18:00:00.000Z",
      }],
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      id: "deadline-internship-soon-1787594400000",
      kind: "deadline-soon",
      title: "Closing soon",
      listingKey: "internship:soon",
      postingUrl: "https://boards.greenhouse.io/northstar/jobs/100",
    });
    expect(notifications[0].message).toContain("Software Engineering Intern at Northstar Labs");
  });
});
