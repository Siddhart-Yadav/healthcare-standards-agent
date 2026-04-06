/**
 * tools.ts
 *
 * Shared tool functions used by BOTH the MCP server (Path A) and the CLI agent (Path B).
 * Contains three tools:
 *   1. searchStandards    — Semantic vector search (Q&A mode)
 *   2. getStandardByChapter — Exact chapter lookup (Citation mode)
 *   3. listSections       — Browse available sections/chapters
 *
 * Also contains helper functions:
 *   - getMongoCollection() — Connects to MongoDB and returns the collection
 *   - generateQueryEmbedding() — Embeds a user's question via Voyage AI
 *
 * Run with: imported by mcp-server.ts and agent.ts
 */

import { MongoClient, Collection } from "mongodb";
import * as dotenv from "dotenv";

dotenv.config();

// ─────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────

const CONFIG = {
  mongoUri: process.env.MONGODB_URI!,
  dbName: "niaho_standards",
  collectionName: "standards",
  voyageApiKey: process.env.VOYAGE_API_KEY!,
  voyageModel: "voyage-3-large",
  voyageApiUrl: "https://ai.mongodb.com/v1/embeddings",
  vectorIndexName: "vector_index",   // Name of the Atlas Vector Search index
};

// ─────────────────────────────────────────────
// MONGODB CONNECTION (Singleton)
// ─────────────────────────────────────────────

/**
 * We reuse a single MongoClient across all tool calls.
 *
 * WHY singleton? Each tool call needs the database. Creating a new connection
 * every time is slow (~500ms) and wasteful. Instead, we connect once and
 * reuse the same client for all subsequent calls.
 *
 * The `let` variables store the client and collection after the first call.
 */
let client: MongoClient | null = null;
let collection: Collection | null = null;

async function getMongoCollection(): Promise<Collection> {
  if (collection) return collection;

  client = new MongoClient(CONFIG.mongoUri);
  await client.connect();
  collection = client.db(CONFIG.dbName).collection(CONFIG.collectionName);
  console.log("Connected to MongoDB Atlas");
  return collection;
}

/**
 * Call this when shutting down to cleanly close the MongoDB connection.
 */
export async function closeConnection(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    collection = null;
    console.log("Disconnected from MongoDB Atlas");
  }
}

// ─────────────────────────────────────────────
// VOYAGE AI QUERY EMBEDDING
// ─────────────────────────────────────────────

/**
 * generateQueryEmbedding()
 *
 * Converts a user's natural-language question into a 1024-dim vector.
 *
 * IMPORTANT: We use input_type: "query" here (not "document").
 * - "document" = used when STORING data (in seed-database.ts)
 * - "query"    = used when SEARCHING (here)
 * Voyage AI optimizes the embedding differently for each use case.
 * This asymmetry improves search relevance.
 */
