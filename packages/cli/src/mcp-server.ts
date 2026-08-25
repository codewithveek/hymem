#!/usr/bin/env node
/**
 * hymem MCP server — gives any MCP client (Claude Code, Codex, etc.)
 * persistent, inspectable, temporal memory.
 *
 * Tools:
 *   memory_save    — distill a statement/exchange into facts (with supersession)
 *   memory_recall  — recall with temporal filtering + abstention
 *   memory_list    — browse facts (ClawMem-style inspectability)
 *   memory_forget  — delete facts by id
 *
 * The backing store comes from MEM_STORE (hydradb by default; "memory" needs
 * no services). Run: `npx tsx src/mcp-server.ts`, or add to an MCP config:
 *   { "mcpServers": { "hymem": { "command": "npx", "args": ["tsx", "src/mcp-server.ts"] } } }
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { memoryFromEnv } from "./env.js";

const memory = await memoryFromEnv();
const server = new McpServer({ name: "hymem", version: "0.2.0" });

server.registerTool(
  "memory_save",
  {
    title: "Save to memory",
    description:
      "Store a statement, decision, or preference into durable memory. " +
      "Facts are extracted automatically; if a fact updates an earlier one " +
      "(e.g. the user moved cities), the old value is kept as history via a SUPERSEDES chain. " +
      "Use after the user shares durable information worth remembering across sessions.",
    inputSchema: {
      text: z.string().describe("The statement or exchange to remember, verbatim or summarized"),
      sessionId: z.string().optional().describe("Session identifier; defaults to a timestamped id"),
    },
  },
  async ({ text, sessionId }) => {
    const now = new Date().toISOString();
    const facts = await memory.remember({
      id: sessionId ?? `mcp_${now.replace(/[:.]/g, "-")}`,
      ts: now,
      idx: 0,
      turns: [{ role: "user", content: text }],
    });
    return {
      content: [
        {
          type: "text" as const,
          text: facts.length
            ? `Stored ${facts.length} fact(s):\n` +
              facts.map((fact) => `- ${fact.text} (${fact.id})`).join("\n")
            : "Nothing durable to store from that text.",
        },
      ],
    };
  },
);

server.registerTool(
  "memory_recall",
  {
    title: "Recall from memory",
    description:
      "Retrieve remembered facts relevant to a question, with temporal filtering. " +
      "Handles 'what is X now', 'what was X before', and 'when did X change'. " +
      "Returns an explicit 'not in memory' when nothing supports an answer — do not guess past it. " +
      "Call this BEFORE answering questions about the user's preferences, history, or prior decisions.",
    inputSchema: {
      question: z.string().describe("Natural-language question about remembered context"),
      synthesize: z
        .boolean()
        .optional()
        .describe("If true, also return an LLM-synthesized answer (default: raw facts only)"),
    },
  },
  async ({ question, synthesize }) => {
    if (synthesize) {
      const answered = await memory.ask(question);
      return {
        content: [
          {
            type: "text" as const,
            text: answered.abstained
              ? answered.answer
              : `${answered.answer}\n\nSupporting facts:\n${answered.contextBlock}`,
          },
        ],
      };
    }
    const recalled = await memory.recall(question);
    return {
      content: [
        {
          type: "text" as const,
          text: recalled.abstained
            ? "Not in memory."
            : `Relevant facts (chronological):\n${recalled.contextBlock}`,
        },
      ],
    };
  },
);

server.registerTool(
  "memory_list",
  {
    title: "List memories",
    description:
      "Browse stored facts, optionally filtered by entity name. Every fact is inspectable and traceable to its source session.",
    inputSchema: {
      entity: z.string().optional().describe("Filter to facts about this entity (e.g. 'user')"),
    },
  },
  async ({ entity }) => {
    const facts = await memory.facts(entity);
    const newestFirst = [...facts].reverse().slice(0, 50);
    return {
      content: [
        {
          type: "text" as const,
          text: newestFirst.length
            ? newestFirst
                .map(
                  (fact) =>
                    `[${fact.status}] ${fact.observedAt} · ${fact.text} (id: ${fact.id}, session: ${fact.sessionId})`,
                )
                .join("\n")
            : "No memories stored yet.",
        },
      ],
    };
  },
);

server.registerTool(
  "memory_forget",
  {
    title: "Forget memories",
    description:
      "Permanently delete facts by id (get ids from memory_list). Use when the user asks to forget something.",
    inputSchema: {
      ids: z.array(z.string()).describe("Fact ids to delete"),
    },
  },
  async ({ ids }) => {
    await memory.forget(ids);
    return { content: [{ type: "text" as const, text: `Deleted ${ids.length} fact(s).` }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.on("SIGINT", async () => {
  await memory.close();
  process.exit(0);
});
