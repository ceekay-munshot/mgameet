// extract-events.mjs — turn each announcement PDF into structured event rows via Claude (Bedrock).
//
// Store: public/data/_raw-events.json
//   { [announcementId]: { announced_at, company, company_url, heading, pdf_url, events:[...] } }
//   Presence of an id == already processed -> skipped (incremental; we never re-send a PDF to Claude).
//
// Env: LIMIT caps NEW PDFs per run (0 = all). FORCE=1 reprocesses everything.
//   Requires BEDROCK_API_KEY (+ region/model). HEADFUL=1 to watch the browser.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, UA, sleep, fetchPdf, extractPdfText, makeEnsureNsePrimed, istToday, readJson, writeJson } from "./helpers.mjs";
import { llmAvailable, callText, callWithPdf, extractJson } from "./llm.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUT = path.join(HERE, "output");
const DATA = path.join(ROOT, "public", "data");

const SYSTEM =
  "You read Indian stock-exchange (BSE/NSE) disclosure PDFs about upcoming analyst/investor interactions, filed under SEBI LODR Regulation 30. Extract every scheduled interaction. Respond with STRICT JSON only — no prose, no markdown.";

function promptHead(company, today, heading) {
  return `Company: ${company || "Unknown"}
Today's date: ${today}
Heading: ${heading || ""}

Return JSON exactly like:
{ "events": [ {
  "event_date": "YYYY-MM-DD",   // THE MEETING/EVENT DATE — never the letter/filing date. Required.
  "event_time": "HH:MM" or null,
  "event_type": "One-on-One | Group Meeting | Analyst Meet | Investor Meet | Conference | Plant Visit | Investor Day | Earnings Call | Other",
  "mode": "Virtual | In-person | Hybrid" or null,
  "counterparty": "the fund / analyst / investor / conference name (e.g. 'Swoys India Alpha Fund', 'Anand Rathi G-200 Summit')" or null,
  "venue": "city / location / platform" or null
} ] }
Rules: One row per meeting date/counterparty. If a row has no clear MEETING date, skip it. Resolve bare dates (e.g. "18 September") to the nearest future year using Today. Conferences -> event_type "Conference", counterparty = conference name. Use null when not stated; never invent. If the PDF is not about an upcoming meeting, return {"events": []}. JSON only.`;
}
const instructionText = (company, today, heading, text) =>
  `${promptHead(company, today, heading)}
PDF TEXT (may be truncated):
"""${String(text || "").slice(0, 20000)}"""`;
const instructionPdf = (company, today, heading) =>
  `${promptHead(company, today, heading)}
The announcement PDF is attached. Read it and extract the events.`;

export async function main() {
  if (!llmAvailable) {
    console.log("extract-events: BEDROCK_API_KEY not set — skipping LLM extraction.");
    return;
  }
  const today = istToday();
  const LIMIT = parseInt(process.env.LIMIT || "0", 10) || 0;
  const FORCE = !!process.env.FORCE;
  // Wall-clock budget so a big backlog can never overrun the CI job timeout and
  // lose the whole run's commit. The index is newest-first, so the freshest
  // filings (the ones with upcoming meetings) are always processed first; any
  // remainder is picked up incrementally on the next run.
  const BUDGET_MS = (parseInt(process.env.EXTRACT_BUDGET_MIN || "", 10) || 25) * 60 * 1000;
  const startedAt = Date.now();

  const idx = await readJson(path.join(OUT, "announcements-index.json"), []);
  const store = await readJson(path.join(DATA, "_raw-events.json"), {});
  console.log(`extract-events: ${idx.length} announcements in index, ${Object.keys(store).length} already processed. LIMIT=${LIMIT || "all"} budget=${Math.round(BUDGET_MS / 60000)}m FORCE=${FORCE}`);

  let processed = 0, totalEvents = 0, fetchFails = 0, skipped = 0, budgetHit = false;
  const browser = await chromium.launch({ headless: !process.env.HEADFUL });
  const context = await browser.newContext({ userAgent: UA, acceptDownloads: true });
  const page = await context.newPage();
  const ensureNsePrimed = makeEnsureNsePrimed(page);

  try {
    for (const a of idx) {
      if (!FORCE && store[a.id]) { skipped++; continue; }
      if (LIMIT && processed >= LIMIT) break;
      if (Date.now() - startedAt > BUDGET_MS) {
        budgetHit = true;
        console.log(`  … ${Math.round(BUDGET_MS / 60000)}m time budget reached — committing ${processed} now; the rest continue next run`);
        break;
      }

      const buf = await fetchPdf(context, page, a.pdf_url, ensureNsePrimed);
      if (!buf) {
        // No Claude call happened, so leave it unrecorded and retry next run.
        fetchFails++;
        console.log(`  ! no PDF  ${a.company || a.id}  (${a.pdf_url})`);
        continue;
      }

      let text = "";
      try { text = await extractPdfText(buf); } catch { text = ""; }

      let parsed = null;
      try {
        const raw = text.length >= 200
          ? await callText(SYSTEM, instructionText(a.company, today, a.heading, text))
          : await callWithPdf(SYSTEM, instructionPdf(a.company, today, a.heading), buf);
        parsed = extractJson(raw);
      } catch (e) {
        console.log(`  ! LLM error  ${a.company || a.id}: ${String(e?.message || e).slice(0, 160)}`);
      }

      const events = Array.isArray(parsed?.events) ? parsed.events : [];
      // Record even when empty/failed-parse so it counts as processed (never re-sent to Claude).
      store[a.id] = {
        announced_at: a.announced_at,
        company: a.company,
        company_url: a.company_url,
        heading: a.heading,
        pdf_url: a.pdf_url,
        events,
      };
      processed++;
      totalEvents += events.length;
      console.log(`  + ${String(events.length).padStart(2)} events  ${a.company || a.id}  (${text.length >= 200 ? "text" : "pdf"})`);
      await sleep(800); // gentle on Bedrock
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  await writeJson(path.join(DATA, "_raw-events.json"), store);
  const remaining = idx.filter((a) => !store[a.id]).length;
  console.log(`extract-events: +${totalEvents} events from ${processed} PDFs (skipped ${skipped} processed, ${fetchFails} fetch fails)${budgetHit ? `; ${remaining} left for next run` : ""}`);
  return store;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
