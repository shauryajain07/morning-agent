import type {
  AgentItem,
  CalendarActionDecision,
  DecisionRecord,
  DeadlineDecision,
  FileDownloadDecision,
  ImportantEmailDecision,
  RequiresActionDecision,
} from "../types/index.js";
import type { DecisionEngine } from "./engine.js";

const confidence = 0.99;

const record = (
  item: AgentItem,
  decision: DecisionRecord["decision"],
  output: DecisionRecord["output"],
): DecisionRecord => ({
  itemId: item.id,
  decision,
  output,
  model: "mock-jev-fixture",
  decidedAt: new Date(),
});

const mockUrgency = (item: AgentItem): RequiresActionDecision["urgency"] => {
  if (item.deadline === undefined) return item.source === "email" || item.source === "github" ? "soon" : "none";
  const days = (item.deadline.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
  if (days <= 1) return "today";
  if (days <= 7) return "soon";
  return "later";
};

export class MockDecisionEngine implements DecisionEngine {
  public async evaluateItem(item: AgentItem): Promise<DecisionRecord[]> {
    const actionRequired = item.source === "email" || item.source === "github" || item.metadata.kind === "assignment";
    const requiresAction: RequiresActionDecision = {
      actionRequired,
      urgency: actionRequired ? mockUrgency(item) : "none",
      confidence,
    };
    const important = item.source === "email" && item.id !== "email-marketing-newsletter";
    const importantEmail: ImportantEmailDecision = {
      important,
      category:
        item.id === "email-hku-subclass-registration"
          ? "academic"
          : item.id === "email-marketing-newsletter"
            ? "marketing"
            : "notification",
      requiresReply: item.id === "email-hku-subclass-registration",
      confidence,
    };
    const deadlineDecision: DeadlineDecision = {
      hasDeadline: item.deadline !== undefined,
      ...(item.deadline === undefined ? {} : { deadline: item.deadline.toISOString() }),
      confidence,
    };
    const isCourseFile = item.metadata.kind === "course_file";
    const downloadDecision: FileDownloadDecision = {
      download: isCourseFile,
      fileType: isCourseFile ? "lecture" : "other",
      ...(typeof item.metadata.course === "string" ? { course: item.metadata.course } : {}),
      confidence,
    };
    const createEvent = item.metadata.kind === "assignment";
    const eventStart = item.deadline === undefined
      ? undefined
      : new Date(item.deadline.getTime() - 60 * 60 * 1000).toISOString();
    const calendarDecision: CalendarActionDecision = {
      createEvent,
      ...(createEvent ? { title: item.title } : {}),
      ...(createEvent && eventStart !== undefined && item.deadline !== undefined
        ? { startTime: eventStart, endTime: item.deadline.toISOString() }
        : {}),
      confidence: createEvent ? 0.82 : confidence,
    };

    return [
      record(item, "requiresAction", requiresAction),
      record(item, "importantEmail", importantEmail),
      record(item, "detectDeadline", deadlineDecision),
      record(item, "shouldDownloadFile", downloadDecision),
      record(item, "shouldCreateCalendarEvent", calendarDecision),
    ];
  }
}
