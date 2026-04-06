/**
 * agent.ts
 *
 * A CLI tool-calling agent that uses the Google Gemini SDK to answer questions
 * about NIAHO healthcare accreditation standards.
 *
 * HOW THE AGENT LOOP WORKS:
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  1. User types a question                                      │
 * │  2. Send question + tool definitions to Gemini                  │
 * │  3. Gemini decides: does it need a tool?                        │
 * │     ├─ YES (functionCall in response):                          │
 * │     │   a. Extract which tool + parameters Gemini wants         │
 * │     │   b. Execute that tool (call our tools.ts functions)      │
 * │     │   c. Send the tool result back to Gemini                  │
 * │     │   d. Go back to step 3 (Gemini may call another tool)     │
 * │     └─ NO (text in response):                                   │
 * │         a. Gemini has the final answer                          │
 * │         b. Print it to the user                                 │
 * │         c. Go back to step 1 (wait for next question)           │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * Run with: npx tsx src/agent.ts
 */

import { GoogleGenerativeAI, Content, FunctionDeclaration, Tool as GeminiTool, Part } from "@google/generative-ai";
import * as readline from "readline";
import * as dotenv from "dotenv";
import {
  searchStandards,
  getStandardByChapter,
  listSections,
  closeConnection,
} from "./tools.js";

dotenv.config();

// ─────────────────────────────────────────────
// SECTION 1: GEMINI CLIENT SETUP
// ─────────────────────────────────────────────

/**
 * The Google Generative AI client. We pass the API key from .env.
 * Unlike Anthropic SDK, Google's SDK doesn't auto-read env vars.
 */
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

/**
 * Which model to use. Gemini 2.0 Flash is fast and supports tool calling.
 */
const MODEL = "gemini-2.5-flash";

// ─────────────────────────────────────────────
// SECTION 2: SYSTEM PROMPT
// ─────────────────────────────────────────────

/**
 * The system prompt tells Gemini:
 * - What it is (a healthcare standards assistant)
 * - When to use each tool
 * - How to format responses (citations, verbatim text, etc.)
 * - How to handle edge cases
 *
 * This is one of the key deliverables the challenge evaluates.
 */
const SYSTEM_PROMPT = `You are a knowledgeable healthcare standards assistant specializing in NIAHO (National Integrated Accreditation for Healthcare Organizations) accreditation requirements for hospitals.

You have access to three tools to query a knowledge base of NIAHO standards:

## Tool Usage Guidelines

### search_standards
- Use for **general questions** about requirements, policies, or topics
- Examples: "What are the infection control requirements?", "How should hospitals handle medication errors?"
- Always cite the chapter ID and section name in your answer
- Synthesize information from multiple results into a coherent answer

### get_standard_by_chapter
- Use when the user asks for a **specific chapter by ID** (e.g., "Show me QM.1", "Cite IC.3")
- Return the **verbatim text** — do NOT paraphrase or summarize
- Include the chapter ID, section name, and document name in your response

### list_sections
- Use when the user wants to **browse or discover** what's available
- Examples: "What sections exist?", "List all infection control chapters"
- Use the section_filter parameter for filtering (e.g., "Infection" to find IC chapters)

## Response Guidelines

1. **Always cite sources**: Include chapter IDs (e.g., QM.1, IC.3) and section names in every answer
2. **Verbatim for citations**: When the user asks for exact text, return it word-for-word
3. **Synthesize for Q&A**: When answering general questions, combine information from multiple relevant chunks into a clear, organized answer
4. **Handle ambiguity**: If a query could be both Q&A and citation (e.g., "What does QM.1 say about quality management?"), use BOTH tools — get the exact text AND search for additional context
5. **Not found**: If a chapter doesn't exist, say so clearly and suggest related chapters using search_standards
6. **Out of scope**: If the question is unrelated to healthcare standards, politely indicate it's outside the knowledge base
7. **Multiple chapters**: If the user asks about multiple chapters (e.g., "Show me QM.1 and QM.2"), call get_standard_by_chapter for each one
8. **Partial matches**: If the user says "Show me the QM chapters", use list_sections with filter "Quality Management" to find all QM.* chapters`;

