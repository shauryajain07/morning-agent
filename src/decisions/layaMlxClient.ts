import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

import type { EntryType, Questions } from "@typesafe-ai/sdk";

import type {
  JevEvaluation,
  JevEvaluator,
  JevState,
} from "./jevClient.js";

export const LAYA_MLX_MODEL = "aac6fef/laya-mlx" as const;

type LayaMlxAnswer = {
  readonly type: "choice" | "score" | "noul";
  readonly [key: string]: unknown;
};

export type LayaMlxResult = {
  readonly model: string;
  readonly answers: Readonly<Record<string, LayaMlxAnswer>>;
  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
  };
};

export interface LayaMlxRuntime {
  predict(state: JevState, questions: Questions): Promise<LayaMlxResult>;
  close?(): Promise<void>;
}

export interface LayaMlxRuntimeLoader {
  load(): Promise<LayaMlxRuntime>;
}

export type LayaMlxClientOptions = Readonly<{
  loader?: LayaMlxRuntimeLoader;
  pythonPath?: string;
  checkoutPath?: string;
  model?: string;
  dtype?: "float16" | "float32" | "bfloat16";
  device?: "gpu" | "cpu";
  batchSize?: number;
}>;

export type PythonLayaMlxRuntimeOptions = Readonly<{
  pythonPath?: string;
  checkoutPath?: string;
  model?: string;
  dtype?: "float16" | "float32" | "bfloat16";
  device?: "gpu" | "cpu";
  batchSize?: number;
}>;

const PYTHON_WORKER = String.raw`
import json
import os
import sys
import traceback

import laya_mlx as laya


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


try:
    agent = laya.load(
        os.environ["LAYA_MLX_MODEL"],
        dtype=os.environ["LAYA_MLX_DTYPE"],
        device=os.environ["LAYA_MLX_DEVICE"],
        batch_size=int(os.environ["LAYA_MLX_BATCH_SIZE"]),
    )
    emit({"ready": True, "model": getattr(agent, "model_id", "laya-mlx")})
except Exception as error:
    emit({
        "ready": False,
        "error": str(error),
        "traceback": traceback.format_exc(limit=5),
    })
    raise


for line in sys.stdin:
    request = None
    try:
        request = json.loads(line)
        result = agent.predict(request["state"], request["questions"])
        emit({"id": request["id"], "result": result})
    except Exception as error:
        emit({
            "id": request.get("id") if isinstance(request, dict) else None,
            "error": str(error),
            "traceback": traceback.format_exc(limit=5),
        })
`;

type WorkerMessage = Readonly<Record<string, unknown>>;

