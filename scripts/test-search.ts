import { searchStandards, closeConnection } from "../src/tools.js";

async function test() {
  const r = await searchStandards("infection control", 2);
  console.log("Results:", r.length);
  r.forEach((x) => console.log(x.chapter, x.score.toFixed(4)));
  await closeConnection();
}
test();
