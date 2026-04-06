/**
 * Quick test script for tools.ts functions
 * Run with: npx tsx scripts/test-tools.ts
 */
import { searchStandards, getStandardByChapter, listSections, closeConnection } from "../src/tools.js";

async function test() {
  console.log("=== Test 1: list_sections (filter: Infection) ===");
  const sections = await listSections("Infection");
  console.log(JSON.stringify(sections, null, 2));

  console.log("\n=== Test 2: get_standard_by_chapter (IC.3) ===");
  const chapter = await getStandardByChapter("IC.3");
  console.log("Found:", !!chapter, "| Chapter:", chapter?.chapter, "| Text length:", chapter?.text?.length);

  console.log("\n=== Test 3: search_standards (medication errors) ===");
  const results = await searchStandards("medication error requirements", 3);
  console.log("Results:", results.length);
  results.forEach((r, i) =>
    console.log(`  ${i + 1}. ${r.chapter} (${r.section}) score=${r.score.toFixed(4)}`)
  );

  await closeConnection();
  console.log("\n✅ All tests passed!");
}

test().catch((e) => {
  console.error(e);
  process.exit(1);
});
