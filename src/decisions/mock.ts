import type {
  AgentItem,
  CalendarActionDecision,
  DecisionRecord,
  DeadlineDecision,
  FileDownloadDecision,
  ImportantEmailDecision,
  NewsWorthReadingDecision,
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
    if (item.source === "downloads") return [];

    if (item.source === "ed" || item.source === "news") {
      const worthReading: NewsWorthReadingDecision = {
        worthReading: true,
        category: item.source === "ed" ? "technology" : "other",
        confidence,
      };
      return [record(item, "worthReading", worthReading)];
    }

    const records: DecisionRecord[] = [];
    const actionRequired = item.source === "email" || item.source === "github" || item.metadata.kind === "assignment";
    const requiresAction: RequiresActionDecision = {
      actionRequired,
      urgency: actionRequired ? mockUrgency(item) : "none",
      confidence,
    };
    records.push(record(item, "requiresAction", requiresAction));

    if (item.source === "email") {
      const important = item.id !== "email-marketing-newsletter";
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
      records.push(record(item, "importantEmail", importantEmail));
    }

    if (item.source === "email" || item.source === "calendar" || item.source === "moodle") {
      const deadlineDecision: DeadlineDecision = {
        hasDeadline: item.deadline !== undefined,
        ...(item.deadline === undefined ? {} : { deadline: item.deadline.toISOString() }),
        confidence,
      };
      records.push(record(item, "detectDeadline", deadlineDecision));
    }

    if (item.source === "moodle") {
      const isCourseFile = item.metadata.kind === "course_file";
      const downloadDecision: FileDownloadDecision = {
        download: isCourseFile,
        fileType: isCourseFile ? "lecture" : "other",
        ...(typeof item.metadata.course === "string" ? { course: item.metadata.course } : {}),
        confidence,
      };
      if (isCourseFile) records.push(record(item, "shouldDownloadFile", downloadDecision));

      if (item.metadata.kind === "assignment") {
        const eventStart = item.deadline === undefined
          ? undefined
          : new Date(item.deadline.getTime() - 60 * 60 * 1000).toISOString();
        const calendarDecision: CalendarActionDecision = {
          createEvent: true,
          title: item.title,
          ...(eventStart === undefined || item.deadline === undefined
            ? {}
            : { startTime: eventStart, endTime: item.deadline.toISOString() }),
          confidence: 0.82,
        };
        records.push(record(item, "shouldCreateCalendarEvent", calendarDecision));
      }
    }

    if (item.source === "calendar") {
      const calendarDecision: CalendarActionDecision = {
        createEvent: false,
        confidence,
      };
      records.push(record(item, "shouldCreateCalendarEvent", calendarDecision));
    }

    return records;
  }
}
