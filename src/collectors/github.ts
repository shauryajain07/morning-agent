import type { AgentItem } from "../types/index.js";
import { parseAgentItems } from "../types/schema.js";

export type GitHubCollector = {
  collect(): Promise<AgentItem[]>;
};

export const getMockGitHubItems = (): AgentItem[] =>
  parseAgentItems([
    {
      id: "github-rootatom-pr-42-review",
      source: "github",
      title: "RootAtom PR #42 awaiting your review",
      content: "A review was requested from you on the pull request.",
      url: "https://github.com/RootAtom/example/pull/42",
      createdAt: new Date("2026-09-18T00:15:00.000Z"),
      metadata: {
        kind: "review_request",
        repository: "RootAtom/example",
        pullRequestNumber: 42,
        requestedReviewer: "me",
      },
    },
    {
      id: "github-rootatom-issue-17-assigned",
      source: "github",
      title: "RootAtom issue #17 assigned to you",
      content: "Investigate the onboarding regression.",
      url: "https://github.com/RootAtom/example/issues/17",
      createdAt: new Date("2026-09-17T23:50:00.000Z"),
      metadata: {
        kind: "assigned_issue",
        repository: "RootAtom/example",
        issueNumber: 17,
        assignee: "me",
      },
    },
  ]);

export const collectGitHubItems = async (): Promise<AgentItem[]> => [];
