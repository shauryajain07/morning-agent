import type { AgentItem, ImportantEmailDecision } from "../types/index.js";
import type { DecisionEngine } from "./engine.js";
import { defaultDecisionEngine, getImportantEmail } from "./helpers.js";

export const importantEmail = (
  email: AgentItem,
  engine: DecisionEngine = defaultDecisionEngine(),
): Promise<ImportantEmailDecision> => getImportantEmail(email, engine);
