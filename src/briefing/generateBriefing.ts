import type { AgentItem, ActionRecord, DecisionRecord } from "../types/index.js";

export type BriefingInput = {
  now: Date;
  items: AgentItem[];
  decisions: DecisionRecord[];
  actions: ActionRecord[];
  newItemIds: Set<string>;
};

export type MorningReport = {
  text: string;
  urgent: string[];
  academic: string[];
  github: string[];
  news: string[];
  emails: string[];
  upcoming: string[];
  autoCompleted: string[];
  needsApproval: string[];
  lowConfidence: string[];
};

const dateFormatter = new Intl.DateTimeFormat("en-HK", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "Asia/Hong_Kong",
});

const shortDateFormatter = new Intl.DateTimeFormat("en-HK", {
  day: "numeric",
  month: "short",
  timeZone: "Asia/Hong_Kong",
});

const asText = (value: unknown): string => (typeof value === "string" ? value : "");

const confidenceOf = (decision: DecisionRecord): number => {
  const output = decision.output;
  return output.confidence;
};

const decisionFor = (
  decisions: DecisionRecord[],
  itemId: string,
  name: DecisionRecord["decision"],
): DecisionRecord | undefined =>
  decisions.find((decision) => decision.itemId === itemId && decision.decision === name);

const formatUpcoming = (item: AgentItem): string => {
  const deadline = item.deadline;
  return deadline === undefined ? item.title : `${shortDateFormatter.format(deadline)} — ${item.title}`;
};

export const createMorningReport = (input: BriefingInput): MorningReport => {
  const urgent: string[] = [];
  const academic: string[] = [];
  const github: string[] = [];
  const news: string[] = [];
  const emails: string[] = [];
  const upcoming: string[] = [];
  const autoCompleted = input.actions
    .filter((action) => action.status === "completed")
    .map((action) => action.description);
  const needsApproval = input.actions
    .filter((action) => action.status === "suggested")
    .map((action) => action.description);
  const lowConfidence: string[] = [];
  const deadlineNow = input.now.getTime();
  const deadlineCutoff = deadlineNow + 7 * 24 * 60 * 60 * 1_000;

  for (const item of input.items) {
    const actionDecision = decisionFor(input.decisions, item.id, "requiresAction");
    const actionRequired = actionDecision?.output;
    if (
      actionRequired !== undefined &&
      "actionRequired" in actionRequired &&
      actionRequired.actionRequired &&
      actionRequired.urgency === "today"
    ) {
      urgent.push(item.title);
    }

    if (item.source === "github" && input.newItemIds.has(item.id)) github.push(item.title);

    if ((item.source === "news" || item.source === "edstem") && input.newItemIds.has(item.id)) {
      const readingDecision = decisionFor(input.decisions, item.id, "worthReading");
      if (readingDecision?.output !== undefined && "worthReading" in readingDecision.output && readingDecision.output.worthReading) {
        news.push(item.title);
      }
    }

    if (
      item.source === "moodle" &&
      input.newItemIds.has(item.id) &&
      (item.metadata.kind === "course_file" || item.metadata.kind === "assignment")
    ) {
      academic.push(item.title);
    }

    if (item.source === "email") {
      const emailDecision = decisionFor(input.decisions, item.id, "importantEmail");
      if (emailDecision?.output !== undefined && "important" in emailDecision.output) {
        if (emailDecision.output.important && input.newItemIds.has(item.id)) emails.push(item.title);
      }
    }

    if (
      item.deadline !== undefined &&
      item.deadline.getTime() >= deadlineNow &&
      item.deadline.getTime() <= deadlineCutoff
    ) {
      upcoming.push(formatUpcoming(item));
    }

    for (const decision of input.decisions.filter((candidate) => candidate.itemId === item.id)) {
      if (confidenceOf(decision) < 0.75) lowConfidence.push(`${item.title} (${decision.decision})`);
    }
  }

  const lines = [
    "MORNING AGENT",
    dateFormatter.format(input.now),
    "",
    "TODAY",
    ...(urgent.length > 0 ? ["", "[URGENT]", ...urgent.map((entry) => entry)] : []),
    ...(academic.length > 0 ? ["", "[ACADEMIC]", ...academic.map((entry) => entry)] : []),
    ...(github.length > 0 ? ["", "[GITHUB]", ...github.map((entry) => entry)] : []),
    ...(news.length > 0 ? ["", "[READ NEXT]", ...news.map((entry) => `- ${entry}`)] : []),
    ...(emails.length > 0
      ? ["", "[EMAIL]", `${emails.length} important email${emails.length === 1 ? "" : "s"}`, ...emails.map((entry) => `- ${entry}`)]
      : []),
    ...(upcoming.length > 0 ? ["", "UPCOMING", ...upcoming] : []),
    ...(autoCompleted.length > 0 ? ["", "AUTO-COMPLETED", ...autoCompleted.map((entry) => `- ${entry}`)] : []),
    ...(needsApproval.length > 0 ? ["", "NEEDS APPROVAL", ...needsApproval.map((entry) => `- ${entry}`)] : []),
    ...(lowConfidence.length > 0
      ? ["", "LOW CONFIDENCE", `${lowConfidence.length} item${lowConfidence.length === 1 ? "" : "s"} requires review.`, ...lowConfidence.map((entry) => `- ${entry}`)]
      : []),
    "",
    "SUMMARY",
    `${urgent.length + academic.length} actions today`,
    `${upcoming.length} upcoming deadline${upcoming.length === 1 ? "" : "s"}`,
    `${academic.length} new course file${academic.length === 1 ? "" : "s"}`,
    `${emails.length} important email${emails.length === 1 ? "" : "s"}`,
    `${news.length} article${news.length === 1 ? "" : "s"} worth reading`,
  ];

  return {
    text: lines.join("\n"),
    urgent,
    academic,
    github,
    news,
    emails,
    upcoming,
    autoCompleted,
    needsApproval,
    lowConfidence,
  };
};

export const metadataString = (item: AgentItem, key: string): string => asText(item.metadata[key]);
