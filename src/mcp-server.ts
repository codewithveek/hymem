#!/usr/bin/env node
/**
 * hymem MCP server — gives any MCP client (Claude Code, Codex, etc.)
 * persistent, inspectable, temporal memory backed by the HydraDB graph engine.
 *
 * Tools:
 *   memory_save    — distill a statement/exchange into graph facts (with supersession)
 *   memory_recall  — traversal-based recall with temporal filtering + abstention
 *   memory_list    — browse facts (ClawMem-style inspectability)
 *   memory_forget  — delete facts by id
 *
 * Run: `npx tsx src/mcp-server.ts`, or add to an MCP config:
 *   { "mcpServers": { "hymem": { "command": "npx", "args": ["tsx", "src/mcp-server.ts"] } } }
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ingestSession } from "./ingest.js";
import { recall } from "./retrieve.js";
import { answer } from "./answer.js";
import { cypher, closeHydra } from "./hydra.js";

const server = new McpServer({ name: "hymem", version: "0.1.0" });

server.registerTool(
  "memory_save",
  {
    title: "Save to memory",
    description:
      "Store a statement, decision, or preference into durable graph memory. " +
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
    const sid = sessionId ?? `mcp_${now.replace(/[:.]/g, "-")}`;
    const facts = await ingestSession({
      id: sid,
      ts: now,
      idx: 0,
      turns: [{ role: "user", content: text }],
    });
    return {
      content: [{
        type: "text" as const,
        text: facts.length
          ? `Stored ${facts.length} fact(s):\n` + facts.map((f) => `- ${f.text} (${f.id})`).join("\n")
          : "Nothing durable to store from that text.",
      }],
    };
  },
);

server.registerTool(
  "memory_recall",
  {
    title: "Recall from memory",
    description:
      "Retrieve remembered facts relevant to a question, via graph traversal with temporal filtering. " +
      "Handles 'what is X now', 'what was X before', and 'when did X change'. " +
      "Returns an explicit 'not in memory' when nothing supports an answer — do not guess past it. " +
      "Call this BEFORE answering questions about the user's preferences, history, or prior decisions.",
    inputSchema: {
      question: z.string().describe("Natural-language question about remembered context"),
      synthesize: z.boolean().optional().describe("If true, also return an LLM-synthesized answer (default: raw facts only)"),
    },
  },
  async ({ question, synthesize }) => {
    if (synthesize) {
      const a = await answer(question);
      return { content: [{ type: "text" as const, text: a.abstained ? a.answer : `${a.answer}\n\nSupporting facts:\n${a.contextBlock}` }] };
    }
    const r = await recall(question);
    return {
      content: [{
        type: "text" as const,
        text: r.abstained ? "Not in memory." : `Relevant facts (chronological):\n${r.contextBlock}`,
      }],
    };
  },
);

server.registerTool(
  "memory_list",
  {
    title: "List memories",
    description: "Browse stored facts, optionally filtered by entity name. Every fact is inspectable and traceable to its source session.",
    inputSchema: {
      entity: z.string().optional().describe("Filter to facts about this entity (e.g. 'user')"),
    },
  },
  async ({ entity }) => {
    const rows = await cypher<{ id: string; text: string; status: string; observed_at: string; session_id: string }>(
      entity
        ? `MATCH (f:Fact)-[:ABOUT]->(e:Entity {name: $entity})
           OPTIONAL MATCH (f)-[:STATED_IN]->(s:Session)
           RETURN f.id AS id, f.text AS text, f.status AS status, f.observed_at AS observed_at, s.id AS session_id
           ORDER BY observed_at DESC LIMIT 50`
        : `MATCH (f:Fact)
           OPTIONAL MATCH (f)-[:STATED_IN]->(s:Session)
           RETURN f.id AS id, f.text AS text, f.status AS status, f.observed_at AS observed_at, s.id AS session_id
           ORDER BY observed_at DESC LIMIT 50`,
      { entity: entity?.toLowerCase() },
    );
    return {
      content: [{
        type: "text" as const,
        text: rows.length
          ? rows.map((r) => `[${r.status}] ${r.observed_at} · ${r.text} (id: ${r.id}, session: ${r.session_id})`).join("\n")
          : "No memories stored yet.",
      }],
    };
  },
);

server.registerTool(
  "memory_forget",
  {
    title: "Forget memories",
    description: "Permanently delete facts by id (get ids from memory_list). Use when the user asks to forget something.",
    inputSchema: {
      ids: z.array(z.string()).describe("Fact ids to delete"),
    },
  },
  async ({ ids }) => {
    await cypher(`UNWIND $ids AS fid MATCH (f:Fact {id: fid}) DETACH DELETE f`, { ids });
    return { content: [{ type: "text" as const, text: `Deleted ${ids.length} fact(s).` }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.on("SIGINT", async () => { await closeHydra(); process.exit(0); });
