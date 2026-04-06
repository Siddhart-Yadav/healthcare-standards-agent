/**
 * seed-database.ts
 *
 * This script does 4 things in order:
 * 1. EXTRACT  — Reads the NIAHO PDF and pulls out all text
 * 2. CHUNK    — Splits the text into sections by chapter ID (QM.1, GB.2, IC.3, etc.)
 * 3. EMBED    — Sends each chunk to Voyage AI to get a 1024-dimension vector
 * 4. INSERT   — Stores everything in MongoDB Atlas
 *
 * Run with: npx tsx scripts/seed-database.ts
 */

import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { MongoClient } from "mongodb";

// pdf-parse v1 exports a single function directly
const pdfParse = require("pdf-parse");

// Load .env file so we can access MONGODB_URI, VOYAGE_API_KEY, etc.
dotenv.config();

// ─────────────────────────────────────────────
// SECTION 1: CONFIGURATION
// ─────────────────────────────────────────────

/**
 * WHY: We keep all config in one place so it's easy to change.
 * The PDF path, database name, collection name, and API settings are all here.
 */
const CONFIG = {
  // Path to the NIAHO PDF file
  pdfPath: path.resolve(__dirname, "../DNV_NIAHO_Accreditation_Requirements_for_Hospitals_Rev25-1.pdf"),

  // MongoDB settings
  mongoUri: process.env.MONGODB_URI!,
  dbName: "niaho_standards",         // Database name (from challenge spec)
  collectionName: "standards",       // Collection name (from challenge spec)

  // Voyage AI settings
  voyageApiKey: process.env.VOYAGE_API_KEY!,
  voyageModel: "voyage-3-large",     // 1024 dimensions, best quality
  voyageApiUrl: "https://ai.mongodb.com/v1/embeddings",
  embeddingBatchSize: 2,             // Very small batches to stay under 10K TPM rate limit

  // Chunking settings
  maxChunkTokens: 2000,              // If a chapter is too long, split it further
};

// ─────────────────────────────────────────────
// SECTION 2: SECTION NAME MAPPING
// ─────────────────────────────────────────────

/**
 * WHY: The PDF uses 2-letter codes like "QM", "GB", "IC".
 * We need human-readable names for the metadata.section field.
 * This map was extracted from the Table of Contents of the NIAHO PDF.
 */
const SECTION_MAP: Record<string, string> = {
  QM: "Quality Management System",
  GB: "Governing Body",
  CE: "Chief Executive Officer",
  MS: "Medical Staff",
  NS: "Nursing Services",
  SM: "Staffing Management",
  MM: "Medication Management",
  SS: "Surgical Services",
  AS: "Anesthesia Services",
  OB: "Obstetrical Care Services",
  LS: "Laboratory Services",
  RC: "Respiratory Care Services",
  MI: "Medical Imaging",
  NM: "Nuclear Medicine Services",
  RS: "Rehabilitation Services",
  ES: "Emergency Services",
  OS: "Outpatient Services",
  DS: "Dietary Services",
  PR: "Patient Rights",
  IC: "Infection Prevention and Control Program",
  MR: "Medical Records Service",
  DC: "Discharge Planning",
  UR: "Utilization Review",
  PE: "Physical Environment",
  PC: "Plan of Care",
  RR: "Residents Rights",
  FS: "Facility Services",
  RN: "Resident Nutrition",
  SB: "Swing Beds",
  TD: "Transplant and Dialysis",
  TO: "Tissue and Organ",
  SR: "Standards Requirements",
};

// ─────────────────────────────────────────────
// SECTION 3: TYPE DEFINITIONS
// ─────────────────────────────────────────────

/**
 * WHY: TypeScript interfaces define the shape of our data.
 * This matches the document schema from the challenge spec exactly.
 */
