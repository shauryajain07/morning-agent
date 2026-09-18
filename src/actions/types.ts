import type {
  ActionKind,
  ActionRecord,
  ActionStatus,
} from "../types/index.js";
import type { ActionPolicyDecision } from "../policy/index.js";

export type ActionExecutionOptions = {
  confidence: number;
  dryRun?: boolean;
  approvalGranted?: boolean;
  actionId?: string;
  now?: Date;
};

export type DownloadFileInput = {
  itemId: string;
  sourcePath: string;
  destinationPath: string;
  overwrite?: boolean;
};

export type MoveFileInput = {
  itemId: string;
  sourcePath: string;
  destinationPath: string;
  overwrite?: boolean;
};

export type CreateCalendarEventInput = {
  itemId: string;
  title: string;
  startTime: string;
  endTime: string;
  calendarId?: string;
  timeZone?: string;
};

export type CreateTaskInput = {
  itemId: string;
  title: string;
  description?: string;
  dueDate?: string;
  listId?: string;
};

export type DownloadFileRequest = DownloadFileInput & ActionExecutionOptions;
export type MoveFileRequest = MoveFileInput & ActionExecutionOptions;
export type CreateCalendarEventRequest = CreateCalendarEventInput &
  ActionExecutionOptions & {
    writer?: CalendarEventWriter;
  };
export type CreateTaskRequest = CreateTaskInput &
  ActionExecutionOptions & {
    writer?: TaskWriter;
  };

export type DownloadFilePlan = {
  kind: "downloadFile";
  itemId: string;
  sourcePath: string;
  destinationPath: string;
};

export type MoveFilePlan = {
  kind: "moveFile";
  itemId: string;
  sourcePath: string;
  destinationPath: string;
};

export type CalendarEventPlan = {
  kind: "createCalendarEvent";
  itemId: string;
  title: string;
  startTime: string;
  endTime: string;
  calendarId?: string;
  timeZone?: string;
};

export type TaskPlan = {
  kind: "createTask";
  itemId: string;
  title: string;
  description?: string;
  dueDate?: string;
  listId?: string;
};

export type ActionPlan =
  | DownloadFilePlan
  | MoveFilePlan
  | CalendarEventPlan
  | TaskPlan;

export type ActionExecutionOutcome =
  | "executed"
  | "planned"
  | "requires_approval"
  | "manual_review"
  | "rejected";

export type ActionExecutionResult<P extends ActionPlan = ActionPlan> = {
  kind: ActionKind;
  itemId: string;
  outcome: ActionExecutionOutcome;
  status: ActionStatus;
  dryRun: boolean;
  policy: ActionPolicyDecision;
  record: ActionRecord;
  plan: P;
  error?: string;
};

export type CalendarEvent = {
  itemId: string;
  title: string;
  startTime: string;
  endTime: string;
  calendarId?: string;
  timeZone?: string;
};

export type CalendarEventReceipt = {
  eventId: string;
};

export type CalendarEventWriter = {
  createEvent(
    event: CalendarEvent,
  ): Promise<CalendarEventReceipt | void>;
};

export type Task = {
  itemId: string;
  title: string;
  description?: string;
  dueDate?: string;
  listId?: string;
};

export type TaskReceipt = {
  taskId: string;
};

export type TaskWriter = {
  createTask(task: Task): Promise<TaskReceipt | void>;
};
