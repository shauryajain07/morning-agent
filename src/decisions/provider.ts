import type { Questions } from "@typesafe-ai/sdk";

import { JevClient, type JevEvaluation, type JevEvaluator, type JevState } from "./jevClient.js";
import {
  LayaMlxClient,
  type LayaMlxClientOptions,
} from "./layaMlxClient.js";

const environmentBoolean = (name: string, fallback: boolean): boolean => {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value.length === 0) return fallback;
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  throw new Error(`${name} must be true or false`);
};

const environmentInteger = (name: string, fallback: number): number => {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
};

export const layaMlxEnabled = (): boolean => environmentBoolean("LAYA_MLX_ENABLED", false);

export const layaMlxOptionsFromEnvironment = (): LayaMlxClientOptions => ({
  ...(process.env.LAYA_MLX_PYTHON?.trim() ? { pythonPath: process.env.LAYA_MLX_PYTHON.trim() } : {}),
  ...(process.env.LAYA_MLX_CHECKOUT?.trim() ? { checkoutPath: process.env.LAYA_MLX_CHECKOUT.trim() } : {}),
  ...(process.env.LAYA_MLX_MODEL?.trim() ? { model: process.env.LAYA_MLX_MODEL.trim() } : {}),
  ...(process.env.LAYA_MLX_DTYPE?.trim()
    ? {
        dtype: process.env.LAYA_MLX_DTYPE.trim() as Exclude<
          LayaMlxClientOptions["dtype"],
          undefined
        >,
      }
    : {}),
  ...(process.env.LAYA_MLX_DEVICE?.trim()
    ? {
        device: process.env.LAYA_MLX_DEVICE.trim() as Exclude<
          LayaMlxClientOptions["device"],
          undefined
        >,
      }
    : {}),
  batchSize: environmentInteger("LAYA_MLX_BATCH_SIZE", 16),
});

class FallbackDecisionEvaluator implements JevEvaluator {
  public constructor(
    private readonly primary: JevEvaluator,
    private readonly fallback: JevEvaluator,
  ) {}

  public async evaluate<const Q extends Questions>(
    state: JevState,
    questions: Q,
  ): Promise<JevEvaluation<Q>> {
    try {
      return await this.primary.evaluate(state, questions);
    } catch (error: unknown) {
      console.warn(
        `Laya-MLX decision failed; falling back to TypeSafe Jev: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.fallback.evaluate(state, questions);
    }
  }

  public async close(): Promise<void> {
    await this.primary.close?.();
    await this.fallback.close?.();
  }
}

export const createDecisionEvaluator = (): JevEvaluator => {
  if (!layaMlxEnabled()) return new JevClient();
  const laya = new LayaMlxClient(layaMlxOptionsFromEnvironment());
  return environmentBoolean("LAYA_MLX_FALLBACK_TO_TYPESAFE", false)
    ? new FallbackDecisionEvaluator(laya, new JevClient())
    : laya;
};
