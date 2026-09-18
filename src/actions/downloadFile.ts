import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ActionInputError,
  assertDestinationIsAvailable,
  assertExistingRegularFile,
  assertLocalPathDoesNotResolveThroughSymlink,
  makeActionResult,
  mayExecute,
  policyFor,
  requireNonEmptyText,
  resolveActionOptions,
  resolveLocalPath,
  blockedResult,
  type ResolvedActionExecutionOptions,
} from "./common.js";
import type {
  ActionExecutionOptions,
  ActionExecutionResult,
  DownloadFileInput,
  DownloadFilePlan,
  DownloadFileRequest,
} from "./types.js";

function splitRequest(
  inputOrRequest: DownloadFileInput | DownloadFileRequest,
  options: ActionExecutionOptions | undefined,
): { input: DownloadFileInput; options: ActionExecutionOptions } {
  if (options !== undefined) {
    return { input: inputOrRequest, options };
  }

  const request = inputOrRequest as DownloadFileRequest;
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

function fallbackPlan(input: DownloadFileInput): DownloadFilePlan {
  return {
    kind: "downloadFile",
    itemId: input.itemId,
    sourcePath: input.sourcePath,
    destinationPath: input.destinationPath,
  };
}

function normalizeInput(input: DownloadFileInput): DownloadFilePlan {
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
      "downloadFile never overwrites an existing destination.",
    );
  }

  return {
    kind: "downloadFile",
    itemId,
    sourcePath,
    destinationPath,
  };
}

function descriptionFor(plan: DownloadFilePlan): string {
  return `Copy local file ${plan.sourcePath} to ${plan.destinationPath}`;
}

async function execute(
  input: DownloadFileInput,
  executionOptions: ActionExecutionOptions,
): Promise<ActionExecutionResult<DownloadFilePlan>> {
  const options = resolveActionOptions(executionOptions);
  const policy = policyFor("downloadFile", options);

  let plan: DownloadFilePlan;
  try {
    plan = normalizeInput(input);
  } catch (error: unknown) {
    const fallback = fallbackPlan(input);
    return makeActionResult(
      "downloadFile",
      input.itemId,
      fallback,
      policy,
      options,
      "rejected",
      "skipped",
      "downloadFile input was rejected.",
      error instanceof Error ? error.message : "Invalid downloadFile input.",
    );
  }

  if (!mayExecute(policy, options)) {
    if (options.dryRun) {
      return makeActionResult(
        "downloadFile",
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
      "downloadFile",
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

    if (options.dryRun) {
      return makeActionResult(
        "downloadFile",
        plan.itemId,
        plan,
        policy,
        options,
        "planned",
        "skipped",
        descriptionFor(plan),
      );
    }

    await mkdir(dirname(plan.destinationPath), { recursive: true });
    await copyFile(
      plan.sourcePath,
      plan.destinationPath,
      fsConstants.COPYFILE_EXCL,
    );

    return makeActionResult(
      "downloadFile",
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
      "downloadFile",
      plan.itemId,
      plan,
      policy,
      options,
      "rejected",
      "skipped",
      descriptionFor(plan),
      error instanceof Error ? error.message : "downloadFile failed.",
    );
  }
}

export function executeDownloadFile(
  input: DownloadFileInput,
  options: ActionExecutionOptions,
): Promise<ActionExecutionResult<DownloadFilePlan>> {
  return execute(input, options);
}

export function downloadFile(
  request: DownloadFileRequest,
): Promise<ActionExecutionResult<DownloadFilePlan>>;
export function downloadFile(
  input: DownloadFileInput,
  options: ActionExecutionOptions,
): Promise<ActionExecutionResult<DownloadFilePlan>>;
export function downloadFile(
  inputOrRequest: DownloadFileInput | DownloadFileRequest,
  options?: ActionExecutionOptions,
): Promise<ActionExecutionResult<DownloadFilePlan>> {
  const request = splitRequest(inputOrRequest, options);
  return execute(request.input, request.options);
}

export default downloadFile;
