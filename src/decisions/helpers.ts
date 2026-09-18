import type {
  AgentItem,
  CalendarActionDecision,
  DeadlineDecision,
  FileDownloadDecision,
  ImportantEmailDecision,
  RequiresActionDecision,
} from "../types/index.js";
import type { DecisionEngine } from "./engine.js";
import { JevDecisionEngine } from "./engine.js";

export const defaultDecisionEngine = (): DecisionEngine => new JevDecisionEngine();

const decisionOutput = async (
  item: AgentItem,
  name: string,
  engine: DecisionEngine,
): Promise<unknown> => {
  const result = (await engine.evaluateItem(item)).find((entry) => entry.decision === name);
  if (result === undefined) throw new Error(`Decision ${name} was not returned for ${item.id}`);
  return result.output;
};

export const getRequiresAction = async (
  item: AgentItem,
  engine: DecisionEngine,
): Promise<RequiresActionDecision> => {
  const output = await decisionOutput(item, "requiresAction", engine);
  if (!("actionRequired" in (output as object))) throw new Error("Invalid requiresAction output");
  return output as RequiresActionDecision;
};

export const getImportantEmail = async (
  item: AgentItem,
  engine: DecisionEngine,
): Promise<ImportantEmailDecision> => {
  const output = await decisionOutput(item, "importantEmail", engine);
  if (!("important" in (output as object))) throw new Error("Invalid importantEmail output");
  return output as ImportantEmailDecision;
};

export const getDeadline = async (
  item: AgentItem,
  engine: DecisionEngine,
): Promise<DeadlineDecision> => {
  const output = await decisionOutput(item, "detectDeadline", engine);
  if (!("hasDeadline" in (output as object))) throw new Error("Invalid detectDeadline output");
  return output as DeadlineDecision;
};

export const getFileDownload = async (
  item: AgentItem,
  engine: DecisionEngine,
): Promise<FileDownloadDecision> => {
  const output = await decisionOutput(item, "shouldDownloadFile", engine);
  if (!("download" in (output as object))) throw new Error("Invalid shouldDownloadFile output");
  return output as FileDownloadDecision;
};

export const getCalendarAction = async (
  item: AgentItem,
  engine: DecisionEngine,
): Promise<CalendarActionDecision> => {
  const output = await decisionOutput(item, "shouldCreateCalendarEvent", engine);
  if (!("createEvent" in (output as object))) throw new Error("Invalid shouldCreateCalendarEvent output");
  return output as CalendarActionDecision;
};
