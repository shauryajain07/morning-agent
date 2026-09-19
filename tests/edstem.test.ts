import { describe, expect, it } from "vitest";

import {
  discoverEdStemCourseLinks,
  discoverEdStemLessonIndexLinks,
  discoverEdStemLessonLinks,
  extractEdStemLessonItems,
  type EdStemPageSnapshot,
} from "../src/collectors/edstemBrowser.js";

const baseUrl = "https://edstem.org/us/";
const now = new Date("2026-09-19T08:00:00.000Z");

const link = (href: string, text: string, context = text) => ({
  href,
  text,
  context,
  title: "",
  ariaLabel: "",
  dateText: "",
});

describe("EdStem browser lesson adapter", () => {
  it("discovers course and Lessons navigation without following discussion links", () => {
    const snapshot: EdStemPageSnapshot = {
      url: baseUrl,
      title: "Ed Discussion",
      headingText: "Courses",
      bodyText: "MATH1851",
      dateText: "",
      links: [
        link("https://edstem.org/us/courses/146267", "MATH1851"),
        link("https://edstem.org/us/courses/146267/lessons", "Lessons"),
        link("https://edstem.org/us/courses/146267/discussion", "Discussion"),
      ],
    };

    expect(discoverEdStemCourseLinks(snapshot, baseUrl, ["MATH1851"])).toEqual([
      "https://edstem.org/us/courses/146267/",
    ]);
    expect(discoverEdStemLessonIndexLinks(snapshot, baseUrl)).toEqual([
      "https://edstem.org/us/courses/146267/lessons",
    ]);
  });

  it("discovers lesson detail pages and normalizes their resources", () => {
    const snapshot: EdStemPageSnapshot = {
      url: "https://edstem.org/us/courses/146267/lessons",
      title: "Lessons | MATH1851",
      headingText: "Lessons",
      bodyText: "Week 3",
      dateText: "",
      links: [
        link("https://edstem.org/us/courses/146267/lessons/90210", "Week 3 — Integration"),
        link("https://edstem.org/us/courses/146267/lessons/90210/slides/4", "Slides"),
      ],
    };

    expect(discoverEdStemLessonLinks(snapshot, baseUrl)).toEqual([
      "https://edstem.org/us/courses/146267/lessons/90210",
    ]);
  });

  it("tracks recent lesson content and visible files with a content fingerprint", () => {
    const snapshot: EdStemPageSnapshot = {
      url: "https://edstem.org/us/courses/146267/lessons/90210",
      title: "Week 3 — Integration | Ed Lessons",
      headingText: "Week 3 — Integration | Lessons",
      bodyText: "Week 3 — Integration. Read the worked examples before the tutorial.",
      dateText: "2026-09-19T07:30:00.000Z",
      links: [
        link("https://edstem.org/us/courses/146267/lessons/90210/slides/4", "Lecture slides.pdf"),
      ],
    };

    const items = extractEdStemLessonItems([snapshot], now);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      source: "edstem",
      title: "Week 3 — Integration",
      url: "https://edstem.org/us/courses/146267/lessons/90210",
      metadata: {
        kind: "lesson",
        platform: "edstem",
        courseId: "146267",
        lessonId: "90210",
        resourceCount: 1,
      },
    });
    expect(items[0]?.id).toMatch(/^edstem:lesson:146267:90210:[a-f0-9]{24}$/u);
    expect(items[0]?.metadata.resources).toEqual([
      {
        title: "Lecture slides.pdf",
        url: "https://edstem.org/us/courses/146267/lessons/90210/slides/4",
      },
    ]);
  });

  it("ignores lesson pages with a known update outside the lookback window", () => {
    const snapshot: EdStemPageSnapshot = {
      url: "https://edstem.org/us/courses/146267/lessons/90210",
      title: "Old lesson",
      headingText: "Old lesson",
      bodyText: "Old content",
      dateText: "2026-09-16T07:30:00.000Z",
      links: [],
    };

    expect(extractEdStemLessonItems([snapshot], now)).toEqual([]);
  });
});
