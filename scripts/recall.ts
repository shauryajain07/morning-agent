import {
  extractGmailEmailItems,
  type GmailMessageSnapshot,
} from "../src/collectors/gmail.js";
import {
  extractOutlookEmailItems,
  type OutlookMessageSnapshot,
} from "../src/collectors/outlookBrowser.js";
import {
  extractMoodleItems,
  type MoodlePageSnapshot,
} from "../src/collectors/moodleBrowser.js";
import {
  extractEdStemLessonItems,
  type EdStemPageSnapshot,
} from "../src/collectors/edstemBrowser.js";

const now = new Date("2026-10-13T08:00:00+08:00");
const encode = (value: string): string => Buffer.from(value, "utf8").toString("base64url");

type RecallFixture = {
  id: string;
  source: "gmail" | "outlook" | "moodle" | "edstem";
  label: string;
  missReason: string;
};

const gmailMessages: GmailMessageSnapshot[] = [
  {
    id: "recall-gmail-deadline",
    internalDate: String(Date.parse("2026-10-13T00:02:00Z")),
    snippet: "The lab report deadline is Friday.",
    payload: {
      headers: [
        { name: "From", value: "Course office <course@example.invalid>" },
        { name: "Subject", value: "Lab report deadline" },
      ],
      mimeType: "text/plain",
      body: { data: encode("Submit the lab report by Friday at 17:00.") },
    },
  },
  {
    id: "recall-gmail-unknown-date",
    snippet: "The deadline moved to Monday.",
    payload: {
      headers: [
        { name: "From", value: "Course office <course@example.invalid>" },
        { name: "Subject", value: "Updated submission deadline" },
      ],
      body: { data: encode("The submission deadline moved to Monday at 17:00.") },
    },
  },
];

const outlookMessages: OutlookMessageSnapshot[] = [
  {
    id: "recall-outlook-full-body",
    text: "Student services\nRegistration action required\nPlease confirm your tutorial choice.",
    ariaLabel: "Unread",
    href: "https://outlook.office.com/mail/recall-outlook-full-body",
    dateText: "Today 7:10 AM",
    unread: true,
    bodyText: "Please confirm your tutorial choice before registration closes. This is the full message body.",
  },
];

const moodlePages: MoodlePageSnapshot[] = [
  {
    url: "https://moodle.example.invalid/mod/assign/view.php?id=401",
    title: "Assignment 2 | MATH1851",
    bodyText: "Assignment 2. Submit your solution by 16 October 2026 at 23:59. Include your working and upload one PDF.",
    links: [],
  },
  {
    url: "https://moodle.example.invalid/course/view.php?id=10",
    title: "ENGG1330",
    bodyText: "Assessment item available",
    links: [{
      href: "https://moodle.example.invalid/mod/choice/view.php?id=402",
      text: "Assessment item",
      context: "Coursework assessment. Submit by 18 October 2026. The Moodle activity type is not recognized.",
      title: "",
      ariaLabel: "",
    }],
  },
];

const edStemPages: EdStemPageSnapshot[] = [
  {
    url: "https://edstem.org/us/courses/146267/lessons/90210",
    title: "Week 3 integration | Ed Lessons",
    headingText: "Week 3 integration | Lessons",
    bodyText: "Review the worked integration examples before the tutorial. The substitution method is used in the final section.",
    dateText: "2026-10-13T00:02:00Z",
    links: [],
  },
  {
    url: "https://edstem.org/us/courses/146267/lessons/90211",
    title: "Course notice | Ed Lessons",
    headingText: "Course notice | Lessons",
    bodyText: "The tutorial reading has changed. Review the revised examples before class.",
    dateText: "",
    links: [],
  },
];

const fixtures: RecallFixture[] = [
  { id: "gmail-deadline", source: "gmail", label: "deadline email with a parseable received date", missReason: "Gmail payload parsing or lookback filtering" },
  { id: "gmail-unknown-date", source: "gmail", label: "useful email with an unavailable received date", missReason: "Gmail date fallback or uncertainty retention" },
  { id: "outlook-full-body", source: "outlook", label: "Outlook action email with full body text", missReason: "Outlook row extraction or message-detail fetching" },
  { id: "moodle-assignment-detail", source: "moodle", label: "assignment detail page with a due date", missReason: "Moodle detail-page discovery or deadline parsing" },
  { id: "moodle-unknown-type", source: "moodle", label: "coursework activity with an unknown Moodle type", missReason: "Moodle uncertain-candidate retention" },
  { id: "edstem-current-lesson", source: "edstem", label: "recent lesson with course content", missReason: "EdStem lesson route or content extraction" },
  { id: "edstem-unknown-date", source: "edstem", label: "useful lesson with an unavailable update date", missReason: "EdStem date filtering or uncertainty retention" },
];

const gmailItems = extractGmailEmailItems(gmailMessages, now);
const outlookItems = extractOutlookEmailItems(outlookMessages, now);
const moodleCollection = extractMoodleItems(moodlePages, now);
const moodleItems = [
  ...moodleCollection.assignments,
  ...moodleCollection.announcements,
  ...moodleCollection.courseFiles,
  ...moodleCollection.uncertain,
];
const edStemItems = extractEdStemLessonItems(edStemPages, now);

const foundByFixture: Record<string, boolean> = {
  "gmail-deadline": gmailItems.some((item) => item.title === "Lab report deadline"),
  "gmail-unknown-date": gmailItems.some((item) => item.title === "Updated submission deadline" && item.metadata.dateStatus === "unknown"),
  "outlook-full-body": outlookItems.some((item) => item.title === "Registration action required" && item.content?.includes("full message body")),
  "moodle-assignment-detail": moodleItems.some((item) => item.url?.endsWith("/mod/assign/view.php?id=401") && item.deadline !== undefined),
  "moodle-unknown-type": moodleCollection.uncertain.some((item) => item.metadata.rawType === "unknown"),
  "edstem-current-lesson": edStemItems.some((item) => item.url?.endsWith("/lessons/90210")),
  "edstem-unknown-date": edStemItems.some((item) => item.url?.endsWith("/lessons/90211") && item.metadata.updatedAtStatus === "unknown"),
};

const results = fixtures.map((fixture) => ({
  ...fixture,
  found: foundByFixture[fixture.id] === true,
}));
const foundCount = results.filter((result) => result.found).length;
const missed = results.filter((result) => !result.found);

console.log(`Extraction recall: ${foundCount}/${results.length} (${((foundCount / results.length) * 100).toFixed(1)}%)`);
for (const result of results) {
  console.log(`${result.found ? "FOUND" : "MISSED"} ${result.id}: ${result.label}${result.found ? "" : ` | inspect ${result.missReason}`}`);
}
if (missed.length > 0) process.exitCode = 1;
