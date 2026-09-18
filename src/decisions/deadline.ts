import type { AgentItem, DeadlineDecision } from "../types/index.js";
import type { DecisionEngine } from "./engine.js";
import { defaultDecisionEngine, getDeadline } from "./helpers.js";

export const detectDeadline = (
  item: AgentItem,
  engine: DecisionEngine = defaultDecisionEngine(),
): Promise<DeadlineDecision> => getDeadline(item, engine);
