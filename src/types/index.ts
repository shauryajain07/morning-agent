export const agentSources = [
  "calendar",
  "email",
  "github",
  "downloads",
  "moodle",
  "edstem",
  "news",
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

export type StoredAgentItem = AgentItem & {
  observedAt: Date;
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

export const newsCategories = [
  "technology",
  "science",
  "business",
  "world",
  "education",
  "culture",
  "other",
] as const;

export type NewsCategory = (typeof newsCategories)[number];

export type NewsWorthReadingDecision = {
  worthReading: boolean;
  category: NewsCategory;
  confidence: number;
};

export type DecisionName =
  | "requiresAction"
  | "importantEmail"
  | "detectDeadline"
  | "shouldDownloadFile"
  | "shouldCreateCalendarEvent"
  | "worthReading";

export type DecisionOutput =
  | RequiresActionDecision
  | ImportantEmailDecision
  | DeadlineDecision
  | FileDownloadDecision
  | CalendarActionDecision
  | NewsWorthReadingDecision;

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

export type ReviewStatus = "approved" | "dismissed";

export type ReviewRecord = {
  itemId: string;
  decision: DecisionName;
  status: ReviewStatus;
  note?: string;
  updatedAt: Date;
};

export type MorningRunStage =
  | "collect"
  | "normalize"
  | "jev"
  | "policy"
  | "actions"
  | "briefing";

export type MorningRunStatus = "running" | "completed" | "failed";

export type RunSourceKey =
  | "downloads"
  | "calendar"
  | "gmail"
  | "github"
  | "news"
  | "edstem"
  | "moodle"
  | "outlook";

export type RunSourceStatus = "queued" | "starting" | "reading" | "completed" | "skipped" | "failed";

export type MorningRunRecord = {
  runId: string;
  status: MorningRunStatus;
  stage?: MorningRunStage;
  startedAt: Date;
  lastEventAt: Date;
  completedAt?: Date;
  itemCount?: number;
  decisionCount?: number;
  actionCount?: number;
  error?: string;
};

export type MorningRunEvent =
  | { type: "run_started"; runId: string; at: string }
  | {
      type: "source_progress";
      runId: string;
      at: string;
      source: RunSourceKey;
      label: string;
      status: RunSourceStatus;
      detail?: string;
    }
  | {
      type: "stage";
      runId: string;
      at: string;
      stage: MorningRunStage;
      status: "started" | "completed";
      label: string;
    }
  | { type: "items_collected"; runId: string; at: string; count: number }
  | { type: "decisions_completed"; runId: string; at: string; count: number }
  | { type: "actions_completed"; runId: string; at: string; count: number }
  | {
      type: "run_completed";
      runId: string;
      at: string;
      itemCount: number;
      decisionCount: number;
      actionCount: number;
    }
  | { type: "run_failed"; runId: string; at: string; error: string };

export interface MoodleProvider {
  getAnnouncements(): Promise<AgentItem[]>;
  getAssignments(): Promise<AgentItem[]>;
  getCourseFiles(): Promise<AgentItem[]>;
}

export type RunOptions = {
  dryRun: boolean;
  mock: boolean;
  verbose: boolean;
  persist?: boolean;
  onEvent?: (event: MorningRunEvent) => void;
};
