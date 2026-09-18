import type { AgentItem, ActionRecord, DecisionRecord } from "../types/index.js";

export type BriefingInput = {
  now: Date;
  items: AgentItem[];
  decisions: DecisionRecord[];
  actions: ActionRecord[];
  newDeadlineIds: Set<string>;
};

export type MorningReport = {
  text: string;
  urgent: string[];
  academic: string[];
  github: string[];
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
  const emails: string[] = [];
  const upcoming: string[] = [];
  const autoCompleted = input.actions
    .filter((action) => action.status === "completed")
    .map((action) => action.description);
  const needsApproval = input.actions
    .filter((action) => action.status === "suggested")
    .map((action) => action.description);
  const lowConfidence: string[] = [];

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

    if (item.source === "github") github.push(item.title);

    if (
      item.source === "moodle" &&
      (item.metadata.kind === "course_file" || item.metadata.kind === "assignment")
    ) {
      academic.push(item.title);
    }

    if (item.source === "email") {
      const emailDecision = decisionFor(input.decisions, item.id, "importantEmail");
      if (emailDecision?.output !== undefined && "important" in emailDecision.output) {
        if (emailDecision.output.important) emails.push(item.title);
      }
    }

    if (item.deadline !== undefined && input.newDeadlineIds.has(item.id)) {
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
  ];

  return {
    text: lines.join("\n"),
    urgent,
    academic,
    github,
    emails,
    upcoming,
    autoCompleted,
    needsApproval,
    lowConfidence,
  };
};

export const metadataString = (item: AgentItem, key: string): string => asText(item.metadata[key]);