interface StandardDocument {
  chunk_id: string;       // e.g. "QM_1_001"
  text: string;           // Full text of the chunk
  metadata: {
    document: string;     // Always "NIAHO Standards"
    section: string;      // e.g. "Quality Management System"
    chapter: string;      // e.g. "QM.1"
  };
  embedding: number[];    // 1024-dimensional vector from Voyage AI
  token_count: number;    // Approximate token count
}

/**
 * Intermediate type — a chunk before we generate its embedding.
 */
interface RawChunk {
  chapter: string;        // e.g. "QM.1"
  section: string;        // e.g. "Quality Management System"
  text: string;           // The chunk's text content
}

// ─────────────────────────────────────────────
// SECTION 4: PDF EXTRACTION
// ─────────────────────────────────────────────

/**
 * extractTextFromPdf()
 *
 * HOW IT WORKS:
 * - Reads the PDF file from disk as a binary Buffer
 * - Passes it to pdf-parse, which returns all text as one big string
 * - pdf-parse internally reads each page and concatenates the text
 *
 * WHY a Buffer? PDFs are binary files (not plain text), so we need
 * fs.readFileSync without a text encoding to get raw bytes.
 */
async function extractTextFromPdf(filePath: string): Promise<string> {
  console.log(`Reading PDF from: ${filePath}`);

  const pdfBuffer = fs.readFileSync(filePath);
  const pdfData = await pdfParse(pdfBuffer);

  console.log(`   Total pages: ${pdfData.numpages}`);
  console.log(`   Text length: ${pdfData.text.length} characters`);

  return pdfData.text;
}

// ─────────────────────────────────────────────
// SECTION 5: CHUNKING BY CHAPTER
// ─────────────────────────────────────────────

/**
 * chunkByChapter()
 *
 * HOW IT WORKS:
 * The NIAHO PDF has chapters like "QM.1 RESPONSIBILITY AND ACCOUNTABILITY".
 * We use a regex to find these chapter headings and split the text at each one.
 *
 * The regex: /^([A-Z]{2,4})\.(\d+)\s/gm
 *   ^           = start of a line
 *   ([A-Z]{2,4}) = 2-4 uppercase letters (QM, GB, IC, etc.) — captured as group 1
 *   \.           = literal dot
 *   (\d+)        = one or more digits (1, 2, 10, etc.) — captured as group 2
 *   \s           = followed by whitespace
 *   g            = find ALL matches (not just the first)
 *   m            = multiline mode (^ matches start of each line, not just start of string)
 *
 * ALGORITHM:
 * 1. Find all chapter heading positions in the text
 * 2. For each heading, extract everything from that heading to the next heading
 * 3. That extracted text = one chunk
 * 4. Clean up the text (remove page headers/footers)
 */
function chunkByChapter(fullText: string): RawChunk[] {
  console.log("\nChunking text by chapter...");

  const chunks: RawChunk[] = [];

  // This regex matches chapter headings like "QM.1 ", "IC.3 ", "MS.10 "
  const chapterRegex = /^([A-Z]{2,4})\.(\d+)\s/gm;

  // Step 1: Find all chapter heading positions
  // matchAll returns an iterator of matches, each with .index (position in string)
  const matches = [...fullText.matchAll(chapterRegex)];

  console.log(`   Found ${matches.length} chapter headings`);

  // Step 2: Loop through matches and extract text between consecutive headings
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const prefix = match[1];        // e.g. "QM"
    const number = match[2];        // e.g. "1"
    const chapter = `${prefix}.${number}`;  // e.g. "QM.1"

    // Where does this chapter's text start?
    const startIndex = match.index!;

    // Where does it end? At the next chapter heading, or end of document
    const endIndex = i + 1 < matches.length
      ? matches[i + 1].index!
      : fullText.length;

    // Extract the raw text for this chapter
    let chunkText = fullText.slice(startIndex, endIndex);

    // Clean up: remove the repeating page header that appears on every page
    chunkText = cleanText(chunkText);

    // Skip very short chunks (probably false matches or empty sections)
    if (chunkText.length < 50) continue;

    // Look up the human-readable section name
    const section = SECTION_MAP[prefix] || prefix;

    chunks.push({
      chapter,
      section,
      text: chunkText.trim(),
    });
  }

  // Deduplicate: the same chapter ID might appear multiple times in the PDF
  // (e.g. in the table of contents AND in the actual content)
  // We keep the LONGEST version (which is the actual content, not the TOC entry)
  const deduped = deduplicateChunks(chunks);

  console.log(`   After dedup: ${deduped.length} unique chapters`);
  return deduped;
}

