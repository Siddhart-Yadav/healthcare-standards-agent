/**
 * mcp-server.ts
 *
 * An MCP (Model Context Protocol) server that exposes NIAHO healthcare
 * standards as tools. When connected to Claude.ai or ChatGPT, the LLM
 * acts as the agent and calls these tools to answer user questions.
 *
 * HOW THIS IS DIFFERENT FROM agent.ts:
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  agent.ts (Path B):                                            │
 * │    YOU build the agent loop. YOU decide what model to call.     │
 * │    The LLM + tool execution all happens in your code.          │
 * │                                                                 │
 * │  mcp-server.ts (Path A):                                       │
 * │    Claude.ai/ChatGPT IS the agent. They decide when to call    │
 * │    your tools. You just EXPOSE the tools via MCP protocol.     │
 * │    You don't call any LLM API yourself.                        │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * TRANSPORT MODES:
 *   --stdio : Communication over stdin/stdout (for Claude Desktop / Claude Code)
 *   --sse   : HTTP server with Server-Sent Events (for Claude.ai / ChatGPT remote)
 *
 * Run with:
 *   npx tsx src/mcp-server.ts --stdio    (local, for Claude Desktop)
 *   npx tsx src/mcp-server.ts --sse      (remote, HTTP server on port 3000)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import * as http from "http";
import * as dotenv from "dotenv";
import {
  searchStandards,
  getStandardByChapter,
  listSections,
  closeConnection,
} from "./tools.js";

dotenv.config();

// ─────────────────────────────────────────────
// SECTION 1: CREATE THE MCP SERVER
// ─────────────────────────────────────────────

/**
 * McpServer is the main class from the MCP SDK.
 * It manages tool registration, handles incoming requests,
 * and communicates over the chosen transport.
 *
 * The name and version are sent to the client (Claude.ai, etc.)
 * so it knows what server it's connected to.
 */
const server = new McpServer({
  name: "niaho-standards",
  version: "1.0.0",
});

// ─────────────────────────────────────────────
// SECTION 2: REGISTER TOOLS
// ─────────────────────────────────────────────

/**
 * server.tool() registers a tool with the MCP server.
 *
 * Parameters:
 *   1. name        — Tool identifier (what the LLM sees)
 *   2. description — Helps the LLM decide WHEN to use this tool
 *   3. schema      — Zod schema defining the input parameters
 *                    (MCP SDK uses Zod instead of raw JSON Schema)
 *   4. handler     — Async function that runs when the tool is called
 *                    Must return { content: [{ type: "text", text: "..." }] }
 *
 * WHY ZOD?
 * Zod is a TypeScript schema validation library. The MCP SDK uses it
 * to define tool parameters because:
 *   - It's type-safe (TypeScript infers types from the schema)
 *   - It auto-generates JSON Schema for the LLM
 *   - It validates inputs at runtime (catches bad parameters)
 *
 * Example: z.string().describe("The search query")
 *   → JSON Schema: { "type": "string", "description": "The search query" }
 */

// ── Tool 1: search_standards ──
server.tool(
  "search_standards",
  "Semantic search across NIAHO healthcare accreditation standards. Use this for general questions about requirements, policies, or topics. Returns the most relevant sections based on meaning, not just keyword matching.",
  {
    query: z
      .string()
      .describe("The natural language search query (e.g., 'infection control requirements for surgical areas')"),
    top_k: z
      .number()
      .default(5)
      .describe("Number of results to return (default: 5, max: 10)"),
  },
  async ({ query, top_k }) => {
    /**
     * This handler is called when Claude.ai/ChatGPT decides to use search_standards.
     * It receives the parameters that the LLM chose, runs the search,
     * and returns formatted results.
     *
     * The return format MUST be: { content: [{ type: "text", text: "..." }] }
     * This is the MCP protocol's standard response format.
     */
    const results = await searchStandards(query, top_k);

    if (results.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No matching standards found for this query." }],
      };
    }

    const formatted = results
      .map(
        (r, i) =>
          `[Result ${i + 1}] Chapter: ${r.chapter} | Section: ${r.section} | Score: ${r.score.toFixed(4)}\n${r.text}`
      )
      .join("\n\n---\n\n");

    return {
      content: [{ type: "text" as const, text: formatted }],
    };
  }
);

