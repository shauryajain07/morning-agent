import { describe, expect, it } from "vitest";

import { parseEdStemCourses, parseEdStemThreads } from "../src/collectors/edstem.js";

const now = new Date("2026-09-19T08:00:00.000Z");

describe("EdStem read-only normalization", () => {
  it("normalizes enrolled course records", () => {
    expect(parseEdStemCourses({
      courses: [
        { course: { id: 146267, code: "MATH1851", name: "Calculus" } },
        { course: { id: 146267, code: "MATH1851", name: "Duplicate" } },
      ],
    })).toEqual([
      { id: "146267", code: "MATH1851", name: "Calculus" },
    ]);
  });

  it("normalizes recent threads, unread replies, and course URLs", () => {
    const items = parseEdStemThreads({
      threads: [
        {
          id: 90210,
          number: 42,
          title: "Assignment clarification",
          document: "<document version=\"2.0\"><paragraph>Read <bold>this</bold>.</paragraph></document>",
          created_at: "2026-09-19T07:00:00.000Z",
          updated_at: "2026-09-19T07:30:00.000Z",
          category: "Assignments",
          new_reply_count: 2,
          is_seen: false,
        },
        {
          id: 90209,
          number: 41,
          title: "Old post",
          created_at: "2026-09-17T07:00:00.000Z",
        },
      ],
    }, { id: "146267", code: "MATH1851", name: "Calculus" }, "https://us.edstem.org/api", { now });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "edstem:146267:90210",
      source: "edstem",
      title: "Assignment clarification",
      content: "Read this.",
      url: "https://us.edstem.org/us/courses/146267/discussion/42",
      metadata: {
        kind: "thread",
        platform: "edstem",
        course: "MATH1851",
        unread: true,
        newReplyCount: 2,
      },
    });
  });
});
