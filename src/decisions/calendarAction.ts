import type { AgentItem, CalendarActionDecision } from "../types/index.js";
import type { DecisionEngine } from "./engine.js";
import { defaultDecisionEngine, getCalendarAction } from "./helpers.js";

export const shouldCreateCalendarEvent = (
  item: AgentItem,
  engine: DecisionEngine = defaultDecisionEngine(),
): Promise<CalendarActionDecision> => getCalendarAction(item, engine);
