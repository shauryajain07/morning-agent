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

export const parseAgentItem = (input: unknown): AgentItem => {
  const parsed = agentItemSchema.parse(input);
  return {
    id: parsed.id,
    source: parsed.source,
    title: parsed.title,
    metadata: parsed.metadata,
    ...(parsed.content === undefined ? {} : { content: parsed.content }),
    ...(parsed.url === undefined ? {} : { url: parsed.url }),
    ...(parsed.createdAt === undefined ? {} : { createdAt: parsed.createdAt }),
    ...(parsed.deadline === undefined ? {} : { deadline: parsed.deadline }),
  };
};

export const parseAgentItems = (input: unknown): AgentItem[] => {
  const parsed = z.array(agentItemSchema).parse(input);
  return parsed.map((item) => parseAgentItem(item));
};
