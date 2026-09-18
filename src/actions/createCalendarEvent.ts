import {
  ActionInputError,
  blockedResult,
  makeActionResult,
  mayExecute,
  policyFor,
  requireNonEmptyText,
  resolveActionOptions,
} from "./common.js";
import type {
  ActionExecutionOptions,
  ActionExecutionResult,
  CalendarEvent,
  CalendarEventPlan,
  CalendarEventWriter,
  CreateCalendarEventInput,
  CreateCalendarEventRequest,
} from "./types.js";

function splitRequest(
  inputOrRequest: CreateCalendarEventInput | CreateCalendarEventRequest,
  options: ActionExecutionOptions | undefined,
  writer: CalendarEventWriter | undefined,
): {
  input: CreateCalendarEventInput;
  options: ActionExecutionOptions;
  writer?: CalendarEventWriter;
} {
  if (options !== undefined) {
    return {
      input: inputOrRequest,
      options,
      ...(writer === undefined ? {} : { writer }),
    };
  }

  const request = inputOrRequest as CreateCalendarEventRequest;
  return {
    input: {
      itemId: request.itemId,
      title: request.title,
      startTime: request.startTime,
      endTime: request.endTime,
      ...(request.calendarId === undefined
        ? {}
        : { calendarId: request.calendarId }),
      ...(request.timeZone === undefined
        ? {}
        : { timeZone: request.timeZone }),
    },
    options: {
      confidence: request.confidence,
      ...(request.dryRun === undefined ? {} : { dryRun: request.dryRun }),
      ...(request.approvalGranted === undefined
        ? {}
        : { approvalGranted: request.approvalGranted }),
      ...(request.actionId === undefined ? {} : { actionId: request.actionId }),
      ...(request.now === undefined ? {} : { now: request.now }),
    },
    ...(request.writer === undefined ? {} : { writer: request.writer }),
  };
}

function parseIsoTime(value: string, fieldName: string): string {
  const normalized = requireNonEmptyText(value, fieldName, 128);
  const timestamp = Date.parse(normalized);

  if (!Number.isFinite(timestamp)) {
    throw new ActionInputError(`${fieldName} must be a valid date-time.`);
  }

  return new Date(timestamp).toISOString();
}

function normalizeInput(input: CreateCalendarEventInput): CalendarEventPlan {
  const itemId = requireNonEmptyText(input.itemId, "itemId", 512);
  const title = requireNonEmptyText(input.title, "title", 240);
  const startTime = parseIsoTime(input.startTime, "startTime");
  const endTime = parseIsoTime(input.endTime, "endTime");

  if (Date.parse(endTime) <= Date.parse(startTime)) {
    throw new ActionInputError("endTime must be after startTime.");
  }

  const calendarId = input.calendarId === undefined
    ? undefined
    : requireNonEmptyText(input.calendarId, "calendarId", 256);
  const timeZone = input.timeZone === undefined
    ? undefined
    : requireNonEmptyText(input.timeZone, "timeZone", 128);

  return {
    kind: "createCalendarEvent",
    itemId,
    title,
    startTime,
    endTime,
    ...(calendarId === undefined ? {} : { calendarId }),
    ...(timeZone === undefined ? {} : { timeZone }),
  };
}

function fallbackPlan(input: CreateCalendarEventInput): CalendarEventPlan {
  return {
    kind: "createCalendarEvent",
    itemId: input.itemId,
    title: input.title,
    startTime: input.startTime,
    endTime: input.endTime,
    ...(input.calendarId === undefined ? {} : { calendarId: input.calendarId }),
    ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
  };
}

function descriptionFor(plan: CalendarEventPlan): string {
  return `Create calendar event ${plan.title} from ${plan.startTime} to ${plan.endTime}`;
}

function toCalendarEvent(plan: CalendarEventPlan): CalendarEvent {
  return {
    itemId: plan.itemId,
    title: plan.title,
    startTime: plan.startTime,
    endTime: plan.endTime,
    ...(plan.calendarId === undefined ? {} : { calendarId: plan.calendarId }),
    ...(plan.timeZone === undefined ? {} : { timeZone: plan.timeZone }),
  };
}

async function execute(
  input: CreateCalendarEventInput,
  executionOptions: ActionExecutionOptions,
  writer: CalendarEventWriter | undefined,
): Promise<ActionExecutionResult<CalendarEventPlan>> {
  const options = resolveActionOptions(executionOptions);
  const policy = policyFor("createCalendarEvent", options);

  let plan: CalendarEventPlan;
  try {
    plan = normalizeInput(input);
  } catch (error: unknown) {
    const fallback = fallbackPlan(input);
    return makeActionResult(
      "createCalendarEvent",
      input.itemId,
      fallback,
      policy,
      options,
      "rejected",
      "skipped",
      "createCalendarEvent input was rejected.",
      error instanceof Error
        ? error.message
        : "Invalid createCalendarEvent input.",
    );
  }

  if (!mayExecute(policy, options)) {
    if (options.dryRun) {
      return makeActionResult(
        "createCalendarEvent",
        plan.itemId,
        plan,
        policy,
        options,
        "planned",
        "skipped",
        descriptionFor(plan),
      );
    }

    return blockedResult(
      "createCalendarEvent",
      plan.itemId,
      plan,
      policy,
      options,
      descriptionFor(plan),
    );
  }

  if (writer === undefined) {
    return makeActionResult(
      "createCalendarEvent",
      plan.itemId,
      plan,
      policy,
      options,
      "rejected",
      "skipped",
      descriptionFor(plan),
      "No typed calendar writer was provided.",
    );
  }

  try {
    await writer.createEvent(toCalendarEvent(plan));

    return makeActionResult(
      "createCalendarEvent",
      plan.itemId,
      plan,
      policy,
      options,
      "executed",
      "completed",
      descriptionFor(plan),
    );
  } catch (error: unknown) {
    return makeActionResult(
      "createCalendarEvent",
      plan.itemId,
      plan,
      policy,
      options,
      "rejected",
      "skipped",
      descriptionFor(plan),
      error instanceof Error ? error.message : "Calendar writer failed.",
    );
  }
}

export function executeCreateCalendarEvent(
  input: CreateCalendarEventInput,
  options: ActionExecutionOptions,
  writer?: CalendarEventWriter,
): Promise<ActionExecutionResult<CalendarEventPlan>> {
  return execute(input, options, writer);
}

export function createCalendarEvent(
  request: CreateCalendarEventRequest,
): Promise<ActionExecutionResult<CalendarEventPlan>>;
export function createCalendarEvent(
  input: CreateCalendarEventInput,
  options: ActionExecutionOptions,
  writer?: CalendarEventWriter,
): Promise<ActionExecutionResult<CalendarEventPlan>>;
export function createCalendarEvent(
  inputOrRequest: CreateCalendarEventInput | CreateCalendarEventRequest,
  options?: ActionExecutionOptions,
  writer?: CalendarEventWriter,
): Promise<ActionExecutionResult<CalendarEventPlan>> {
  const request = splitRequest(inputOrRequest, options, writer);
  return execute(request.input, request.options, request.writer);
}

export default createCalendarEvent;
