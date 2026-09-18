import type { ActionKind, ActionStatus } from "../types/index.js";

/** The only action kinds that this policy layer is allowed to dispatch. */
export const supportedActionKinds = [
  "downloadFile",
  "moveFile",
  "createCalendarEvent",
  "createTask",
] as const satisfies readonly ActionKind[];

export type SupportedActionKind = (typeof supportedActionKinds)[number];

/** Actions that are intentionally outside the Morning Agent action surface. */
export const forbiddenActionKinds = [
  "sendEmail",
  "submitCoursework",
  "deleteFile",
  "changeMoodle",
  "acceptCalendarInvitation",
  "modifyGitHub",
  "executeTerminalCommand",
] as const;

export type ForbiddenActionKind = (typeof forbiddenActionKinds)[number];

export const confidenceThresholds = {
  suggested: 0.75,
  automatic: 0.95,
} as const;

export type ConfidenceBand = "automatic" | "suggested" | "manual_review";

export type PolicyDisposition =
  | "auto_run"
  | "approval_required"
  | "manual_review"
  | "denied";

export type ActionPolicyDecision = {
  kind: ActionKind | null;
  confidence: number;
  band: ConfidenceBand;
  disposition: PolicyDisposition;
  status: ActionStatus;
  canAutoRun: boolean;
  requiresApproval: boolean;
  requiresManualReview: boolean;
  reason: string;
};

const localFileActionKinds: ReadonlySet<ActionKind> = new Set([
  "downloadFile",
  "moveFile",
]);

/** Runtime validation keeps untrusted model/provider output out of dispatch. */
export function isSupportedActionKind(value: unknown): value is ActionKind {
  return (
    typeof value === "string" &&
    (supportedActionKinds as readonly string[]).includes(value)
  );
}

export function isForbiddenActionKind(
  value: unknown,
): value is ForbiddenActionKind {
  return (
    typeof value === "string" &&
    (forbiddenActionKinds as readonly string[]).includes(value)
  );
}

export function isSafeLocalFileAction(
  kind: unknown,
): kind is "downloadFile" | "moveFile" {
  return kind === "downloadFile" || kind === "moveFile";
}

function isValidConfidence(confidence: number): boolean {
  return Number.isFinite(confidence) && confidence >= 0 && confidence <= 1;
}

function displayConfidence(confidence: number): number {
  return Number.isFinite(confidence) ? confidence : 0;
}

export function getConfidenceBand(confidence: number): ConfidenceBand {
  if (!isValidConfidence(confidence) || confidence < confidenceThresholds.suggested) {
    return "manual_review";
  }

  if (confidence >= confidenceThresholds.automatic) {
    return "automatic";
  }

  return "suggested";
}

function invalidKindDecision(
  kind: unknown,
  confidence: number,
): ActionPolicyDecision {
  const forbidden = isForbiddenActionKind(kind);

  return {
    kind: null,
    confidence: displayConfidence(confidence),
    band: "manual_review",
    disposition: "denied",
    status: "manual_review",
    canAutoRun: false,
    requiresApproval: false,
    requiresManualReview: true,
    reason: forbidden
      ? "This action kind is explicitly forbidden."
      : "The action kind is not in the allowlist.",
  };
}

/**
 * Apply the deterministic confidence and action-safety policy.
 *
 * High confidence is only enough for local file actions. Calendar and task
 * mutations always remain approval-gated, even at confidence 1.0.
 */
export function evaluateActionPolicy(
  kind: unknown,
  confidence: number,
): ActionPolicyDecision {
  if (!isSupportedActionKind(kind)) {
    return invalidKindDecision(kind, confidence);
  }

  if (!isValidConfidence(confidence)) {
    return {
      kind,
      confidence: displayConfidence(confidence),
      band: "manual_review",
      disposition: "manual_review",
      status: "manual_review",
      canAutoRun: false,
      requiresApproval: false,
      requiresManualReview: true,
      reason: "Confidence must be a finite number between 0 and 1.",
    };
  }

  const band = getConfidenceBand(confidence);

  if (band === "manual_review") {
    return {
      kind,
      confidence,
      band,
      disposition: "manual_review",
      status: "manual_review",
      canAutoRun: false,
      requiresApproval: false,
      requiresManualReview: true,
      reason: "Confidence is below the approval threshold.",
    };
  }

  if (band === "automatic" && isSafeLocalFileAction(kind)) {
    return {
      kind,
      confidence,
      band,
      disposition: "auto_run",
      status: "completed",
      canAutoRun: true,
      requiresApproval: false,
      requiresManualReview: false,
      reason: "High-confidence local file action may run automatically.",
    };
  }

  return {
    kind,
    confidence,
    band,
    disposition: "approval_required",
    status: "suggested",
    canAutoRun: false,
    requiresApproval: true,
    requiresManualReview: false,
    reason: isSafeLocalFileAction(kind)
      ? "The action is suggested until explicit approval is provided."
      : "Non-file mutations always require explicit approval.",
  };
}

export function canExecuteWithPolicy(
  decision: ActionPolicyDecision,
  approvalGranted: boolean,
): boolean {
  if (decision.disposition === "auto_run") {
    return true;
  }

  return decision.disposition === "approval_required" && approvalGranted;
}
