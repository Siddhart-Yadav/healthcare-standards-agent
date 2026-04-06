/**
 * run-test-queries.ts
 *
 * Runs all challenge test queries against the tools directly
 * and outputs formatted results for TEST_RESULTS.md
 *
 * Run with: npx tsx scripts/run-test-queries.ts
 */

import { searchStandards, getStandardByChapter, listSections, closeConnection } from "../src/tools.js";

interface TestQuery {
  mode: string;
  query: string;
  tool: string;
  params: any;
}

const testQueries: TestQuery[] = [
  // Q&A Mode Queries
  { mode: "Q&A", query: "What are the requirements for quality improvement programs?", tool: "search_standards", params: { query: "requirements for quality improvement programs", top_k: 5 } },
  { mode: "Q&A", query: "Describe the infection control requirements for surgical areas", tool: "search_standards", params: { query: "infection control requirements for surgical areas", top_k: 5 } },
  { mode: "Q&A", query: "How should hospitals handle medication errors?", tool: "search_standards", params: { query: "hospitals handle medication errors", top_k: 5 } },
  { mode: "Q&A", query: "What are the staff competency assessment requirements?", tool: "search_standards", params: { query: "staff competency assessment requirements", top_k: 5 } },
  { mode: "Q&A", query: "Explain the patient rights and responsibilities outlined in the standards", tool: "search_standards", params: { query: "patient rights and responsibilities", top_k: 5 } },

  // Citation Mode Queries
  { mode: "Citation", query: "Show me chapter QM.1", tool: "get_standard_by_chapter", params: { chapter_id: "QM.1" } },
  { mode: "Citation", query: "What does chapter LS.2 say exactly?", tool: "get_standard_by_chapter", params: { chapter_id: "LS.2" } },
  { mode: "Citation", query: "Give me the exact text for chapter IC.3", tool: "get_standard_by_chapter", params: { chapter_id: "IC.3" } },
  { mode: "Citation", query: "Cite chapter PE.1", tool: "get_standard_by_chapter", params: { chapter_id: "PE.1" } },
  { mode: "Citation", query: "I need the verbatim language from chapter MM.2", tool: "get_standard_by_chapter", params: { chapter_id: "MM.2" } },

  // Edge Case Queries
  { mode: "Edge", query: "Chapters related to patient safety", tool: "search_standards", params: { query: "patient safety", top_k: 5 } },
  { mode: "Edge", query: "List all sections available", tool: "list_sections", params: {} },
  { mode: "Edge", query: "List infection control chapters", tool: "list_sections", params: { section_filter: "Infection" } },
];

async function main() {
  let output = `# Test Results\n\nGenerated: ${new Date().toISOString()}\n\n`;
  output += `All queries were executed against the NIAHO standards knowledge base (183 chapters) using MongoDB Atlas Vector Search with Voyage AI embeddings (voyage-3-large, 1024 dimensions).\n\n`;

  for (const test of testQueries) {
    console.log(`Running [${test.mode}]: ${test.query}`);
    output += `---\n\n## [${test.mode} Mode] ${test.query}\n\n`;
    output += `**Tool called:** \`${test.tool}\`\n`;
    output += `**Parameters:** \`${JSON.stringify(test.params)}\`\n\n`;

    try {
      if (test.tool === "search_standards") {
        const results = await searchStandards(test.params.query, test.params.top_k);
        output += `**Results:** ${results.length} matches\n\n`;
        for (const r of results) {
          output += `### ${r.chapter} - ${r.section} (Score: ${r.score.toFixed(4)})\n\n`;
          output += `\`\`\`\n${r.text.slice(0, 500)}${r.text.length > 500 ? "\n..." : ""}\n\`\`\`\n\n`;
        }
      } else if (test.tool === "get_standard_by_chapter") {
        const result = await getStandardByChapter(test.params.chapter_id);
        if (result) {
          output += `**Document:** ${result.document}\n`;
          output += `**Section:** ${result.section}\n`;
          output += `**Chapter:** ${result.chapter}\n\n`;
          output += `\`\`\`\n${result.text.slice(0, 800)}${result.text.length > 800 ? "\n..." : ""}\n\`\`\`\n\n`;
        } else {
          output += `**Result:** Chapter not found\n\n`;
        }
      } else if (test.tool === "list_sections") {
        const sections = await listSections(test.params.section_filter);
        output += `**Sections found:** ${sections.length}\n\n`;
        for (const s of sections) {
          output += `- **${s.section}** (${s.chapterCount} chapters): ${s.chapters.join(", ")}\n`;
        }
        output += `\n`;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      output += `**Error:** ${msg}\n\n`;
    }

    // Rate limit for Voyage AI
    if (test.tool === "search_standards") {
      console.log("  Waiting 25s for rate limit...");
      await new Promise(r => setTimeout(r, 25000));
    }
  }

  // Write to file
  const fs = await import("fs");
  const path = await import("path");
  const outPath = path.resolve(__dirname, "../TEST_RESULTS.md");
  fs.writeFileSync(outPath, output);
  console.log(`\nDone! Results written to TEST_RESULTS.md`);

  await closeConnection();
}

main().catch(e => { console.error(e); process.exit(1); });
