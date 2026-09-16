// build-events.mjs — publish the forward-looking events.json + metadata.json.
//
// Reads:  public/data/_raw-events.json, public/data/company-meta.json
// Writes: public/data/events.json, public/data/metadata.json
//   Keeps only events with today <= event_date <= today + HORIZON_DAYS (default 60),
//   attaches company sector/industry/sub_industry/ticker, dedupes + sorts by date.
//
// Env: HORIZON_DAYS (default 60).
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pad, slugify, istToday, addDays, ymdDiffDays, readJson, writeJson } from "./helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DATA = path.join(ROOT, "public", "data");

const BACKFILL_DAYS = 15;

const TYPES = ["One-on-One", "Group Meeting", "Analyst Meet", "Investor Meet", "Conference", "Plant Visit", "Investor Day", "Earnings Call", "Other"];
function cleanType(t) {
  if (!t) return "Other";
  const s = String(t).trim();
  const hit = TYPES.find((x) => x.toLowerCase() === s.toLowerCase());
  return hit || "Other";
}

// Model is asked for YYYY-MM-DD; be defensive about a few other shapes anyway.
function normalizeDate(s) {
  if (!s) return null;
  s = String(s).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) { const y = +m[1], mo = +m[2], d = +m[3]; if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${pad(mo)}-${pad(d)}`; }
  m = s.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})$/);
  if (m) { let d = +m[1], mo = +m[2], y = +m[3]; if (y < 100) y += 2000; if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${pad(mo)}-${pad(d)}`; }
  return null;
}

export async function main() {
  const today = istToday();
  const HORIZON = parseInt(process.env.HORIZON_DAYS || "60", 10) || 60;
  const store = await readJson(path.join(DATA, "_raw-events.json"), {});
  const meta = await readJson(path.join(DATA, "company-meta.json"), {});
  const prior = await readJson(path.join(DATA, "events.json"), { events: [] });
  const firstSeenById = new Map((prior.events || []).map((e) => [e.id, e.first_seen]));
  const generated_at = new Date().toISOString();

  const byId = new Map();
  for (const entry of Object.values(store)) {
    if (!entry || !Array.isArray(entry.events)) continue;
    const cm = meta[entry.company_url] || {};
    for (const ev of entry.events) {
      const event_date = normalizeDate(ev.event_date);
      if (!event_date) continue; // meeting date is king — no date, no row
      const dd = ymdDiffDays(event_date, today);
      if (dd < 0 || dd > HORIZON) continue; // forward-looking, within horizon
      const event_type = cleanType(ev.event_type);
      const counterparty = ev.counterparty ? String(ev.counterparty).trim() : null;
      const id = slugify(`${entry.company || ""}|${event_date}|${event_type}|${counterparty || ""}`);
      if (byId.has(id)) continue;
      byId.set(id, {
        id,
        company: entry.company || null,
        company_url: entry.company_url || null,
        ticker: cm.ticker || null,
        sector: cm.sector || null,
        industry: cm.industry || null,
        sub_industry: cm.sub_industry || null,
        event_type,
        event_date,
        event_time: ev.event_time || null,
        mode: ev.mode || null,
        counterparty,
        venue: ev.venue || null,
        heading: entry.heading || null,
        announced_at: entry.announced_at || null,
        pdf_url: entry.pdf_url || null,
        first_seen: firstSeenById.get(id) || generated_at,
      });
    }
  }

  const events = [...byId.values()].sort((a, b) =>
    a.event_date < b.event_date ? -1 : a.event_date > b.event_date ? 1 : String(a.company || "").localeCompare(String(b.company || "")));

  await writeJson(path.join(DATA, "events.json"), {
    generated_at,
    backfill_days: BACKFILL_DAYS,
    horizon_days: HORIZON,
    count: events.length,
    events,
  });

  const in7 = addDays(today, 7);
  const types = {};
  for (const e of events) types[e.event_type] = (types[e.event_type] || 0) + 1;
  const metadata = {
    updated_at: generated_at,
    total_upcoming: events.length,
    today_count: events.filter((e) => e.event_date === today).length,
    week_count: events.filter((e) => e.event_date >= today && e.event_date <= in7).length,
    companies: new Set(events.map((e) => e.company).filter(Boolean)).size,
    types,
  };
  await writeJson(path.join(DATA, "metadata.json"), metadata);

  // Prune the raw store to keep it small — but never in a way that would cause a
  // re-send to Claude. Keep an entry if it's still inside the 15-day scrape window
  // (it could reappear in the index) OR it still has a recent/upcoming event.
  let pruned = 0;
  for (const [id, entry] of Object.entries(store)) {
    const evs = Array.isArray(entry.events) ? entry.events : [];
    const withinScrape = entry.announced_at && ymdDiffDays(today, entry.announced_at) <= BACKFILL_DAYS;
    const hasRecentEvent = evs.some((e) => { const d = normalizeDate(e.event_date); return d && ymdDiffDays(d, today) >= -3; });
    if (!withinScrape && !hasRecentEvent) { delete store[id]; pruned++; }
  }
  if (pruned) await writeJson(path.join(DATA, "_raw-events.json"), store);

  console.log(`build-events: ${events.length} upcoming (${metadata.today_count} today, ${metadata.week_count} this week, ${metadata.companies} companies); pruned ${pruned} old raw entries -> public/data/events.json`);
  return { events, metadata };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