// ── Tool 2: get_standard_by_chapter ──
server.tool(
  "get_standard_by_chapter",
  "Get the exact verbatim text of a specific NIAHO standard chapter by its ID. Use when the user requests a specific chapter (e.g., 'Show me QM.1', 'Cite chapter IC.3'). Returns the full unmodified text.",
  {
    chapter_id: z
      .string()
      .describe("The chapter identifier (e.g., 'QM.1', 'IC.3', 'LS.2')"),
  },
  async ({ chapter_id }) => {
    const result = await getStandardByChapter(chapter_id);

    if (!result) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Chapter "${chapter_id}" not found in the knowledge base. Try searching for related standards using a general query.`,
          },
        ],
      };
    }

    const formatted = `Document: ${result.document}\nSection: ${result.section}\nChapter: ${result.chapter}\n\n${result.text}`;

    return {
      content: [{ type: "text" as const, text: formatted }],
    };
  }
);

// ── Tool 3: list_sections ──
server.tool(
  "list_sections",
  "List all available sections and chapters in the NIAHO standards knowledge base. Use for browsing, discovery, or when the user wants to see what's available. Optionally filter by section name.",
  {
    section_filter: z
      .string()
      .optional()
      .describe("Optional filter to match section names (e.g., 'Infection' to find infection control sections). Case-insensitive partial match."),
  },
  async ({ section_filter }) => {
    const sections = await listSections(section_filter);

    if (sections.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No sections found matching the filter." }],
      };
    }

    const formatted = sections
      .map(
        (s) => `${s.section} (${s.chapterCount} chapters): ${s.chapters.join(", ")}`
      )
      .join("\n");

    return {
      content: [{ type: "text" as const, text: formatted }],
    };
  }
);

// ─────────────────────────────────────────────
// SECTION 3: TRANSPORT SETUP & START
// ─────────────────────────────────────────────

/**
 * The transport layer determines HOW the MCP server communicates
 * with the AI client (Claude.ai, ChatGPT, Claude Desktop).
 *
 * STDIO TRANSPORT (--stdio):
 *   - The AI app starts your server as a child process
 *   - Communication happens over stdin (incoming) and stdout (outgoing)
 *   - Used by Claude Desktop and Claude Code
 *   - Simple, no network setup needed
 *   - The server's console.log goes to stderr (so it doesn't interfere with MCP messages on stdout)
 *
 * SSE TRANSPORT (--sse):
 *   - Your server runs as an HTTP server on a port
 *   - The AI app connects to your URL via Server-Sent Events
 *   - Used by Claude.ai (remote connections) and ChatGPT
 *   - Requires a publicly accessible URL for production
 *   - For local testing, use localhost
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const useSSE = args.includes("--sse");

  if (useSSE) {
    // ── SSE Transport: HTTP server ──
    const PORT = parseInt(process.env.PORT || "3000");

    /**
     * For SSE, we create a basic HTTP server that handles:
     *   - GET /sse        → Client connects here to receive events
     *   - POST /messages   → Client sends tool calls here
     *
     * The SSEServerTransport handles the MCP protocol over these endpoints.
     * We need to track active transports so each connection gets its own session.
     */
    const activeTransports = new Map<string, SSEServerTransport>();

    const httpServer = http.createServer(async (req, res) => {
      // CORS headers — needed for browser-based clients
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(200);
        res.end();
        return;
      }

      const url = new URL(req.url || "/", `http://localhost:${PORT}`);

      if (url.pathname === "/sse" && req.method === "GET") {
        // New SSE connection — create a transport for this client
        console.error(`New SSE connection from client`);
        const transport = new SSEServerTransport("/messages", res);
        activeTransports.set(transport.sessionId, transport);

        // Clean up when client disconnects
        res.on("close", () => {
          activeTransports.delete(transport.sessionId);
          console.error(`Client disconnected: ${transport.sessionId}`);
        });

        // Connect this transport to our MCP server
        await server.connect(transport);

      } else if (url.pathname === "/messages" && req.method === "POST") {
        // Incoming message from client — route to the correct transport
        const sessionId = url.searchParams.get("sessionId");
        const transport = sessionId ? activeTransports.get(sessionId) : undefined;

        if (transport) {
          await transport.handlePostMessage(req, res);
        } else {
          res.writeHead(404);
          res.end("Session not found");
        }

      } else {
        // Health check / info endpoint
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          name: "niaho-standards",
          version: "1.0.0",
          status: "running",
          transport: "sse",
          endpoints: {
            sse: "/sse",
            messages: "/messages",
          },
        }));
      }
    });

    httpServer.listen(PORT, () => {
      console.error(`MCP Server (SSE) running at http://localhost:${PORT}`);
      console.error(`Connect Claude.ai to: http://localhost:${PORT}/sse`);
    });

  } else {
    // ── STDIO Transport: Default ──
    /**
     * StdioServerTransport reads MCP messages from stdin and writes responses to stdout.
     * This is the simplest transport — no HTTP server needed.
     *
     * IMPORTANT: When using stdio, all our logging goes to stderr (console.error)
     * because stdout is reserved for MCP protocol messages. If we use console.log,
     * it would corrupt the MCP communication.
     */
    console.error("Starting MCP Server (stdio)...");
    console.error("Tools available: search_standards, get_standard_by_chapter, list_sections");

    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error("MCP Server connected and ready.");
  }
}

// Handle graceful shutdown
process.on("SIGINT", async () => {
  console.error("\nShutting down...");
  await closeConnection();
  process.exit(0);
});

// Run the server
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
