/**
 * Generates TEST_RESULTS.md by running all required test queries
 * against the tools directly (no LLM needed).
 * Run with: npx tsx scripts/generate-test-results.ts
 */
import * as fs from "fs";
import {
  searchStandards,
  getStandardByChapter,
  listSections,
  closeConnection,
} from "../src/tools.js";

// Helper to wait between API calls (Voyage AI 3 RPM limit)
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const QA_QUERIES = [
  "What are the requirements for quality improvement programs?",
  "Describe the infection control requirements for surgical areas",
  "How should hospitals handle medication errors?",
  "What are the staff competency assessment requirements?",
  "Explain the patient rights and responsibilities outlined in the standards",
];

const CITATION_CHAPTERS = [
  { query: "Show me chapter QM.1", id: "QM.1" },
  { query: "What does chapter LS.2 say exactly?", id: "LS.2" },
  { query: "Give me the exact text for chapter IC.3", id: "IC.3" },
  { query: "Cite chapter PE.1", id: "PE.1" },
  { query: "I need the verbatim language from chapter MM.2", id: "MM.2" },
];

const EDGE_QUERIES = [
  "patient safety",
  "hand hygiene",
  "medication administration and dispensing",
];

async function main() {
  let md = `# Test Results\n\n`;
  md += `Generated: ${new Date().toISOString()}\n\n`;
  md += `All queries were executed against the NIAHO standards knowledge base (169 chapters) using MongoDB Atlas Vector Search with Voyage AI embeddings (voyage-3-large, 1024 dimensions).\n\n`;
  md += `---\n\n`;

  // Q&A Mode
  for (const query of QA_QUERIES) {
    console.log(`Running Q&A: ${query}`);
    const results = await searchStandards(query, 5);
    await wait(25000); // 25s delay to respect 3 RPM rate limit
    md += `## [Q&A Mode] ${query}\n\n`;
    md += `**Tool called:** \`search_standards\`\n`;
    md += `**Parameters:** \`${JSON.stringify({ query, top_k: 5 })}\`\n\n`;
    md += `**Results:** ${results.length} matches\n\n`;
    for (const r of results) {
      md += `### ${r.chapter} - ${r.section} (Score: ${r.score.toFixed(4)})\n\n`;
      md += `\`\`\`\n${r.text.substring(0, 500)}${r.text.length > 500 ? "\n..." : ""}\n\`\`\`\n\n`;
    }
    md += `---\n\n`;
  }

  // Citation Mode
  for (const { query, id } of CITATION_CHAPTERS) {
    console.log(`Running Citation: ${id}`);
    const result = await getStandardByChapter(id);
    md += `## [Citation Mode] ${query}\n\n`;
    md += `**Tool called:** \`get_standard_by_chapter\`\n`;
    md += `**Parameters:** \`${JSON.stringify({ chapter_id: id })}\`\n\n`;
    if (result) {
      md += `**Document:** ${result.document}\n`;
      md += `**Section:** ${result.section}\n`;
      md += `**Chapter:** ${result.chapter}\n\n`;
      md += `\`\`\`\n${result.text.substring(0, 1000)}${result.text.length > 1000 ? "\n..." : ""}\n\`\`\`\n\n`;
    } else {
      md += `**Result:** Chapter not found\n\n`;
    }
    md += `---\n\n`;
  }

  // Edge Case: search queries
  for (const query of EDGE_QUERIES) {
    console.log(`Running Edge: ${query}`);
    const results = await searchStandards(query, 5);
    await wait(25000);
    md += `## [Edge Case] Chapters related to "${query}"\n\n`;
    md += `**Tool called:** \`search_standards\`\n`;
    md += `**Parameters:** \`${JSON.stringify({ query, top_k: 5 })}\`\n\n`;
    md += `**Results:** ${results.length} matches\n\n`;
    for (const r of results) {
      md += `### ${r.chapter} - ${r.section} (Score: ${r.score.toFixed(4)})\n\n`;
      md += `\`\`\`\n${r.text.substring(0, 500)}${r.text.length > 500 ? "\n..." : ""}\n\`\`\`\n\n`;
    }
    md += `---\n\n`;
  }

  // Edge Case: list all sections
  console.log("Running Edge: list all sections");
  const allSections = await listSections();
  md += `## [Edge Case] List all sections available\n\n`;
  md += `**Tool called:** \`list_sections\`\n`;
  md += `**Parameters:** \`{}\`\n\n`;
  md += `**Sections found:** ${allSections.length}\n\n`;
  for (const s of allSections) {
    md += `- **${s.section}** (${s.chapterCount} chapters): ${s.chapters.join(", ")}\n`;
  }
  md += `\n---\n\n`;

  // Edge Case: filter sections
  console.log("Running Edge: list infection control chapters");
  const icSections = await listSections("Infection");
  md += `## [Edge Case] List infection control chapters\n\n`;
  md += `**Tool called:** \`list_sections\`\n`;
  md += `**Parameters:** \`${JSON.stringify({ section_filter: "Infection" })}\`\n\n`;
  md += `**Sections found:** ${icSections.length}\n\n`;
  for (const s of icSections) {
    md += `- **${s.section}** (${s.chapterCount} chapters): ${s.chapters.join(", ")}\n`;
  }
  md += `\n`;

  fs.writeFileSync("TEST_RESULTS.md", md);
  console.log("\n✅ TEST_RESULTS.md generated!");
  await closeConnection();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
