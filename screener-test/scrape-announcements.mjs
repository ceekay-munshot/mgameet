// scrape-announcements.mjs — collect the Screener announcements feed.
//
// Output: screener-test/output/announcements-index.json
//   [ { id, company, company_url, heading, announced_at, pdf_url } ]
//   id = stable slug of pdf_url. Deduped by id. Filtered to investor-engagement
//   headings, and to announcements filed within the last 15 days (IST).
//
// Env: SCREENER_EMAIL, SCREENER_PASSWORD (required); SCREENER_FILTER_URL (optional
//   saved-filter feed); HEADFUL=1 (see the browser), DEBUG=1 (dump page HTML + counts).
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, ORIGIN, UA, sleep, login, slugify, istToday, addDays, ymdDiffDays, pad } from "./helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "output");

const BACKFILL_DAYS = 15;
const MAX_PAGES = 40;

// Investor-engagement heading filter (kept even for saved-filter feeds).
const KEYWORDS =
  /(analyst|investor)\s*\/?\s*(meet|day)|plant\s*visit|institutional\s*investor|investor\s*meet|analyst\s*meet|conference|road\s*show|investor\s*presentation|schedule\s*of\s*(analyst|investor)/i;

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function monthNum(word) {
  if (!word) return null;
  const w = word.toLowerCase();
  return MONTHS[w.slice(0, 4)] || MONTHS[w.slice(0, 3)] || null;
}