async function generateQueryEmbedding(query: string): Promise<number[]> {
  const response = await fetch(CONFIG.voyageApiUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${CONFIG.voyageApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: [query],
      model: CONFIG.voyageModel,
      input_type: "query",  // "query" for search questions
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Voyage AI embedding error (${response.status}): ${errorBody}`);
  }

  const result = (await response.json()) as { data: { embedding: number[] }[] };
  return result.data[0].embedding;
}

// ─────────────────────────────────────────────
// TOOL 1: search_standards (Semantic Vector Search)
// ─────────────────────────────────────────────

/**
 * searchStandards()
 *
 * This is the core RAG retrieval function. Here's what happens:
 *
 * 1. User asks: "What are the infection control requirements?"
 * 2. We embed that question into a 1024-dim vector using Voyage AI
 * 3. We send that vector to MongoDB's $vectorSearch
 * 4. MongoDB finds the chunks whose embeddings are most similar (cosine similarity)
 * 5. We return the top-k most relevant chunks
 *
 * HOW $vectorSearch WORKS:
 * - It compares the query vector against every document's embedding vector
 * - Uses cosine similarity: measures the angle between two vectors
 *   - 1.0 = identical direction (perfect match)
 *   - 0.0 = perpendicular (unrelated)
 * - Returns documents sorted by similarity score (highest first)
 *
 * The "numCandidates" parameter tells Atlas how many candidates to consider
 * before narrowing down to top_k. Higher = more accurate but slower.
 * Rule of thumb: numCandidates = 10x to 20x of the limit.
 */
export interface SearchResult {
  chunk_id: string;
  text: string;
  chapter: string;
  section: string;
  score: number;
}

export async function searchStandards(
  query: string,
  topK: number = 5
): Promise<SearchResult[]> {
  const col = await getMongoCollection();

  // Step 1: Embed the user's question
  const queryEmbedding = await generateQueryEmbedding(query);

  // Step 2: Run vector search using MongoDB's $vectorSearch aggregation
  const results = await col
    .aggregate([
      {
        $vectorSearch: {
          index: CONFIG.vectorIndexName,
          path: "embedding",               // Field containing document vectors
          queryVector: queryEmbedding,      // The question vector
          numCandidates: topK * 20,        // Consider 20x candidates for accuracy
          limit: topK,                     // Return only top-k results
        },
      },
      {
        // $project controls which fields are returned
        // We exclude the embedding (it's a huge array, not useful to display)
        $project: {
          _id: 0,
          chunk_id: 1,
          text: 1,
          "metadata.chapter": 1,
          "metadata.section": 1,
          score: { $meta: "vectorSearchScore" },  // The similarity score
        },
      },
    ])
    .toArray();

  // Step 3: Format results into a clean structure
  return results.map((doc) => ({
    chunk_id: doc.chunk_id,
    text: doc.text,
    chapter: doc.metadata.chapter,
    section: doc.metadata.section,
    score: doc.score,
  }));
}

// ─────────────────────────────────────────────
// TOOL 2: get_standard_by_chapter (Exact Lookup)
// ─────────────────────────────────────────────

/**
 * getStandardByChapter()
 *
 * Simple exact-match query. When a user says "Show me QM.1", we don't
 * need vector search — we just query metadata.chapter directly.
 *
 * This returns the VERBATIM text, not a summary. The challenge spec
 * explicitly requires this for citation mode.
 *
 * If the chapter isn't found, we return null so the caller can
 * fall back to semantic search or show a helpful error.
 */
export interface ChapterResult {
  chunk_id: string;
  text: string;
  chapter: string;
  section: string;
  document: string;
}

export async function getStandardByChapter(
  chapterId: string
): Promise<ChapterResult | null> {
  const col = await getMongoCollection();

  // Exact match on metadata.chapter (uses the index we created in seed-database.ts)
  const doc = await col.findOne(
    { "metadata.chapter": chapterId.toUpperCase() },
    {
      projection: {
        _id: 0,
        chunk_id: 1,
        text: 1,
        "metadata.chapter": 1,
        "metadata.section": 1,
        "metadata.document": 1,
      },
    }
  );

  if (!doc) return null;

  return {
    chunk_id: doc.chunk_id,
    text: doc.text,
    chapter: doc.metadata.chapter,
    section: doc.metadata.section,
    document: doc.metadata.document,
  };
}

// ─────────────────────────────────────────────
// TOOL 3: list_sections (Browse/Discover)
// ─────────────────────────────────────────────

/**
 * listSections()
 *
 * Returns all available sections and their chapters so the user can
 * browse what's in the knowledge base.
 *
 * Uses MongoDB's aggregation pipeline:
 * - $group: Groups documents by section, collects all chapter IDs into an array
 * - $sort: Alphabetical order by section name
 *
 * Optional: filter by section name (e.g., "Infection" matches
 * "Infection Prevention and Control Program")
 *
 * WHY aggregation instead of find()? We want a summary (section → [chapters]),
 * not individual documents. Aggregation lets us group and reshape data
 * in the database instead of doing it in JavaScript.
 */
export interface SectionInfo {
  section: string;
  chapters: string[];
  chapterCount: number;
}

export async function listSections(
  sectionFilter?: string
): Promise<SectionInfo[]> {
  const col = await getMongoCollection();

  // Build the match stage — if a filter is provided, use regex for partial matching
  const matchStage = sectionFilter
    ? {
        $match: {
          "metadata.section": {
            $regex: sectionFilter,
            $options: "i",  // case-insensitive
          },
        },
      }
    : null;

  // Build the aggregation pipeline
  const pipeline: any[] = [];

  // Add match stage only if filtering
  if (matchStage) pipeline.push(matchStage);

  pipeline.push(
    {
      // Group by section, collect all chapter IDs
      $group: {
        _id: "$metadata.section",
        chapters: { $addToSet: "$metadata.chapter" },  // unique chapters only
      },
    },
    {
      // Sort alphabetically
      $sort: { _id: 1 },
    },
    {
      // Rename _id to section for cleaner output
      $project: {
        _id: 0,
        section: "$_id",
        chapters: 1,
      },
    }
  );

  const results = await col.aggregate(pipeline).toArray();

  return results.map((doc) => ({
    section: doc.section,
    chapters: (doc.chapters as string[]).sort(),  // Sort chapters within each section
    chapterCount: doc.chapters.length,
  }));
}
