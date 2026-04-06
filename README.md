# Healthcare Standards Agent

An agentic AI system that connects to a knowledge base of NIAHO (National Integrated Accreditation for Healthcare Organizations) hospital accreditation standards stored in MongoDB Atlas and answers natural-language queries through semantic vector search.

This project implements **both delivery paths**:
- **Path A** - MCP Server that plugs into Claude.ai / ChatGPT
- **Path B** - Standalone tool-calling CLI agent built with Google Gemini

## Architecture

```
                    ┌──────────────────────┐
                    │     NIAHO PDF         │
                    │   (459 pages)         │
                    └──────────┬───────────┘
                               │ seed-database.ts
                               │ (extract, chunk, embed, insert)
                               ▼
                    ┌──────────────────────┐
                    │   MongoDB Atlas      │
                    │   - 183 chapters     │
                    │   - 1024-dim vectors │
                    │   - Vector Search    │
                    └──────────┬───────────┘
                               │
                    ┌──────────┴───────────┐
                    │      tools.ts        │
                    │  (shared tool layer) │
                    │  - searchStandards   │
                    │  - getStandardByChapter│
                    │  - listSections      │
                    └──────┬──────┬────────┘
                           │      │
              ┌────────────┘      └────────────┐
              ▼                                ▼
    ┌──────────────────┐             ┌──────────────────┐
    │  mcp-server.ts   │             │    agent.ts      │
    │  (Path A)        │             │    (Path B)      │
    │                  │             │                  │
    │  Exposes tools   │             │  CLI chat loop   │
    │  via MCP protocol│             │  with Gemini     │
    │  to Claude.ai /  │             │  tool-calling    │
    │  ChatGPT         │             │  agent           │
    └──────────────────┘             └──────────────────┘
```

## Tech Stack

| Component | Technology | Cost |
|-----------|-----------|------|
| Vector Database | MongoDB Atlas M0 (free tier) | Free |
| Vector Search | Atlas Vector Search | Free |
| Embeddings | Voyage AI via Atlas (`voyage-3-large`, 1024-dim) | Free (200M tokens) |
| MCP SDK (Path A) | `@modelcontextprotocol/sdk` | Free |
| LLM (Path B) | Google Gemini 2.5 Flash | Free tier |
| Runtime | Node.js 18+ / TypeScript | Free |

## Prerequisites

- Node.js 18+
- MongoDB Atlas free-tier account
- Voyage AI API key (generated in Atlas UI under AI Models)
- Google Gemini API key (for Path B agent) from [aistudio.google.com](https://aistudio.google.com/apikey)

## Setup

### 1. Clone and install

```bash
git clone https://github.com/<your-username>/healthcare-standards-agent.git
cd healthcare-standards-agent
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your actual keys
```

### 3. Seed the database

Place the NIAHO PDF in the project root, then run:

```bash
npx tsx scripts/seed-database.ts
```

This will:
1. Extract text from the 459-page NIAHO PDF
2. Chunk it into 183 sections by chapter ID (QM.1, IC.3, etc.)
3. Generate 1024-dim embeddings via Voyage AI
4. Insert all documents into MongoDB Atlas

### 4. Create Vector Search index

In Atlas UI:
1. Go to **Browse Collections** > `niaho_standards.standards`
2. Click **Search and Vector Search** > **Create Search Index**
3. Choose **Atlas Vector Search** (JSON Editor)
4. Name it `vector_index` and use this definition:

```json
{
  "fields": [
    {
      "type": "vector",
      "path": "embedding",
      "numDimensions": 1024,
      "similarity": "cosine"
    },
    {
      "type": "filter",
      "path": "metadata.chapter"
    }
  ]
}
```

## Usage

### Path A - MCP Server

**Local (stdio) - for Claude Desktop / Claude Code:**

```bash
npx tsx src/mcp-server.ts --stdio
```

Add to Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "niaho-standards": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/src/mcp-server.ts", "--stdio"],
      "env": {
        "MONGODB_URI": "your-mongodb-uri",
        "VOYAGE_API_KEY": "your-voyage-key"
      }
    }
  }
}
```

**Remote (SSE) - for Claude.ai / ChatGPT:**

```bash
npx tsx src/mcp-server.ts --sse
# Server starts at http://localhost:3000
# Connect Claude.ai to: http://localhost:3000/sse
```

### Path B - CLI Agent

```bash
npx tsx src/agent.ts
```

```
============================================================
  NIAHO Healthcare Standards Agent
  Type your question, or 'exit' to quit.
