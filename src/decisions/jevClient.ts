import {
  choice,
  noul,
  score,
  TypeSafeClient,
  type EntryType,
  type Questions,
  type SystemOneResult,
} from "@typesafe-ai/sdk";

export { choice, noul, score };

export const JEV_MODEL = "jev-latest" as const;

export type JevState = EntryType;
export type JevQuestionSet = Questions;
export type JevEvaluation<Q extends Questions> = SystemOneResult<Q>;
export type JevAnswers<Q extends Questions> = JevEvaluation<Q>["answers"];

export interface JevClientOptions {
  readonly apiKey?: string;
}

export interface JevEvaluator {
  evaluate<const Q extends Questions>(
    state: JevState,
    questions: Q,
  ): Promise<JevEvaluation<Q>>;
}

export class JevConfigurationError extends Error {
  public constructor() {
    super(
      "TYPESAFE_API_KEY is required to evaluate Jev decisions. Set it in the environment or pass apiKey to JevClient.",
    );
    this.name = "JevConfigurationError";
  }
}

export class JevClient implements JevEvaluator {
  private readonly configuredApiKey: string | undefined;
  private sdkClient: TypeSafeClient | undefined;

  public constructor(options: JevClientOptions = {}) {
    this.configuredApiKey = options.apiKey;
  }

  public async evaluate<const Q extends Questions>(
    state: JevState,
    questions: Q,
  ): Promise<JevEvaluation<Q>> {
    return this.getSdkClient().systemOne({
      state,
      questions,
      model: JEV_MODEL,
    });
  }

  private getSdkClient(): TypeSafeClient {
    if (this.sdkClient !== undefined) {
      return this.sdkClient;
    }

    const apiKey = this.resolveApiKey();
    if (apiKey === undefined) {
      throw new JevConfigurationError();
    }

    this.sdkClient = new TypeSafeClient({
      apiKey,
      defaultModel: JEV_MODEL,
    });
    return this.sdkClient;
  }

  private resolveApiKey(): string | undefined {
    const configuredKey = this.configuredApiKey ?? process.env.TYPESAFE_API_KEY;
    const trimmedKey = configuredKey?.trim();
    return trimmedKey === undefined || trimmedKey.length === 0
      ? undefined
      : trimmedKey;
  }
}
