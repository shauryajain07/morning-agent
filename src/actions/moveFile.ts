import { rename } from "node:fs/promises";
import {
  ActionInputError,
  assertDestinationIsAvailable,
  assertDestinationParentDirectory,
  assertExistingRegularFile,
  assertLocalPathDoesNotResolveThroughSymlink,
  blockedResult,
  makeActionResult,
  mayExecute,
  policyFor,
  requireNonEmptyText,
  resolveActionOptions,
  resolveLocalPath,
} from "./common.js";
import type {
  ActionExecutionOptions,
  ActionExecutionResult,
  MoveFileInput,
  MoveFilePlan,
  MoveFileRequest,
} from "./types.js";

function splitRequest(
  inputOrRequest: MoveFileInput | MoveFileRequest,
  options: ActionExecutionOptions | undefined,
): { input: MoveFileInput; options: ActionExecutionOptions } {
  if (options !== undefined) {
    return { input: inputOrRequest, options };
  }

  const request = inputOrRequest as MoveFileRequest;
  return {
    input: {
      itemId: request.itemId,
      sourcePath: request.sourcePath,
      destinationPath: request.destinationPath,
      ...(request.overwrite === undefined
        ? {}
        : { overwrite: request.overwrite }),
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
  };
}

function fallbackPlan(input: MoveFileInput): MoveFilePlan {
  return {
    kind: "moveFile",
    itemId: input.itemId,
    sourcePath: input.sourcePath,
    destinationPath: input.destinationPath,
  };
}

function normalizeInput(input: MoveFileInput): MoveFilePlan {
  const itemId = requireNonEmptyText(input.itemId, "itemId", 512);
  const sourcePath = resolveLocalPath(input.sourcePath, "sourcePath");
  const destinationPath = resolveLocalPath(
    input.destinationPath,
    "destinationPath",
  );

  if (sourcePath === destinationPath) {
    throw new ActionInputError("sourcePath and destinationPath must differ.");
  }

  if (input.overwrite === true) {
    throw new ActionInputError(
      "moveFile never overwrites an existing destination.",
    );
  }

  return {
    kind: "moveFile",
    itemId,
    sourcePath,
    destinationPath,
  };
}

function descriptionFor(plan: MoveFilePlan): string {
  return `Move local file ${plan.sourcePath} to ${plan.destinationPath}`;
}

async function execute(
  input: MoveFileInput,
  executionOptions: ActionExecutionOptions,
): Promise<ActionExecutionResult<MoveFilePlan>> {
  const options = resolveActionOptions(executionOptions);
  const policy = policyFor("moveFile", options);

  let plan: MoveFilePlan;
  try {
    plan = normalizeInput(input);
  } catch (error: unknown) {
    const fallback = fallbackPlan(input);
    return makeActionResult(
      "moveFile",
      input.itemId,
      fallback,
      policy,
      options,
      "rejected",
      "skipped",
      "moveFile input was rejected.",
      error instanceof Error ? error.message : "Invalid moveFile input.",
    );
  }

  if (!mayExecute(policy, options)) {
    if (options.dryRun) {
      return makeActionResult(
        "moveFile",
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
      "moveFile",
      plan.itemId,
      plan,
      policy,
      options,
      descriptionFor(plan),
    );
  }

  try {
    await assertExistingRegularFile(plan.sourcePath, "sourcePath");
    await assertLocalPathDoesNotResolveThroughSymlink(
      plan.destinationPath,
      "destinationPath",
    );
    await assertDestinationIsAvailable(plan.destinationPath, "destinationPath");
    await assertDestinationParentDirectory(plan.destinationPath, "destinationPath");

    if (options.dryRun) {
      return makeActionResult(
        "moveFile",
        plan.itemId,
        plan,
        policy,
        options,
        "planned",
        "skipped",
        descriptionFor(plan),
      );
    }

    await rename(plan.sourcePath, plan.destinationPath);

    return makeActionResult(
      "moveFile",
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
      "moveFile",
      plan.itemId,
      plan,
      policy,
      options,
      "rejected",
      "skipped",
      descriptionFor(plan),
      error instanceof Error ? error.message : "moveFile failed.",
    );
  }
}

export function executeMoveFile(
  input: MoveFileInput,
  options: ActionExecutionOptions,
): Promise<ActionExecutionResult<MoveFilePlan>> {
  return execute(input, options);
}

export function moveFile(
  request: MoveFileRequest,
): Promise<ActionExecutionResult<MoveFilePlan>>;
export function moveFile(
  input: MoveFileInput,
  options: ActionExecutionOptions,
): Promise<ActionExecutionResult<MoveFilePlan>>;
export function moveFile(
  inputOrRequest: MoveFileInput | MoveFileRequest,
  options?: ActionExecutionOptions,
): Promise<ActionExecutionResult<MoveFilePlan>> {
  const request = splitRequest(inputOrRequest, options);
  return execute(request.input, request.options);
}

export default moveFile;
