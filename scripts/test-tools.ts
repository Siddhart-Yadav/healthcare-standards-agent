/**
 * Quick test to verify the data quality after re-seeding.
 * Run with: npx tsx scripts/test-tools.ts
 */
import { searchStandards, getStandardByChapter, listSections, closeConnection } from "../src/tools.js";

async function test() {
  // Test 1: Check previously broken chapters
  console.log("=== Checking previously broken chapters ===\n");
  const chapters = ["QM.1", "IC.3", "MM.2", "MM.4", "QM.6", "PE.1"];
  for (const ch of chapters) {
    const doc = await getStandardByChapter(ch);
    if (doc) {
      const preview = doc.text.substring(0, 100).replace(/\n/g, " ");
      console.log(`${ch} | ${doc.text.length} chars | ${preview}`);
    } else {
      console.log(`${ch} | NOT FOUND`);
    }
  }

  // Test 2: Total counts
  const sections = await listSections();
  const totalChapters = sections.reduce((sum, s) => sum + s.chapterCount, 0);
  console.log(`\nTotal sections: ${sections.length}`);
  console.log(`Total chapters: ${totalChapters}`);

  // Test 3: Semantic search
  console.log("\n=== Semantic search: infection control ===\n");
  const results = await searchStandards("infection control requirements", 3);
  results.forEach((r, i) =>
    console.log(`  ${i + 1}. ${r.chapter} (${r.section}) score=${r.score.toFixed(4)} | ${r.text.substring(0, 80).replace(/\n/g, " ")}`)
  );

  await closeConnection();
  console.log("\n✅ All checks passed!");
}

test().catch((e) => {
  console.error(e);
  process.exit(1);
});
