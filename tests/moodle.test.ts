import { describe, expect, it } from "vitest";

import {
  extractMoodleItems,
  discoverCourseLinks,
  discoverMoodleDetailLinks,
  parseMoodleDate,
  type MoodlePageSnapshot,
} from "../src/collectors/moodleBrowser.js";

describe("Moodle browser adapter", () => {
  it("parses Moodle's Hong Kong due date formats", () => {
    expect(parseMoodleDate("Due: 19 September 2026, 11:59 PM")?.toISOString()).toBe(
      "2026-09-19T15:59:00.000Z",
    );
    expect(parseMoodleDate("Tomorrow at 09:30", new Date("2026-09-18T00:00:00.000Z"))?.toISOString()).toBe(
      "2026-09-19T01:30:00.000Z",
    );
  });

  it("extracts and deduplicates announcements, assignments, and course files", () => {
    const snapshots: MoodlePageSnapshot[] = [
      {
        url: "https://moodle.example/my/",
        title: "Dashboard",
        bodyText: "MATH1851 Assignment 2 and course announcements",
        links: [
          {
            href: "https://moodle.example/course/view.php?id=10",
            text: "MATH1851",
            context: "MATH1851",
            title: "",
            ariaLabel: "",
          },
          {
            href: "https://moodle.example/mod/assign/view.php?id=21",
            text: "Assignment 2",
            context: "MATH1851 Assignment 2 — Due: 19 September 2026, 11:59 PM",
            title: "",
            ariaLabel: "",
          },
        ],
      },
      {
        url: "https://moodle.example/course/view.php?id=10",
        title: "MATH1851",
        bodyText: "Announcements Lecture 6",
        links: [
          {
            href: "https://moodle.example/mod/forum/discuss.php?d=31",
            text: "Week 3 announcement",
            context: "Announcements — Week 3 announcement — Posted: 18 September 2026",
            title: "",
            ariaLabel: "",
          },
          {
            href: "https://moodle.example/mod/resource/view.php?id=42",
            text: "Lecture 6 slides",
            context: "Lecture 6 slides — Added: 18 September 2026",
            title: "",
            ariaLabel: "",
          },
        ],
      },
      {
        url: "https://moodle.example/course/view.php?id=10",
        title: "MATH1851",
        bodyText: "duplicate page",
        links: [
          {
            href: "https://moodle.example/mod/resource/view.php?id=42#section",
            text: "Lecture 6 slides",
            context: "Lecture 6 slides — Added: 18 September 2026",
            title: "",
            ariaLabel: "",
          },
        ],
      },
    ];

    const result = extractMoodleItems(snapshots, new Date("2026-09-18T00:00:00.000Z"));
    expect(result.announcements).toHaveLength(1);
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]?.deadline?.toISOString()).toBe("2026-09-19T15:59:00.000Z");
    expect(result.courseFiles).toHaveLength(1);
    expect(result.courseFiles[0]?.metadata).toMatchObject({
      course: "MATH1851",
      kind: "course_file",
    });
  });

  it("ignores navigation links that only mention assignments in surrounding text", () => {
    const result = extractMoodleItems([
      {
        url: "https://moodle.example/my/",
        title: "Dashboard",
        bodyText: "",
        links: [
          {
            href: "https://moodle.example/calendar/view.php",
            text: "Go to calendar...",
            context: "Assignment 1 is due — Go to calendar...",
            title: "",
            ariaLabel: "",
          },
          {
            href: "https://moodle.example/mod/resource/view.php?id=99",
            text: "Assignment 2 file",
            context: "CCHU9078 Assignment 2 file",
            title: "",
            ariaLabel: "",
          },
          {
            href: "https://moodle.example/mod/assign/view.php?id=100",
            text: "ASSIGNMENT 1 is due",
            context: "ENGG1330 — Due: 23 September 2026",
            title: "",
            ariaLabel: "",
          },
        ],
      },
    ]);

    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]?.title).toContain("ASSIGNMENT 1");
    expect(result.courseFiles).toHaveLength(1);
    expect(result.courseFiles[0]?.metadata.kind).toBe("course_file");
  });

  it("removes Moodle accessibility navigation chrome from item context", () => {
    const result = extractMoodleItems([
      {
        url: "https://moodle.example/course/view.php?id=10",
        title: "ENGG1000",
        bodyText: "",
        links: [
          {
            href: "https://moodle.example/mod/assign/view.php?id=42",
            text: "ASSIGNMENT 1 is due",
            context: "Skip to sidebar navigation menu Skip to sidebar hidden blocks Skip to page footer Skip to main content Blocks Close Blocks Close Blocks Skip To do To do There are no upcoming events Go to calendar... Skip ReadingList@HKUL R ASSIGNMENT 1 is due — Due: 23 September 2026",
            title: "",
            ariaLabel: "",
          },
        ],
      },
    ]);

    expect(result.assignments[0]?.content).not.toMatch(/Skip|Blocks Close|There are no upcoming events/iu);
    expect(result.assignments[0]?.content).toContain("ASSIGNMENT 1 is due");
  });

  it("removes Moodle drawer chrome before the page context", () => {
    const result = extractMoodleItems([
      {
        url: "https://moodle.example/course/view.php?id=10",
        title: "ENGG1330",
        bodyText: "",
        links: [
          {
            href: "https://moodle.example/mod/assign/view.php?id=43",
            text: "Participation assignment",
            context: "Skip ReadingList@HKUL ReadingList@HKUL Reading list for _ENGG1330_1ABCDEFGHJKLMNO_2026 Close Light Mode 63 JS Open course index Home Courses _ENGG1330_1ABCDEFGHJKLMNO_2026 Participation records",
            title: "",
            ariaLabel: "",
          },
        ],
      },
    ]);

    expect(result.assignments[0]?.content).not.toContain("ReadingList@HKUL");
    expect(result.assignments[0]?.content).not.toContain("Home Courses");
    expect(result.assignments[0]?.content).toContain("Participation records");
  });

  it("keeps assignment context readable after removing Moodle page chrome", () => {
    const result = extractMoodleItems([
      {
        url: "https://moodle.example/course/view.php?id=10",
        title: "ENGG1000",
        bodyText: "",
        links: [
          {
            href: "https://moodle.example/mod/assign/view.php?id=44",
            text: "ASSIGNMENT 1",
            context: "Dashboard My courses 63 Shaurya Dileep Jain JS Open course index ENGG1000_1B_2026 General Tutorial Participation Blocks Tutorial Participation Blocks Completion requirements Participation Requirements: Attendance taken in the tutorial session. Blocks Blocks Blocks Blocks FAQs for Teachers User guides for Teachers",
            title: "",
            ariaLabel: "",
          },
        ],
      },
    ]);

    expect(result.assignments[0]?.content).not.toMatch(/Dashboard|My courses|Open course index|FAQs for Teachers/iu);
    expect(result.assignments[0]?.content).toContain("General Tutorial Participation · Completion requirements");
  });

  it("discovers bounded same-origin activity pages for nested files", () => {
    const snapshot: MoodlePageSnapshot = {
      url: "https://moodle.example/course/view.php?id=10",
      title: "MATH1851",
      bodyText: "",
      links: [
        {
          href: "https://moodle.example/mod/folder/view.php?id=44",
          text: "Week 3 files",
          context: "Week 3 files",
          title: "",
          ariaLabel: "",
        },
        {
          href: "https://files.example.com/lecture.pdf",
          text: "External file",
          context: "External file",
          title: "",
          ariaLabel: "",
        },
      ],
    };

    expect(discoverMoodleDetailLinks(snapshot, "https://moodle.example/my/")).toEqual([
      "https://moodle.example/mod/folder/view.php?id=44",
    ]);
  });

  it("ignores Moodle skip links and selects the MATH1851 AB course", () => {
    const snapshot: MoodlePageSnapshot = {
      url: "https://moodle.example/",
      title: "Home | hkumoodle",
      bodyText: "",
      links: [
        {
          href: "https://moodle.example/#maincontent",
          text: "Skip to main content",
          context: "Skip to main content",
          title: "",
          ariaLabel: "",
        },
        {
          href: "https://moodle.example/course/view.php?id=146267",
          text: "Course name MATH1851_1AB Calculus and ordinary differential equations",
          context: "MATH1851_1AB",
          title: "",
          ariaLabel: "",
        },
        {
          href: "https://moodle.example/course/view.php?id=142655",
          text: "Course name MATH1851 Calculus and ordinary differential equations [Section 1B]",
          context: "MATH1851 Section 1B",
          title: "",
          ariaLabel: "",
        },
        {
          href: "https://moodle.example/course/index.php",
          text: "All courses",
          context: "MATH1851_1AB and MATH1851",
          title: "",
          ariaLabel: "",
        },
      ],
    };

    expect(discoverCourseLinks(snapshot, "https://moodle.example/my/")).toEqual([
      "https://moodle.example/course/view.php?id=146267",
    ]);
  });

  it("discovers courses that are not in the local course configuration", () => {
    const snapshot: MoodlePageSnapshot = {
      url: "https://moodle.example/my/",
      title: "Dashboard | hkumoodle",
      bodyText: "",
      links: [
        {
          href: "https://moodle.example/course/view.php?id=200001",
          text: "Elective course: Introduction to Design",
          context: "Introduction to Design",
          title: "",
          ariaLabel: "",
        },
      ],
    };

    expect(discoverCourseLinks(snapshot, "https://moodle.example/my/")).toEqual([
      "https://moodle.example/course/view.php?id=200001",
    ]);
  });

  it("prefers a nested pluginfile over its resource wrapper", () => {
    const result = extractMoodleItems([
      {
        url: "https://moodle.example/course/view.php?id=10",
        title: "MATH1851",
        bodyText: "",
        links: [
          {
            href: "https://moodle.example/mod/resource/view.php?id=42",
            text: "Week 3 lecture",
            context: "Week 3 lecture",
            title: "",
            ariaLabel: "",
          },
        ],
      },
      {
        url: "https://moodle.example/mod/resource/view.php?id=42",
        title: "Week 3 lecture",
        bodyText: "",
        links: [
          {
            href: "https://moodle.example/pluginfile.php/10/mod_resource/content/1/week3.pdf?forcedownload=1",
            text: "Download week3.pdf",
            context: "Download week3.pdf",
            title: "",
            ariaLabel: "",
          },
        ],
      },
    ]);

    expect(result.courseFiles).toHaveLength(1);
    expect(result.courseFiles[0]?.url).toContain("pluginfile.php");
  });
});
