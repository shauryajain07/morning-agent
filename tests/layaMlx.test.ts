import { describe, expect, it, vi } from "vitest";

import { choice, noul, score, type JevEvaluator } from "../src/decisions/jevClient.js";
import {
  LayaMlxClient,
  type LayaMlxResult,
  type LayaMlxRuntimeLoader,
} from "../src/decisions/layaMlxClient.js";
import { JevDecisionEngine } from "../src/decisions/engine.js";
import type { AgentItem } from "../src/types/index.js";

const exampleQuestions = {
  department: choice("Which department should handle this request?", {
    billing: "invoices, payments, and refunds",
    technical: "bugs and outages",
    sales: "new purchases",
    other: "everything else",
  }),
  refund: noul("Does the customer ask for money back?"),
  urgency: score("How urgent is this request?", [
    "not urgent",
    "soon",
    "critical deadline or blocking issue",
  ] as const),
};

const exampleResult: LayaMlxResult = {
  model: "laya-rl-agent",
  answers: {
    department: {
      type: "choice",
      choice: "billing",
      confidence: 0.84,
      probabilities: { billing: 0.96, technical: 0.01, sales: 0.01, other: 0.02 },
    },
    refund: {
      type: "noul",
      noul: 0.81,
      confidence: 0.81,
    },
    urgency: {
      type: "score",
      score: 1.41,
      confidence: 0.15,
      legend: { "0": "not urgent", "1": "soon", "2": "critical deadline or blocking issue" },
      probabilities: { "0": 0.1, "1": 0.39, "2": 0.51 },
    },
  },
  usage: { input_tokens: 100, output_tokens: 0 },
};

describe("Laya-MLX decision provider", () => {
  it("loads the runtime once and preserves typed answer contracts", async () => {
    const runtime = {
      predict: vi.fn(async () => exampleResult),
    };
    const loader: LayaMlxRuntimeLoader = { load: vi.fn(async () => runtime) };
    const client = new LayaMlxClient({ loader });

    const [first, second] = await Promise.all([
      client.evaluate("We were billed twice. Please refund the duplicate today.", exampleQuestions),
      client.evaluate("We were billed twice. Please refund the duplicate today.", exampleQuestions),
    ]);

    expect(loader.load).toHaveBeenCalledTimes(1);
    expect(runtime.predict).toHaveBeenCalledTimes(2);
    expect(first.answers.department.choice).toBe("billing");
    expect(first.answers.refund.noul).toBeGreaterThan(0.8);
    expect(first.answers.urgency.score).toBeGreaterThanOrEqual(0);
    expect(first.answers.urgency.score).toBeLessThanOrEqual(2);
    expect(second.answers.department.choice).toBe("billing");
    await client.close();
  });

  it("maps the urgency score back to the existing application label", async () => {
    const item: AgentItem = {
      id: "email:duplicate-charge",
      source: "email",
      title: "Duplicate charge",
      content: "We were billed twice. Please refund the duplicate today.",
      metadata: {},
    };
    const evaluate = vi.fn(async (_state: unknown, questions: Record<string, { type: string }>) => {
      expect(questions.urgency?.type).toBe("score");
      return {
        model: "laya-rl-agent",
        answers: {
          actionRequired: { type: "noul", noul: 0.98 },
          urgency: {
            type: "score",
            score: 1.2,
            confidence: 0.7,
            probabilities: { "0": 0.05, "1": 0.8, "2": 0.1, "3": 0.05 },
            legend: { "0": "today", "1": "soon", "2": "later", "3": "none" },
          },
          important: { type: "noul", noul: 0.9 },
          emailCategory: { type: "choice", choice: "personal", confidence: 0.8 },
          requiresReply: { type: "noul", noul: 0.1 },
          hasDeadline: { type: "noul", noul: 0.1 },
        },
        usage: { input_tokens: 1, output_tokens: 0 },
      };
    });
    const engine = new JevDecisionEngine({ evaluate } as unknown as JevEvaluator);

    const decision = (await engine.evaluateItem(item)).find(
      (entry) => entry.decision === "requiresAction",
    );

    expect(decision?.output).toMatchObject({ actionRequired: true, urgency: "soon" });
  });

  it.skipIf(process.env.LAYA_MLX_INTEGRATION !== "true")(
    "runs the duplicate-billing example against the cached local model",
    async () => {
      const client = new LayaMlxClient();
      try {
        const result = await client.evaluate(
          "We were billed twice. Please refund the duplicate today.",
          exampleQuestions,
        );
        expect(result.answers.department.choice).toBe("billing");
        expect(result.answers.refund.noul).toBeGreaterThan(0.7);
        expect(result.answers.urgency.score).toBeGreaterThanOrEqual(0);
        expect(result.answers.urgency.score).toBeLessThanOrEqual(2);
      } finally {
        await client.close();
      }
    },
  );
});