// ─────────────────────────────────────────────
// SECTION 3: TOOL DEFINITIONS (Gemini Format)
// ─────────────────────────────────────────────

/**
 * Tool definitions for Gemini use "functionDeclarations" format.
 * Each declaration has:
 *   - name: The tool identifier
 *   - description: Helps Gemini decide WHEN to use it
 *   - parameters: JSON Schema describing the inputs
 *
 * KEY DIFFERENCE from Anthropic:
 * - Anthropic uses "tools" with "input_schema"
 * - Gemini uses "functionDeclarations" with "parameters"
 * - The schema format is the same (JSON Schema), just wrapped differently
 */
const functionDeclarations: FunctionDeclaration[] = [
  {
    name: "search_standards",
    description:
      "Semantic search across NIAHO healthcare accreditation standards. Use this for general questions about requirements, policies, or topics. Returns the most relevant sections based on meaning, not just keyword matching.",
    parameters: {
      type: "OBJECT" as any,
      properties: {
        query: {
          type: "STRING" as any,
          description: "The natural language search query (e.g., 'infection control requirements for surgical areas')",
        },
        top_k: {
          type: "NUMBER" as any,
          description: "Number of results to return (default: 5, max: 10)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_standard_by_chapter",
    description:
      "Get the exact verbatim text of a specific NIAHO standard chapter by its ID. Use when the user requests a specific chapter (e.g., 'Show me QM.1', 'Cite chapter IC.3'). Returns the full unmodified text.",
    parameters: {
      type: "OBJECT" as any,
      properties: {
        chapter_id: {
          type: "STRING" as any,
          description: "The chapter identifier (e.g., 'QM.1', 'IC.3', 'LS.2')",
        },
      },
      required: ["chapter_id"],
    },
  },
  {
    name: "list_sections",
    description:
      "List all available sections and chapters in the NIAHO standards knowledge base. Use for browsing, discovery, or when the user wants to see what's available. Optionally filter by section name.",
    parameters: {
      type: "OBJECT" as any,
      properties: {
        section_filter: {
          type: "STRING" as any,
          description: "Optional filter to match section names (e.g., 'Infection' to find infection control sections). Case-insensitive partial match.",
        },
      },
      required: [],
    },
  },
];

/**
 * Gemini wraps function declarations inside a "tools" array.
 * Each tool object contains an array of function declarations.
 */
const geminiTools: GeminiTool[] = [
  { functionDeclarations },
];

// ─────────────────────────────────────────────
// SECTION 4: TOOL EXECUTION
// ─────────────────────────────────────────────

/**
 * executeTool()
 *
 * When Gemini decides to call a tool, it returns a functionCall part with:
 *   - name: which tool to call
 *   - args: the parameters to pass
 *
 * This function maps the tool name to our actual tools.ts functions
 * and returns the result as a string (which gets sent back to Gemini).
 */
async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<string> {
  console.log(`\n   🔧 Calling tool: ${toolName}`);
  console.log(`      Input: ${JSON.stringify(toolInput)}`);

  try {
    switch (toolName) {
      case "search_standards": {
        const results = await searchStandards(
          toolInput.query as string,
          (toolInput.top_k as number) || 5
        );

        if (results.length === 0) {
          return "No matching standards found for this query.";
        }

        // Format results as a readable string for Gemini to process
        return results
          .map(
            (r, i) =>
              `[Result ${i + 1}] Chapter: ${r.chapter} | Section: ${r.section} | Score: ${r.score.toFixed(4)}\n${r.text}`
          )
          .join("\n\n---\n\n");
      }

      case "get_standard_by_chapter": {
        const result = await getStandardByChapter(toolInput.chapter_id as string);

        if (!result) {
          return `Chapter "${toolInput.chapter_id}" not found in the knowledge base. Try using search_standards to find related chapters.`;
        }

        return `Document: ${result.document}\nSection: ${result.section}\nChapter: ${result.chapter}\n\n${result.text}`;
      }

      case "list_sections": {
        const sections = await listSections(toolInput.section_filter as string | undefined);

        if (sections.length === 0) {
          return "No sections found matching the filter.";
        }

        return sections
          .map(
            (s) =>
              `${s.section} (${s.chapterCount} chapters): ${s.chapters.join(", ")}`
          )
          .join("\n");
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`   ❌ Tool error: ${errorMsg}`);
    return `Error executing ${toolName}: ${errorMsg}`;
  }
}

// ─────────────────────────────────────────────
// SECTION 5: THE AGENT LOOP
// ─────────────────────────────────────────────

/**
 * runAgent()
 *
 * This is the core agent loop. It implements the cycle:
 *   User message → Gemini → (optional tool calls) → Final answer
 *
 * CONVERSATION MEMORY:
 * Gemini uses a "chat" object that maintains history internally.
 * Each call to chat.sendMessage() appends to the conversation.
 *
 * HOW TOOL CALLING WORKS WITH GEMINI:
 * 1. We send a message to Gemini via chat.sendMessage()
 * 2. If Gemini wants to use a tool, the response contains a "functionCall" part
 *    with { name, args }
 * 3. We execute the tool and send back a "functionResponse" part with { name, response }
 * 4. Gemini sees the result and either calls another tool or gives the final answer
 * 5. When Gemini is done, the response contains a "text" part
 *
 * KEY DIFFERENCE from Anthropic:
 * - Anthropic: stop_reason === "tool_use" → tool call, "end_turn" → final answer
 * - Gemini: check if response parts contain functionCall → tool call, text → final answer
 * - Anthropic: you manually build the messages array
 * - Gemini: the chat object manages history for you
 */

// Create the model with system prompt and tools
const model = genAI.getGenerativeModel({
  model: MODEL,
  systemInstruction: SYSTEM_PROMPT,
  tools: geminiTools,
});

// Start a chat session — this maintains conversation history automatically
let chat = model.startChat();

async function runAgent(userMessage: string): Promise<string> {
  // Send the user's message to Gemini
  let response = await chat.sendMessage(userMessage);
  let result = response.response;

  // Keep looping while Gemini wants to call tools
  while (true) {
    // Get the parts from Gemini's response
    const parts = result.candidates?.[0]?.content?.parts || [];

    // Check if any part is a function call
    const functionCallPart = parts.find((p: Part) => p.functionCall);

    if (functionCallPart && functionCallPart.functionCall) {
      // Gemini wants to call a tool
      const { name, args } = functionCallPart.functionCall;

      // Execute the tool
      const toolResult = await executeTool(name, (args || {}) as Record<string, unknown>);

      // Send the function result back to Gemini
      // Gemini expects a "functionResponse" part with the tool's output
      response = await chat.sendMessage([
        {
          functionResponse: {
            name: name,
            response: { result: toolResult },
          },
        },
      ]);
      result = response.response;

      // Loop continues — Gemini will process the result

    } else {
      // No function call — Gemini has the final text answer
      const textContent = result.text();
      return textContent || "No response generated.";
    }
  }
}

// ─────────────────────────────────────────────
// SECTION 6: CLI CHAT LOOP
// ─────────────────────────────────────────────

/**
 * main()
 *
 * Sets up a readline interface for terminal input/output.
 * Keeps running until the user types "exit" or "quit".
 *
 * The chat object persists across questions, so Gemini
 * remembers what was discussed earlier in the session.
 */
async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("  NIAHO Healthcare Standards Agent");
  console.log("  Type your question, or 'exit' to quit.");
  console.log("=".repeat(60));
  console.log();

  // Validate env vars
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY in .env");
  }

  // readline creates a terminal prompt that waits for user input
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Helper to prompt and wait for input
  const askQuestion = (): Promise<string> =>
    new Promise((resolve) => {
      rl.question("You: ", (answer) => resolve(answer));
    });

  // Main chat loop
  while (true) {
    const userInput = await askQuestion();

    // Check for exit commands
    if (
      !userInput.trim() ||
      ["exit", "quit", "q"].includes(userInput.trim().toLowerCase())
    ) {
      console.log("\nGoodbye!");
      break;
    }

    try {
      console.log("\nAgent: Thinking...");
      const response = await runAgent(userInput);
      console.log(`\nAgent: ${response}\n`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`\nError: ${errorMsg}\n`);
    }
  }

  // Cleanup
  rl.close();
  await closeConnection();
}

// Run the agent
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
