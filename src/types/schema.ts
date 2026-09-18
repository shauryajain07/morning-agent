import { z } from "zod";

import { agentSources } from "./index.js";
import type { AgentItem } from "./index.js";

export const agentItemSchema = z.object({
  id: z.string().min(1),
  source: z.enum(agentSources),
  title: z.string().min(1),
  content: z.string().optional(),
  url: z.string().url().optional(),
  createdAt: z.coerce.date().optional(),
  deadline: z.coerce.date().optional(),
  metadata: z.record(z.unknown()),
});

export const parseAgentItem = (input: unknown): AgentItem => agentItemSchema.parse(input);

export const parseAgentItems = (input: unknown): AgentItem[] =>
  z.array(agentItemSchema).parse(input);