============================================================

You: What are the infection control requirements?
Agent: [calls search_standards -> retrieves results -> synthesizes answer]

You: Show me chapter IC.3 exactly
Agent: [calls get_standard_by_chapter("IC.3") -> returns verbatim text]
```

## Tools

Both paths expose the same three tools:

| Tool | Purpose | When Used |
|------|---------|-----------|
| `search_standards` | Semantic vector search across all standards | General Q&A questions |
| `get_standard_by_chapter` | Exact lookup by chapter ID | Citation requests (e.g., "Show me QM.1") |
| `list_sections` | Browse available sections/chapters | Discovery (e.g., "What sections exist?") |

## Dual-Mode Query Support

### Q&A Mode (Semantic Search)
User asks a natural-language question. The agent embeds the query, runs `$vectorSearch`, retrieves the top-k chunks, and synthesizes an answer with citations.

### Citation Mode (Exact Lookup)
User requests a specific chapter by ID. The agent does an exact match on `metadata.chapter` and returns the verbatim text without paraphrasing.

### Edge Cases
- **Ambiguous queries**: "Tell me about QM and show me QM.1" triggers both search and exact lookup
- **Partial chapter IDs**: "Show me the QM chapters" lists all QM.* chapters
- **Not found**: Graceful fallback with suggestions from semantic search
- **Out of scope**: Agent indicates the question is outside the knowledge base

## Project Structure

```
healthcare-standards-agent/
├── scripts/
│   ├── seed-database.ts      # PDF -> chunks -> embeddings -> MongoDB
│   └── test-tools.ts         # Quick tool function tests
├── src/
│   ├── tools.ts              # Shared tool functions (used by both paths)
│   ├── mcp-server.ts         # Path A: MCP server (stdio + SSE)
│   └── agent.ts              # Path B: CLI agent with Gemini
├── .env.example              # Environment variable template
├── .gitignore
├── package.json
├── tsconfig.json
├── README.md
└── TEST_RESULTS.md           # All test query outputs
```

## Design Decisions

### Why shared `tools.ts`?
Both paths need the same MongoDB queries and Voyage AI embedding logic. Extracting them into a shared module avoids duplication and ensures both paths behave identically.

### Why Voyage AI via Atlas endpoint?
Atlas-generated API keys (`al-` prefix) authenticate against `ai.mongodb.com` instead of `api.voyageai.com`. This is MongoDB's recommended integration path and keeps everything within the Atlas ecosystem.

### Why Gemini for Path B?
The agent uses Google Gemini 2.5 Flash which provides a free tier with tool-calling support, keeping the total project cost at $0.

### Chunking strategy
The NIAHO PDF has clearly structured chapter IDs (QM.1, IC.3, LS.2, etc.) at the start of each section. We split on these using regex, deduplicate (keeping the longest version of each chapter), and clean up repeated page headers. This produces 183 semantically meaningful chunks.

### Embedding approach
We use `voyage-3-large` (1024 dimensions) with asymmetric embedding:
- `input_type: "document"` when storing chunks (optimizes for being found)
- `input_type: "query"` when searching (optimizes for finding)

### MongoDB singleton connection
`tools.ts` reuses a single MongoClient across all tool calls. Creating a new connection per request would add ~500ms latency. The singleton connects once and reuses.

## Scalability Considerations

To scale to 50+ documents and 10,000+ chunks:
- **Chunking**: Implement overlap (100-200 tokens) between chunks to avoid losing context at boundaries
- **Indexing**: Atlas Vector Search scales automatically on higher-tier clusters (M10+)
- **Caching**: Add an in-memory cache for frequently accessed chapters (LRU cache)
- **Batching**: Parallelize embedding generation with higher Voyage AI rate limits
- **Sharding**: For very large collections, shard by `metadata.document` to distribute load
- **Re-ranking**: Add a Voyage AI re-ranking step after initial vector search for improved precision
