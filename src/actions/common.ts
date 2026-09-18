import { randomUUID } from "node:crypto";
import { lstat, stat } from "node:fs/promises";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  parse,
  resolve,
} from "node:path";
import type { ActionKind, ActionRecord, ActionStatus } from "../types/index.js";
import {
  canExecuteWithPolicy,
  evaluateActionPolicy,
  type ActionPolicyDecision,
} from "../policy/index.js";
import type {
  ActionExecutionOptions,
  ActionExecutionOutcome,
  ActionExecutionResult,
  ActionPlan,
} from "./types.js";

export type ResolvedActionExecutionOptions = {
  confidence: number;
  dryRun: boolean;
  approvalGranted: boolean;
  actionId: string;
  now: Date;
};

export class ActionInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ActionInputError";
  }
}

export function resolveActionOptions(
  options: ActionExecutionOptions,
): ResolvedActionExecutionOptions {
  const actionId = options.actionId?.trim();

  return {
    confidence: options.confidence,
    dryRun: options.dryRun ?? false,
    approvalGranted: options.approvalGranted ?? false,
    actionId: actionId || randomUUID(),
    now: options.now ? new Date(options.now.getTime()) : new Date(),
  };
}

export function requireNonEmptyText(
  value: string,
  fieldName: string,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    throw new ActionInputError(`${fieldName} must be a string.`);
  }

  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new ActionInputError(`${fieldName} must not be empty.`);
  }

  if (normalized.length > maxLength) {
    throw new ActionInputError(`${fieldName} is too long.`);
  }

  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new ActionInputError(`${fieldName} contains control characters.`);
  }

  return normalized;
}

/** Resolve only local absolute paths or paths rooted at the user's home. */
export function resolveLocalPath(value: string, fieldName: string): string {
  const normalized = requireNonEmptyText(value, fieldName, 4096);

  if (normalized.includes("\\")) {
    throw new ActionInputError(`${fieldName} must use a macOS path.`);
  }

  if (/^[a-z][a-z\d+.-]*:/iu.test(normalized)) {
    throw new ActionInputError(`${fieldName} must be a local path, not a URL.`);
  }

  const expanded = normalized === "~"
    ? homedir()
    : normalized.startsWith("~/")
      ? resolve(homedir(), normalized.slice(2))
      : normalized;

  if (!isAbsolute(expanded)) {
    throw new ActionInputError(
      `${fieldName} must be absolute or begin with ~/ .`,
    );
  }

  const resolved = resolve(expanded);

  if (resolved === parse(resolved).root) {
    throw new ActionInputError(`${fieldName} must identify a file path.`);
  }

  return resolved;
}

export async function assertExistingRegularFile(
  filePath: string,
  fieldName: string,
): Promise<void> {
  const metadata = await lstat(filePath);

  if (metadata.isSymbolicLink()) {
    throw new ActionInputError(`${fieldName} must not be a symbolic link.`);
  }

  if (!metadata.isFile()) {
    throw new ActionInputError(`${fieldName} must be a regular file.`);
  }
}

export async function assertDestinationIsAvailable(
  filePath: string,
  fieldName: string,
): Promise<void> {
  try {
    const metadata = await lstat(filePath);

    if (metadata.isSymbolicLink()) {
      throw new ActionInputError(`${fieldName} must not be a symbolic link.`);
    }

    throw new ActionInputError(`${fieldName} already exists.`);
  } catch (error: unknown) {
    if (error instanceof ActionInputError) {
      throw error;
    }

    if (isMissingPathError(error)) {
      return;
    }

    throw error;
  }
}

export async function assertDestinationParentDirectory(
  filePath: string,
  fieldName: string,
): Promise<void> {
  const parentPath = dirname(filePath);
  const metadata = await stat(parentPath);

  if (!metadata.isDirectory()) {
    throw new ActionInputError(`${fieldName} parent must be a directory.`);
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export async function assertLocalPathDoesNotResolveThroughSymlink(
  filePath: string,
  fieldName: string,
): Promise<void> {
  try {
    const metadata = await lstat(filePath);
    if (metadata.isSymbolicLink()) {
      throw new ActionInputError(
        `${fieldName} must not be a symbolic link.`,
      );
    }
  } catch (error: unknown) {
    if (error instanceof ActionInputError || !isMissingPathError(error)) {
      throw error;
    }
  }
}

export function makeActionRecord(
  kind: ActionKind,
  itemId: string,
  status: ActionStatus,
  description: string,
  options: ResolvedActionExecutionOptions,
): ActionRecord {
  return {
    id: options.actionId,
    kind,
    itemId,
    status,
    description,
    createdAt: new Date(options.now.getTime()),
  };
}

export function makeActionResult<P extends ActionPlan>(
  kind: ActionKind,
  itemId: string,
  plan: P,
  policy: ActionPolicyDecision,
  options: ResolvedActionExecutionOptions,
  outcome: ActionExecutionOutcome,
  status: ActionStatus,
  description: string,
  error?: string,
): ActionExecutionResult<P> {
  const record = makeActionRecord(
    kind,
    itemId,
    status,
    description,
    options,
  );

  const result: ActionExecutionResult<P> = {
    kind,
    itemId,
    outcome,
    status,
    dryRun: options.dryRun,
    policy,
    record,
    plan,
  };

  if (error !== undefined) {
    result.error = error;
  }

  return result;
}

export function policyFor(
  kind: ActionKind,
  options: ResolvedActionExecutionOptions,
): ActionPolicyDecision {
  return evaluateActionPolicy(kind, options.confidence);
}

export function mayExecute(
  policy: ActionPolicyDecision,
  options: ResolvedActionExecutionOptions,
): boolean {
  return !options.dryRun && canExecuteWithPolicy(policy, options.approvalGranted);
}

export function blockedResult<P extends ActionPlan>(
  kind: ActionKind,
  itemId: string,
  plan: P,
  policy: ActionPolicyDecision,
  options: ResolvedActionExecutionOptions,
  description: string,
): ActionExecutionResult<P> {
  const requiresApproval = policy.disposition === "approval_required";

  return makeActionResult(
    kind,
    itemId,
    plan,
    policy,
    options,
    requiresApproval ? "requires_approval" : "manual_review",
    policy.status,
    description,
    policy.reason,
  );
}