type PendingRequest = {
  readonly resolve: (result: LayaMlxResult) => void;
  readonly reject: (error: Error) => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const workerError = (message: string, stderr: string): Error => {
  const suffix = stderr.trim().length === 0 ? "" : ` (${stderr.trim().slice(-2_000)})`;
  return new Error(`Laya-MLX worker failed: ${message}${suffix}`);
};

class PythonLayaMlxRuntime implements LayaMlxRuntime {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly lines: Interface;
  private readonly stderrChunks: string[] = [];
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private nextRequestId = 0;
  private ready = false;
  private closing = false;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrChunks.push(String(chunk));
      while (this.stderrChunks.join("").length > 8_000) this.stderrChunks.shift();
    });
    child.on("error", (error) => this.fail(error));
    child.on("close", (code, signal) => {
      if (this.closing) return;
      this.fail(workerError(`exited with code ${code ?? "null"}${signal === null ? "" : ` (${signal})`}`, this.stderr()));
    });
  }

  public static async start(options: PythonLayaMlxRuntimeOptions): Promise<LayaMlxRuntime> {
    const checkoutPath = options.checkoutPath?.trim();
    const pythonPath = options.pythonPath?.trim();
    if (!checkoutPath) {
      throw new Error("LAYA_MLX_CHECKOUT must point to your local laya-mlx checkout");
    }
    if (!pythonPath) {
      throw new Error("LAYA_MLX_PYTHON must point to the Python environment for laya-mlx");
    }
    const model = options.model ?? LAYA_MLX_MODEL;
    const dtype = options.dtype ?? "float16";
    const device = options.device ?? "gpu";
    const batchSize = options.batchSize ?? 16;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error("LAYA_MLX_BATCH_SIZE must be a positive integer");
    }

    const child = spawn(pythonPath, ["-u", "-c", PYTHON_WORKER], {
      cwd: checkoutPath,
      env: {
        ...process.env,
        LAYA_MLX_MODEL: model,
        LAYA_MLX_DTYPE: dtype,
        LAYA_MLX_DEVICE: device,
        LAYA_MLX_BATCH_SIZE: String(batchSize),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const runtime = new PythonLayaMlxRuntime(child);
    try {
      await runtime.readyPromise;
      return runtime;
    } catch (error: unknown) {
      await runtime.close();
      throw error;
    }
  }

  public async predict(state: JevState, questions: Questions): Promise<LayaMlxResult> {
    await this.readyPromise;
    if (this.closing) throw new Error("Laya-MLX runtime is closed");
    const id = String(++this.nextRequestId);
    return new Promise<LayaMlxResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.child.stdin.write(JSON.stringify({ id, state, questions }) + "\n", "utf8", (error) => {
          if (error === undefined || error === null) return;
          this.pending.delete(id);
          reject(error);
        });
      } catch (error: unknown) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  public async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.lines.close();
    const error = new Error("Laya-MLX runtime closed");
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.child.kill("SIGTERM");
        finish();
      }, 1_000);
      this.child.once("close", finish);
      this.child.stdin.end();
    });
  }

  private handleLine(line: string): void {
    if (line.trim().length === 0) return;
    let message: WorkerMessage;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) throw new Error("worker message was not an object");
      message = parsed;
    } catch (error: unknown) {
      this.fail(workerError(error instanceof Error ? error.message : String(error), this.stderr()));
      return;
    }

    if (message.ready === true) {
      this.ready = true;
      this.resolveReady();
      return;
    }
    if (message.ready === false) {
      this.fail(workerError(String(message.error ?? "model load failed"), this.stderr()));
      return;
    }

    const id = typeof message.id === "string" ? message.id : undefined;
    if (id === undefined) {
      this.fail(workerError("response did not include a request id", this.stderr()));
      return;
    }
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    if (typeof message.error === "string") {
      pending.reject(workerError(message.error, this.stderr()));
      return;
    }
    pending.resolve(message.result as LayaMlxResult);
  }

  private fail(error: Error): void {
    if (!this.ready) this.rejectReady(error);
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private stderr(): string {
    return this.stderrChunks.join("");
  }
}

export class PythonLayaMlxRuntimeLoader implements LayaMlxRuntimeLoader {
  public constructor(private readonly options: PythonLayaMlxRuntimeOptions = {}) {}

  public load(): Promise<LayaMlxRuntime> {
    return PythonLayaMlxRuntime.start(this.options);
  }
}

const normalizeResult = <const Q extends Questions>(
  result: LayaMlxResult,
  questions: Q,
): JevEvaluation<Q> => {
  if (typeof result.model !== "string" || !isRecord(result.answers)) {
    throw new Error("Laya-MLX returned an invalid typed-decision result");
  }
  const answers: Record<string, LayaMlxAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = result.answers[id];
    if (!isRecord(answer) || answer.type !== question.type) {
      throw new Error(`Laya-MLX returned an invalid ${id} answer`);
    }
    answers[id] = answer as LayaMlxAnswer;
  }
  if (
    !isRecord(result.usage) ||
    typeof result.usage.input_tokens !== "number" ||
    typeof result.usage.output_tokens !== "number"
  ) {
    throw new Error("Laya-MLX returned invalid usage metadata");
  }
  return {
    model: result.model,
    answers: answers as unknown as JevEvaluation<Q>["answers"],
    usage: result.usage,
  };
};

export class LayaMlxClient implements JevEvaluator {
  private readonly loader: LayaMlxRuntimeLoader;
  private runtimePromise: Promise<LayaMlxRuntime> | undefined;

  public constructor(options: LayaMlxClientOptions = {}) {
    this.loader = options.loader ?? new PythonLayaMlxRuntimeLoader(options);
  }

  public async evaluate<const Q extends Questions>(
    state: EntryType,
    questions: Q,
  ): Promise<JevEvaluation<Q>> {
    const runtime = await this.getRuntime();
    return normalizeResult(await runtime.predict(state, questions), questions);
  }

  public async close(): Promise<void> {
    const runtimePromise = this.runtimePromise;
    if (runtimePromise === undefined) return;
    await runtimePromise.then(
      async (runtime) => runtime.close?.(),
      () => undefined,
    );
  }

  private getRuntime(): Promise<LayaMlxRuntime> {
    this.runtimePromise ??= this.loader.load();
    return this.runtimePromise;
  }
}
