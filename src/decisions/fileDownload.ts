import type { AgentItem, FileDownloadDecision } from "../types/index.js";
import type { DecisionEngine } from "./engine.js";
import { defaultDecisionEngine, getFileDownload } from "./helpers.js";

export const shouldDownloadFile = (
  item: AgentItem,
  engine: DecisionEngine = defaultDecisionEngine(),
): Promise<FileDownloadDecision> => getFileDownload(item, engine);
