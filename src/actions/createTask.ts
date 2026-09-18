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
  CreateTaskInput,
  CreateTaskRequest,
  Task,
  TaskPlan,
  TaskWriter,
} from "./types.js";

function splitRequest(
  inputOrRequest: CreateTaskInput | CreateTaskRequest,
  options: ActionExecutionOptions | undefined,
  writer: TaskWriter | undefined,
): {
  input: CreateTaskInput;
  options: ActionExecutionOptions;
  writer?: TaskWriter;
} {
  if (options !== undefined) {
    return {
      input: inputOrRequest,
      options,
      ...(writer === undefined ? {} : { writer }),
    };
  }

  const request = inputOrRequest as CreateTaskRequest;
  return {
    input: {
      itemId: request.itemId,
      title: request.title,
      ...(request.description === undefined
        ? {}
        : { description: request.description }),
      ...(request.dueDate === undefined ? {} : { dueDate: request.dueDate }),
      ...(request.listId === undefined ? {} : { listId: request.listId }),
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

function parseOptionalDate(value: string | undefined, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = requireNonEmptyText(value, fieldName, 128);
  const timestamp = Date.parse(normalized);

  if (!Number.isFinite(timestamp)) {
    throw new ActionInputError(`${fieldName} must be a valid date-time.`);
  }

  return new Date(timestamp).toISOString();
}

function normalizeInput(input: CreateTaskInput): TaskPlan {
  const itemId = requireNonEmptyText(input.itemId, "itemId", 512);
  const title = requireNonEmptyText(input.title, "title", 240);
  const description = input.description === undefined
    ? undefined
    : requireNonEmptyText(input.description, "description", 4000);
  const dueDate = parseOptionalDate(input.dueDate, "dueDate");
  const listId = input.listId === undefined
    ? undefined
    : requireNonEmptyText(input.listId, "listId", 256);

  return {
    kind: "createTask",
    itemId,
    title,
    ...(description === undefined ? {} : { description }),
    ...(dueDate === undefined ? {} : { dueDate }),
    ...(listId === undefined ? {} : { listId }),
  };
}

function fallbackPlan(input: CreateTaskInput): TaskPlan {
  return {
    kind: "createTask",
    itemId: input.itemId,
    title: input.title,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate }),
    ...(input.listId === undefined ? {} : { listId: input.listId }),
  };
}

function descriptionFor(plan: TaskPlan): string {
  return `Create task ${plan.title}`;
}

function toTask(plan: TaskPlan): Task {
  return {
    itemId: plan.itemId,
    title: plan.title,
    ...(plan.description === undefined ? {} : { description: plan.description }),
    ...(plan.dueDate === undefined ? {} : { dueDate: plan.dueDate }),
    ...(plan.listId === undefined ? {} : { listId: plan.listId }),
  };
}

async function execute(
  input: CreateTaskInput,
  executionOptions: ActionExecutionOptions,
  writer: TaskWriter | undefined,
): Promise<ActionExecutionResult<TaskPlan>> {
  const options = resolveActionOptions(executionOptions);
  const policy = policyFor("createTask", options);

  let plan: TaskPlan;
  try {
    plan = normalizeInput(input);
  } catch (error: unknown) {
    const fallback = fallbackPlan(input);
    return makeActionResult(
      "createTask",
      input.itemId,
      fallback,
      policy,
      options,
      "rejected",
      "skipped",
      "createTask input was rejected.",
      error instanceof Error ? error.message : "Invalid createTask input.",
    );
  }

  if (!mayExecute(policy, options)) {
    if (options.dryRun) {
      return makeActionResult(
        "createTask",
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
      "createTask",
      plan.itemId,
      plan,
      policy,
      options,
      descriptionFor(plan),
    );
  }

  if (writer === undefined) {
    return makeActionResult(
      "createTask",
      plan.itemId,
      plan,
      policy,
      options,
      "rejected",
      "skipped",
      descriptionFor(plan),
      "No typed task writer was provided.",
    );
  }

  try {
    await writer.createTask(toTask(plan));

    return makeActionResult(
      "createTask",
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
      "createTask",
      plan.itemId,
      plan,
      policy,
      options,
      "rejected",
      "skipped",
      descriptionFor(plan),
      error instanceof Error ? error.message : "Task writer failed.",
    );
  }
}

export function executeCreateTask(
  input: CreateTaskInput,
  options: ActionExecutionOptions,
  writer?: TaskWriter,
): Promise<ActionExecutionResult<TaskPlan>> {
  return execute(input, options, writer);
}

export function createTask(
  request: CreateTaskRequest,
): Promise<ActionExecutionResult<TaskPlan>>;
export function createTask(
  input: CreateTaskInput,
  options: ActionExecutionOptions,
  writer?: TaskWriter,
): Promise<ActionExecutionResult<TaskPlan>>;
export function createTask(
  inputOrRequest: CreateTaskInput | CreateTaskRequest,
  options?: ActionExecutionOptions,
  writer?: TaskWriter,
): Promise<ActionExecutionResult<TaskPlan>> {
  const request = splitRequest(inputOrRequest, options, writer);
  return execute(request.input, request.options, request.writer);
}

export default createTask;
