// run-pipeline.mjs — chain the whole data engine. Each step is isolated in its
// own try/catch so one failure doesn't kill the rest. Prints a short summary.
//
// Run: node screener-test/run-pipeline.mjs   (LIMIT=3 for a quick smoke test)
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main as scrape } from "./scrape-announcements.mjs";
import { main as extract } from "./extract-events.mjs";
import { main as enrich } from "./enrich-sectors.mjs";
import { main as build } from "./build-events.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(path.resolve(HERE, ".."), "public", "data");

async function step(name, fn) {
  const t = Date.now();
  console.log(`\n=== ${name} ===`);
  try {
    await fn();
    console.log(`--- ${name} done in ${((Date.now() - t) / 1000).toFixed(1)}s ---`);
    return true;
  } catch (e) {
    console.error(`!!! ${name} FAILED: ${e?.stack || e}`);
    return false;
  }
}

async function main() {
  console.log("Meets Tracker pipeline start", new Date().toISOString());
  await step("scrape-announcements", scrape);
  await step("extract-events", extract);
  await step("enrich-sectors", enrich);
  await step("build-events", build);

  try {
    const ev = JSON.parse(await fs.readFile(path.join(DATA, "events.json"), "utf8"));
    console.log(`\nSUMMARY: ${ev.count} upcoming events • generated_at ${ev.generated_at}`);
    for (const e of ev.events.slice(0, 5)) {
      console.log(`  • ${e.event_date}  ${e.company || "?"}  [${e.event_type}]  ${e.counterparty || ""}  ${e.pdf_url || ""}`);
    }
  } catch {
    console.log("\nSUMMARY: events.json not available (check step logs above).");
  }
  console.log("\nMeets Tracker pipeline done", new Date().toISOString());
}

main();
