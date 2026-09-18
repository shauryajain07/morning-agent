export const agentSources = [
  "calendar",
  "email",
  "github",
  "downloads",
  "moodle",
] as const;

export type AgentSource = (typeof agentSources)[number];

export type AgentItem = {
  id: string;
  source: AgentSource;
  title: string;
  content?: string;
  url?: string;
  createdAt?: Date;
  deadline?: Date;
  metadata: Record<string, unknown>;
};

export type Urgency = "today" | "soon" | "later" | "none";

export type RequiresActionDecision = {
  actionRequired: boolean;
  urgency: Urgency;
  confidence: number;
};

export const emailCategories = [
  "academic",
  "administrative",
  "project",
  "personal",
  "notification",
  "marketing",
] as const;

export type EmailCategory = (typeof emailCategories)[number];

export type ImportantEmailDecision = {
  important: boolean;
  category: EmailCategory;
  requiresReply: boolean;
  confidence: number;
};

export type DeadlineDecision = {
  hasDeadline: boolean;
  deadline?: string;
  confidence: number;
};

export const fileTypes = [
  "lecture",
  "assignment",
  "notes",
  "administrative",
  "other",
] as const;

export type FileType = (typeof fileTypes)[number];

export type FileDownloadDecision = {
  download: boolean;
  fileType: FileType;
  course?: string;
  confidence: number;
};

export type CalendarActionDecision = {
  createEvent: boolean;
  title?: string;
  startTime?: string;
  endTime?: string;
  confidence: number;
};

export type DecisionName =
  | "requiresAction"
  | "importantEmail"
  | "detectDeadline"
  | "shouldDownloadFile"
  | "shouldCreateCalendarEvent";

export type DecisionOutput =
  | RequiresActionDecision
  | ImportantEmailDecision
  | DeadlineDecision
  | FileDownloadDecision
  | CalendarActionDecision;

export type DecisionRecord = {
  itemId: string;
  decision: DecisionName;
  output: DecisionOutput;
  model: string;
  decidedAt: Date;
};

export type ActionKind =
  | "downloadFile"
  | "moveFile"
  | "createCalendarEvent"
  | "createTask";

export type ActionStatus = "completed" | "suggested" | "manual_review" | "skipped";

export type ActionRecord = {
  id: string;
  kind: ActionKind;
  itemId: string;
  status: ActionStatus;
  description: string;
  createdAt: Date;
};

export type MoodleProvider = {
  getAnnouncements(): Promise<AgentItem[]>;
  getAssignments(): Promise<AgentItem[]>;
  getCourseFiles(): Promise<AgentItem[]>;
};

export type RunOptions = {
  dryRun: boolean;
  mock: boolean;
  verbose: boolean;
};
