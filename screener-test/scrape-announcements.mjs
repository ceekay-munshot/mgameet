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

function cleanHeading(rowText, company) {
  let h = rowText || "";
  if (company) h = h.split(company).join(" ");
  h = h.replace(/\b(just now|yesterday|today|\d+\s*(?:seconds?|sec|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|mo)\s*ago)\b/gi, " ");
  h = h.replace(/\bBSE\b|\bNSE\b|\bsource\b|\battachment\b/gi, " ");
  return h.replace(/\s{2,}/g, " ").trim() || rowText;
}

// Pull candidate rows out of the DOM AND attach each row's day-group date.
//
// The feed is a flat, reverse-chronological list broken up by absolute
// day-group headers ("Today" / "Yesterday" / "Sep 15, 2026"); the rows under a
// header have NO date of their own. So we:
//   1. anchor on each row's source PDF link and climb to the container that also
//      holds the /company/ link (robust to Screener markup changes),
//   2. find the smallest element that contains every row (the feed list) — this
//      excludes stray dates elsewhere on the page (filter metadata, footer),
//   3. walk header + row elements in document order, carrying the current
//      header down onto every row that follows it, as `headerText`.
// A row's date comes ONLY from its header — never from the row's own body text,
// which often mentions unrelated old dates (year-ended, AGM, etc.).
async function extractRows(page) {
  return await page.evaluate(() => {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    const isPdf = (h) => /bseindia\.com|nseindia\.com/i.test(h || "");
    // A day-group header: "Today" / "Yesterday" / "Mon, Sep 15, 2026" / "15 Sep 2026".
    const isHdr = (t) =>
      /^(today|yesterday)$/i.test(t) ||
      /^(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s*)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+20\d\d$/i.test(t) ||
      /^\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+20\d\d$/i.test(t);

    // 1) rows
    const rows = [], containers = [], seen = new Set();
    for (const a of document.querySelectorAll("a")) {
      if (!isPdf(a.href)) continue;
      let el = a, container = null;
      for (let i = 0; i < 8 && el; i++) {
        el = el.parentElement;
        if (el && el.querySelector && el.querySelector('a[href*="/company/"]')) { container = el; break; }
      }
      if (!container) container = a.closest("li, tr, div") || a.parentElement || a;
      const rowText = clean(container.innerText || container.textContent);
      const key = a.href + "|" + rowText.slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      const companyA = container.querySelector('a[href*="/company/"]');
      container.setAttribute("data-mtrow", String(rows.length));
      containers.push(container);
      rows.push({
        _c: container,
        company: companyA ? clean(companyA.innerText || companyA.textContent) : "",
        company_url: companyA ? companyA.href : "",
        pdf_url: a.href,
        headingGuess: clean(a.innerText || a.textContent),
        rowText,
        headerText: "",
      });
    }
    if (!rows.length) return [];

    // 2) feed list = smallest element containing every row
    let root = containers[0];
    for (let k = 1; k < containers.length; k++) {
      while (root && !root.contains(containers[k])) root = root.parentElement;
      if (!root) { root = document.body; break; }
    }

    // 3) headers inside the feed list, not inside any row
    const headers = [];
    for (const el of root.querySelectorAll("*")) {
      if (el.querySelector("a")) continue;        // headers are plain text, no links
      if (el.closest("[data-mtrow]")) continue;   // not part of a row
      const t = clean(el.textContent);
      if (t && t.length <= 24 && isHdr(t)) headers.push({ node: el, t });
    }

    // 4) order headers + rows together, carry the current header onto each row
    const marks = headers.map((h) => ({ node: h.node, t: h.t }))
      .concat(rows.map((r) => ({ node: r._c, r })));
    marks.sort((a, b) =>
      a.node === b.node ? 0 : (a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
    let cur = "";
    for (const m of marks) { if (m.r) m.r.headerText = cur; else cur = m.t; }

    return rows.map(({ _c, ...r }) => r); // drop DOM refs before crossing back
  });
}

// A row's date is its day-group header only (authoritative). Body text is never
// used — it routinely mentions unrelated old dates that would corrupt the window.
function resolveWhen(r, today) {
  return parseWhen(r.headerText, today);
}

// The Screener announcements feed lazy-loads more rows as you scroll (grouped by
// day). Scroll to the bottom repeatedly until we've loaded past the 15-day window
// or the list stops growing — so we capture EVERY filing in the window, not just
// the first screen. Returns { rows, reached } where reached = we scrolled past the window.
// Click the feed's "Show More" control. It re-renders (and briefly removes the
// button) after each click, so WAIT for the button to (re)appear before clicking.
// Returns true if clicked, false only when it is truly gone (whole feed loaded).
async function clickShowMore(page) {
  const loc = page.locator("button, a").filter({ hasText: /^\s*(show|load|view)\s+more\s*$/i }).first();
  try {
    await loc.waitFor({ state: "visible", timeout: 8000 });
    await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await loc.click({ timeout: 4000 });
    return true;
  } catch { return false; }
}

// The feed is grouped by day with ABSOLUTE date headers ("Sep 15, 2026" / "Today"
// / "Yesterday") and paginates via a "Show More" button that appends a small batch.
// Return the parseable date-header texts so we know how far back we've loaded.
// Click "Show More" repeatedly, ACCUMULATING rows (so a transient re-render never
// drops what we've seen), until the oldest DAY-GROUP date on screen is clearly
// past the 15-day window (+5d margin, so we never stop short), the button is
// gone, or growth stalls. Over-loading a little is safe — the window filter in
// main() trims the extra; stopping short would miss filings.
async function loadFeed(page, today) {
  const acc = new Map(); // pdf_url -> row
  const domCount = () => page.evaluate(() => document.querySelectorAll('a[href*="/company/"]').length).catch(() => 0);
  const grab = async () => { for (const r of await extractRows(page)) if (r.pdf_url) acc.set(r.pdf_url, r); };
  const dated = () => [...acc.values()].map((r) => resolveWhen(r, today)).filter(Boolean);
  const oldestAge = () => dated().reduce((o, d) => Math.max(o, ymdDiffDays(today, d)), -1);

  await grab();
  let clicks = 0, stagnant = 0;
  for (let i = 0; i < 60; i++) {
    if (oldestAge() > BACKFILL_DAYS + 5) break;      // oldest day-group is well past the window -> done
    if (acc.size > 1000) break;                       // hard safety cap
    const before = await domCount();
    if (!(await clickShowMore(page))) break;          // button truly gone -> whole feed loaded
    clicks++;
    for (let w = 0; w < 30; w++) { await sleep(500); if ((await domCount()) > before) break; } // wait for AJAX growth
    const prev = acc.size;
    await grab();
    if (acc.size <= prev) { if (++stagnant >= 3) break; } else { stagnant = 0; }
  }
  const age = oldestAge();
  console.log(`  [feed] loaded ${acc.size} rows (${dated().length} dated) via ${clicks} "Show More" click(s); oldest day-group ≈${age}d back`);
  return { rows: [...acc.values()], reached: age > BACKFILL_DAYS };
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
