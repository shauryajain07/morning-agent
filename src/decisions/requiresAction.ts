import type { AgentItem, RequiresActionDecision } from "../types/index.js";
import type { DecisionEngine } from "./engine.js";
import { defaultDecisionEngine, getRequiresAction } from "./helpers.js";

export const requiresAction = (
  item: AgentItem,
  engine: DecisionEngine = defaultDecisionEngine(),
): Promise<RequiresActionDecision> => getRequiresAction(item, engine);