// Parse "2 days ago" / "7m ago" / "yesterday" / "12 Sep 2026" → YYYY-MM-DD (IST).
function parseWhen(text, today) {
  if (!text) return null;
  const t = String(text).toLowerCase().trim();
  if (/just now|moments ago|few seconds|seconds? ago/.test(t)) return today;
  if (/\byesterday\b/.test(t)) return addDays(today, -1);
  if (/\btoday\b/.test(t)) return today;
  let m;
  if ((m = t.match(/(\d+)\s*(?:minutes?|mins?|m)\s*ago/))) return today;
  if ((m = t.match(/(\d+)\s*(?:hours?|hrs?|h)\s*ago/))) return today;
  if ((m = t.match(/(\d+)\s*(?:days?|d)\s*ago/))) return addDays(today, -parseInt(m[1], 10));
  if ((m = t.match(/(\d+)\s*(?:weeks?|wks?|w)\s*ago/))) return addDays(today, -7 * parseInt(m[1], 10));
  if ((m = t.match(/(\d+)\s*(?:months?|mo)\s*ago/))) return addDays(today, -30 * parseInt(m[1], 10));
  if (/\ban? (?:hour|minute|min|moment|second)\b/.test(t) && /ago/.test(t)) return today;
  if (/\ban? day\b/.test(t) && /ago/.test(t)) return addDays(today, -1);
  // absolute "12 Sep 2026" / "12 September" / "12 Sep"
  if ((m = t.match(/(\d{1,2})\s+([a-z]{3,9})\.?(?:\s+(\d{4}))?/))) {
    const mon = monthNum(m[2]);
    if (mon) {
      const day = parseInt(m[1], 10);
      const year = m[3] ? parseInt(m[3], 10) : parseInt(today.slice(0, 4), 10);
      let cand = `${year}-${pad(mon)}-${pad(day)}`;
      if (!m[3] && cand > today) cand = `${year - 1}-${pad(mon)}-${pad(day)}`; // filing dates are past
      return cand;
    }
  }
  // "Sep 12, 2026"
  if ((m = t.match(/([a-z]{3,9})\.?\s+(\d{1,2}),?(?:\s+(\d{4}))?/))) {
    const mon = monthNum(m[1]);
    if (mon) {
      const day = parseInt(m[2], 10);
      const year = m[3] ? parseInt(m[3], 10) : parseInt(today.slice(0, 4), 10);
      return `${year}-${pad(mon)}-${pad(day)}`;
    }
  }
  // dd-mm-yyyy / dd/mm/yyyy
  if ((m = t.match(/(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})/))) {
    let d = +m[1], mo = +m[2], y = +m[3];
    if (y < 100) y += 2000;
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${pad(mo)}-${pad(d)}`;
  }
  return null;
}

function pageUrl(base, p) {
  const u = new URL(base);
  u.searchParams.set("p", String(p));
  return u.toString();
}

function cleanHeading(rowText, company) {
  let h = rowText || "";
  if (company) h = h.split(company).join(" ");
  h = h.replace(/\b(just now|yesterday|today|\d+\s*(?:seconds?|sec|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|mo)\s*ago)\b/gi, " ");
  h = h.replace(/\bBSE\b|\bNSE\b|\bsource\b|\battachment\b/gi, " ");
  return h.replace(/\s{2,}/g, " ").trim() || rowText;
}

// Pull candidate rows out of the DOM. We anchor on the source PDF link (each row
// has exactly one BSE/NSE link) and climb to the container that also holds the
// /company/ link — robust to Screener markup changes.
async function extractRows(page) {
  return await page.$$eval("a", (anchors) => {
    const isPdf = (h) => /bseindia\.com|nseindia\.com/i.test(h || "");
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    const seen = new Set();
    const rows = [];
    for (const a of anchors) {
      if (!isPdf(a.href)) continue;
      let el = a, container = null;
      for (let i = 0; i < 8 && el; i++) {
        el = el.parentElement;
        if (el && el.querySelector && el.querySelector('a[href*="/company/"]')) { container = el; break; }
      }
      if (!container) container = a.closest("li, tr, div") || a.parentElement || a;
      const companyA = container.querySelector('a[href*="/company/"]');
      const rowText = clean(container.innerText || container.textContent);
      const key = a.href + "|" + rowText.slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      let timeGuess = "";
      const timeEl = container.querySelector('time, .ink-600, .sub, .smaller, [class*="time"], [class*="ago"]');
      if (timeEl) timeGuess = clean(timeEl.innerText || timeEl.textContent);
      rows.push({
        company: companyA ? clean(companyA.innerText || companyA.textContent) : "",
        company_url: companyA ? companyA.href : "",
        pdf_url: a.href,
        headingGuess: clean(a.innerText || a.textContent),
        timeGuess,
        rowText,
      });
    }
    return rows;
  });
}

function resolveWhen(r, today) {
  return parseWhen(r.timeGuess, today) || parseWhen(r.rowText, today) || null;
}

// The Screener announcements feed lazy-loads more rows as you scroll (grouped by
// day). Scroll to the bottom repeatedly until we've loaded past the 15-day window
// or the list stops growing — so we capture EVERY filing in the window, not just
// the first screen. Returns { rows, reached } where reached = we scrolled past the window.
// Click the feed's "Show More" control (button or link) if present. Returns true if clicked.
async function clickShowMore(page) {
  const loc = page.locator("button, a").filter({ hasText: /^\s*(show|load|view)\s+more\s*$/i }).first();
  try {
    if (await loc.count()) {
      await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      await loc.click({ timeout: 3000 });
      return true;
    }
  } catch {}
  return false;
}

// The Screener filter feed paginates via a "Show More" button (AJAX-appends the
// next chunk; no ?p= URLs). Click it repeatedly — waiting for the row count to
// grow after each click and ACCUMULATING rows (so a transient re-render never
// loses what we've seen) — until we've loaded past the 15-day window, the button
// disappears, or growth stalls. Returns every filing in the window.
async function loadFeed(page, today) {
  const acc = new Map(); // pdf_url -> row (dedup + survives DOM re-renders)
  const domCount = () => page.evaluate(() => document.querySelectorAll('a[href*="/company/"]').length).catch(() => 0);
  const grab = async () => { for (const r of await extractRows(page)) if (r.pdf_url) acc.set(r.pdf_url, r); };
  // Oldest announcement age (days) among rows we can date. Used only to know when
  // we've clearly loaded PAST the window — with a +10d margin so a single old row
  // near the boundary can't stop us early and undercount.
  const oldestAge = () => { let o = -1; for (const r of acc.values()) { const d = resolveWhen(r, today); if (d) { const a = ymdDiffDays(today, d); if (a > o) o = a; } } return o; };

  await grab();
  let clicks = 0, stagnant = 0;
  for (let i = 0; i < 25; i++) {
    if (oldestAge() > BACKFILL_DAYS + 10) break; // loaded well past the 15-day window -> we have all of it
    const before = await domCount();
    if (!(await clickShowMore(page))) break; // no more "Show More" -> the whole feed is loaded
    clicks++;
    for (let w = 0; w < 20; w++) { await sleep(500); if ((await domCount()) > before) break; } // wait for AJAX growth
    const prev = acc.size;
    await grab();
    if (acc.size <= prev) { if (++stagnant >= 2) break; } else { stagnant = 0; }
  }
  const reached = oldestAge() > BACKFILL_DAYS;
  console.log(`  [feed] loaded ${acc.size} rows via ${clicks} "Show More" click(s); oldest≈${oldestAge()}d back, reached=${reached}`);
  return { rows: [...acc.values()], reached };
}

export async function main() {
  const today = istToday();
  const base = process.env.SCREENER_FILTER_URL || `${ORIGIN}/announcements/`;
  console.log(`scrape-announcements: feed=${base} today=${today} window=${BACKFILL_DAYS}d`);
  if (!process.env.SCREENER_EMAIL || !process.env.SCREENER_PASSWORD)
    throw new Error("SCREENER_EMAIL / SCREENER_PASSWORD not set.");

  const browser = await chromium.launch({ headless: !process.env.HEADFUL });
  const context = await browser.newContext({ userAgent: UA });
  const page = await context.newPage();
  const kept = new Map();

  try {
    await login(page);
    await fs.mkdir(OUT, { recursive: true });
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector('a[href*="/company/"]', { timeout: 15000 }).catch(() => {});
    await sleep(800);
    const { rows: raw, reached } = await loadFeed(page, today); // click "Show More" to load the whole window
    if (process.env.DEBUG) { await fs.writeFile(path.join(OUT, "debug-feed.html"), await page.content()); }

    let inWindow = 0;
    for (const r of raw) {
      const announced_at = resolveWhen(r, today) || today; // assume fresh if unparseable
      const age = ymdDiffDays(today, announced_at);
      if (!(age >= 0 && age <= BACKFILL_DAYS)) continue;
      inWindow++;
      if (!KEYWORDS.test(`${r.headingGuess} ${r.rowText}`)) continue;
      const id = slugify(r.pdf_url);
      if (kept.has(id)) continue;
      const heading = r.headingGuess && r.headingGuess.length >= 8 ? r.headingGuess : cleanHeading(r.rowText, r.company);
      kept.set(id, {
        id,
        company: r.company || null,
        company_url: r.company_url || null,
        heading,
        announced_at,
        pdf_url: r.pdf_url,
      });
    }
    console.log(`  loaded ${raw.length} feed rows, ${inWindow} inside the ${BACKFILL_DAYS}-day window, kept ${kept.size} investor-engagement (reached=${reached})`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  const arr = [...kept.values()];
  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, "announcements-index.json"), JSON.stringify(arr, null, 2));
  console.log(`scrape-announcements: kept ${arr.length} investor-engagement rows -> output/announcements-index.json`);
  return arr;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