/**
 * cleanText()
 *
 * WHY: The PDF has a header repeated on every page:
 *   "NIAHO Accreditation Requirements, Interpretive Guidelines..."
 *   "Revision 25-1 - Effective September 8, 2025"
 *
 * We remove these so they don't pollute our chunks with irrelevant text.
 * We also collapse multiple newlines into double newlines for readability.
 */
function cleanText(text: string): string {
  return text
    // Remove the repeating page header (with variations in formatting)
    .replace(/®?\s*\n?NIAHO.*?Accreditation Requirements.*?Hospitals\s*\n?.*?Revision.*?\d{4}/g, "")
    // Collapse excessive whitespace
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * deduplicateChunks()
 *
 * WHY: Chapter IDs like "QM.1" appear in the Table of Contents (short entry)
 * AND in the actual content (long detailed text). We want only the longest
 * version of each chapter.
 *
 * HOW: Use a Map keyed by chapter ID. If we see the same chapter again
 * and it's longer, replace the stored one.
 */
function deduplicateChunks(chunks: RawChunk[]): RawChunk[] {
  const map = new Map<string, RawChunk>();

  for (const chunk of chunks) {
    const existing = map.get(chunk.chapter);
    if (!existing || chunk.text.length > existing.text.length) {
      map.set(chunk.chapter, chunk);
    }
  }

  return Array.from(map.values());
}

// ─────────────────────────────────────────────
// SECTION 6: VOYAGE AI EMBEDDING
// ─────────────────────────────────────────────

/**
 * generateEmbeddings()
 *
 * HOW IT WORKS:
 * - Takes an array of text strings
 * - Sends them to Voyage AI's /v1/embeddings endpoint
 * - Returns an array of 1024-dimension vectors (one per input text)
 *
 * WHY batch? Sending 1 text at a time = slow (150 chunks = 150 HTTP requests).
 * Batching 20 at a time = 8 requests total. Much faster.
 *
 * IMPORTANT: input_type is "document" when embedding data for storage,
 * and "query" when embedding a user's search question. This tells Voyage AI
 * to optimize the embedding differently for each use case.
 *
 * WHAT IS AN EMBEDDING?
 * An embedding is a list of numbers (a "vector") that represents the MEANING
 * of text. Similar texts get similar vectors. "Fire safety" and "fire prevention"
 * will have vectors pointing in nearly the same direction, even though the
 * words are different. This is what enables semantic search.
 */
async function generateEmbeddings(texts: string[], retries = 3): Promise<number[][]> {
  const response = await fetch(CONFIG.voyageApiUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${CONFIG.voyageApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: texts,
      model: CONFIG.voyageModel,
      input_type: "document",   // "document" for data we're storing
    }),
  });

  // If rate limited (429), wait and retry instead of crashing
  if (response.status === 429 && retries > 0) {
    console.log(`   Rate limited! Waiting 90s before retry (${retries} retries left)...`);
    await new Promise((resolve) => setTimeout(resolve, 90000));
    return generateEmbeddings(texts, retries - 1);
  }

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Voyage AI API error (${response.status}): ${errorBody}`);
  }

  const result = (await response.json()) as { data: { embedding: number[] }[] };

  // result.data is an array of { embedding: number[] } objects
  // We extract just the embedding arrays
  return result.data.map((item) => item.embedding);
}

/**
 * generateEmbeddingsInBatches()
 *
 * WHY: Voyage AI has limits on how much text you can send per request.
 * We split our chunks into batches of 20 and process them sequentially.
 *
 * HOW:
 * 1. Slice the array into groups of batchSize
 * 2. Call generateEmbeddings() for each group
 * 3. Concat all results into one flat array
 * 4. Add a small delay between batches to avoid rate limits
 */
async function generateEmbeddingsInBatches(
  texts: string[],
  batchSize: number
): Promise<number[][]> {
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(texts.length / batchSize);

    console.log(`   Embedding batch ${batchNum}/${totalBatches} (${batch.length} chunks)...`);

    const embeddings = await generateEmbeddings(batch);
    allEmbeddings.push(...embeddings);

    // Delay between batches to respect rate limits (3 RPM without payment method)
    if (i + batchSize < texts.length) {
      console.log(`   Waiting 30s for rate limit...`);
      await new Promise((resolve) => setTimeout(resolve, 30000));
    }
  }

  return allEmbeddings;
}

// ─────────────────────────────────────────────
// SECTION 7: TOKEN COUNTING
// ─────────────────────────────────────────────

/**
 * estimateTokenCount()
 *
 * WHY: The challenge schema requires a token_count field.
 * Exact token counting requires a tokenizer library, but a rough estimate
 * is fine for this use case.
 *
 * HOW: English text averages about 1 token per 4 characters (or ~1.3 tokens
 * per word). We use the character-based approach for simplicity.
 */
function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─────────────────────────────────────────────
// SECTION 8: BUILD DOCUMENTS
// ─────────────────────────────────────────────

/**
 * buildDocuments()
 *
 * HOW: Takes chunks + their embeddings and combines them into the final
 * MongoDB document format that matches the challenge schema.
 *
 * chunk_id format: "QM_1_001"
 *   - QM       = section prefix
 *   - 1        = chapter number
 *   - 001      = sequential sub-chunk index (if a chapter was split further)
 */
function buildDocuments(
  chunks: RawChunk[],
  embeddings: number[][]
): StandardDocument[] {
  // Track how many sub-chunks each chapter has (for the _001 suffix)
  const chapterCounts = new Map<string, number>();

  return chunks.map((chunk, index) => {
    // Increment the sub-chunk counter for this chapter
    const count = (chapterCounts.get(chunk.chapter) || 0) + 1;
    chapterCounts.set(chunk.chapter, count);

    // Build chunk_id: "QM.1" -> "QM_1_001"
    const chunkId = `${chunk.chapter.replace(".", "_")}_${String(count).padStart(3, "0")}`;

    return {
      chunk_id: chunkId,
      text: chunk.text,
      metadata: {
        document: "NIAHO Standards",
        section: chunk.section,
        chapter: chunk.chapter,
      },
      embedding: embeddings[index],
      token_count: estimateTokenCount(chunk.text),
    };
  });
}

// ─────────────────────────────────────────────
// SECTION 9: MONGODB INSERT
// ─────────────────────────────────────────────

/**
 * insertIntoMongoDB()
 *
 * HOW IT WORKS:
 * 1. Connect to MongoDB Atlas using the connection string from .env
 * 2. Drop the existing collection (so re-running the script starts fresh)
 * 3. Insert all documents in one bulk operation (insertMany)
 * 4. Create an index on metadata.chapter for fast exact lookups
 * 5. Disconnect
 *
 * WHY insertMany? It's much faster than inserting one at a time.
 * MongoDB batches the writes internally.
 *
 * WHY create an index on metadata.chapter? When a user says "show me QM.1",
 * we do an exact match query on this field. An index makes that instant
 * instead of scanning every document.
 *
 * NOTE: The Vector Search index is created separately in the Atlas UI,
 * not here. MongoDB Atlas manages vector indexes through its own interface.
 */
async function insertIntoMongoDB(documents: StandardDocument[]): Promise<void> {
  console.log(`\nConnecting to MongoDB Atlas...`);

  const client = new MongoClient(CONFIG.mongoUri);

  try {
    await client.connect();
    console.log("   Connected successfully");

    const db = client.db(CONFIG.dbName);
    const collection = db.collection(CONFIG.collectionName);

    // Drop existing data so re-runs are clean
    await collection.drop().catch(() => {
      // Collection might not exist yet on first run — that's fine
      console.log("   Collection didn't exist yet, creating fresh");
    });

    // Insert all documents
    const result = await collection.insertMany(documents);
    console.log(`   Inserted ${result.insertedCount} documents`);

    // Create index for exact chapter lookups (get_standard_by_chapter tool)
    await collection.createIndex({ "metadata.chapter": 1 });
    console.log("   Created index on metadata.chapter");

    // Create index for section filtering (list_sections tool)
    await collection.createIndex({ "metadata.section": 1 });
    console.log("   Created index on metadata.section");

  } finally {
    await client.close();
    console.log("   Disconnected from MongoDB");
  }
}

// ─────────────────────────────────────────────
// SECTION 10: MAIN — ORCHESTRATES EVERYTHING
// ─────────────────────────────────────────────

/**
 * main()
 *
 * This is the entry point. It calls each step in order:
 * Extract PDF -> Chunk -> Embed -> Insert
 *
 * Each step feeds its output to the next step.
 */
async function main(): Promise<void> {
  console.log("NIAHO Standards — Database Seeding Script\n");
  console.log("=".repeat(50));

  // Validate environment variables exist
  if (!CONFIG.mongoUri) throw new Error("Missing MONGODB_URI in .env");
  if (!CONFIG.voyageApiKey) throw new Error("Missing VOYAGE_API_KEY in .env");

  // -- Step 1: Extract text from PDF --
  const rawText = await extractTextFromPdf(CONFIG.pdfPath);

  // -- Step 2: Chunk by chapter --
  const chunks = chunkByChapter(rawText);
  console.log(`\nChunk statistics:`);
  console.log(`   Total chunks: ${chunks.length}`);
  console.log(`   Sample chapters: ${chunks.slice(0, 5).map((c) => c.chapter).join(", ")}`);

  // -- Step 3: Generate embeddings --
  console.log(`\nGenerating embeddings via Voyage AI (${CONFIG.voyageModel})...`);
  // Truncate very long chunks to ~8000 chars (~2000 tokens) to avoid TPM limits
  const MAX_CHARS = 8000;
  const texts = chunks.map((c) => {
    if (c.text.length > MAX_CHARS) {
      console.log(`   Truncating ${c.chapter} from ${c.text.length} to ${MAX_CHARS} chars`);
      return c.text.slice(0, MAX_CHARS);
    }
    return c.text;
  });
  const embeddings = await generateEmbeddingsInBatches(texts, CONFIG.embeddingBatchSize);
  console.log(`   Generated ${embeddings.length} embeddings (${embeddings[0]?.length} dimensions each)`);

  // -- Step 4: Build final documents --
  const documents = buildDocuments(chunks, embeddings);

  // -- Step 5: Insert into MongoDB --
  await insertIntoMongoDB(documents);

  // -- Done! --
  console.log("\n" + "=".repeat(50));
  console.log("Seeding complete!");
  console.log(`   ${documents.length} chapters loaded into ${CONFIG.dbName}.${CONFIG.collectionName}`);
  console.log("\nNEXT STEP: Create the Vector Search index in the Atlas UI.");
  console.log("   Go to Atlas -> Browse Collections -> Search Indexes -> Create Index");
  console.log("   Use the JSON definition from the challenge spec.");
}

// Run it!
main().catch((error) => {
  console.error("\nFatal error:", error);
  process.exit(1);
});
