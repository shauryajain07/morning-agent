import { describe, expect, it } from "vitest";

import {
  parseGitHubEventItems,
  parseGitHubIssueItems,
  parseGitHubNotificationItems,
} from "../src/collectors/github.js";

const now = new Date("2026-09-19T08:00:00.000Z");

describe("GitHub read-only normalization", () => {
  it("normalizes recent issues and pull requests", () => {
    const items = parseGitHubIssueItems([
      {
        number: 12,
        title: "Fix onboarding",
        body: "Please review this change.",
        html_url: "https://github.com/acme/app/issues/12",
        created_at: "2026-09-19T07:00:00.000Z",
        updated_at: "2026-09-19T07:30:00.000Z",
        state: "open",
        user: { login: "octocat" },
      },
    ], "acme/app", { now });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "github:acme/app:12",
      title: "Issue #12 · Fix onboarding",
      metadata: { kind: "issue", repository: "acme/app", author: "octocat" },
    });
  });

  it("normalizes notifications and public events while applying the lookback", () => {
    const notifications = parseGitHubNotificationItems([
      {
        id: "n-1",
        updated_at: "2026-09-19T07:00:00.000Z",
        reason: "mention",
        subject: {
          title: "Review requested",
          url: "https://api.github.com/repos/acme/app/pulls/9",
        },
        repository: { full_name: "acme/app" },
      },
    ], { now });
    const events = parseGitHubEventItems([
      {
        id: "e-1",
        type: "PushEvent",
        created_at: "2026-09-19T06:00:00.000Z",
        repo: { name: "acme/app" },
        payload: { ref: "refs/heads/main" },
      },
    ], { now });

    expect(notifications[0]).toMatchObject({
      id: "github:notification:n-1",
      url: "https://github.com/acme/app/pulls/9",
      metadata: { kind: "notification", reason: "mention" },
    });
    expect(events[0]).toMatchObject({
      id: "github:event:e-1",
      metadata: { kind: "event", eventType: "PushEvent", repository: "acme/app" },
    });
  });
});
