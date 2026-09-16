// screener-test/helpers.mjs
// Shared helpers for the Screener / BSE / NSE scrapers.
// The browser/PDF helpers are used verbatim from the build spec — they defeat
// known blocks (referers, NSE cookie-priming, scrape.do fallback). Kept in one
// module so scrape / extract / enrich all share the exact same battle-tested code.
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

export { chromium };
export const ORIGIN = "https://www.screener.in";
export const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Screener login -------------------------------------------------------
export async function login(page) {
  await page.goto(`${ORIGIN}/login/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.fill('input[name="username"]', process.env.SCREENER_EMAIL);
  await page.fill('input[name="password"]', process.env.SCREENER_PASSWORD);
  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForTimeout(1500);
  if (!/\/logout\//.test(await page.content()))
    throw new Error("Login failed — check SCREENER_EMAIL / SCREENER_PASSWORD.");
}

// --- PDF fetching (BSE / NSE) --------------------------------------------
export const hostKind = (u) => {
  let h = "";
  try { h = new URL(u).host; } catch { return "other"; }
  return /bseindia\.com/i.test(h) ? "bse" : /nseindia\.com/i.test(h) ? "nse" : "other";
};
export const refererFor = (k) =>
  k === "bse" ? "https://www.bseindia.com/" : k === "nse" ? "https://www.nseindia.com/" : undefined;

let pdfjsLib = null;
export async function extractPdfText(buffer) {
  if (!pdfjsLib) pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjsLib.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  try {
    const p = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const tc = await (await doc.getPage(i)).getTextContent();
      p.push(tc.items.map((it) => it.str ?? "").join(" "));
    }
    return p.join("\n").replace(/[ \t]+\n/g, "\n").trim();
  } finally {
    try { await task.destroy(); } catch {}
  }
}

export async function fetchPdf(context, page, url, ensureNsePrimed) {
  const kind = hostKind(url);
  const headers = { "User-Agent": UA, Accept: "application/pdf,application/octet-stream,*/*", "Accept-Language": "en-US,en;q=0.9" };
  const ref = refererFor(kind);
  if (ref) headers.Referer = ref;
  try {
    if (kind === "nse" && ensureNsePrimed) await ensureNsePrimed();
    const resp = await context.request.get(url, { headers, timeout: 30000 });
    if (resp.ok()) { const b = Buffer.from(await resp.body()); if (b.length) return b; }
  } catch {}
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (resp && resp.ok()) { const b = Buffer.from(await resp.body()); if (b.length) return b; }
  } catch {}
  if (process.env.SCRAPE_DO_API_KEY) {
    try {
      const r = await fetch(`https://api.scrape.do/?token=${process.env.SCRAPE_DO_API_KEY}&url=${encodeURIComponent(url)}`);
      if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); if (b.length) return b; }
    } catch {}
  }
  return null;
}

// NSE 403s its PDFs unless a homepage visit has set cookies first — prime once per page.
export function makeEnsureNsePrimed(page) {
  let nsePrimed = false;
  return async () => {
    if (nsePrimed) return;
    await page.goto("https://www.nseindia.com/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await sleep(1200);
    nsePrimed = true;
  };
}

// --- small utilities ------------------------------------------------------
export const pad = (n) => String(n).padStart(2, "0");

// Stable slug (announcement ids from pdf_url, event ids from company|date|type|cp).
export function slugify(s, max = 160) {
  const out = String(s || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out.slice(0, max) || "x";
}

// IST date helpers — Screener and the exchanges all operate in Asia/Kolkata.
export function istToday() {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}
// Add N days to a YYYY-MM-DD string (noon-UTC math sidesteps DST/tz edges).
export function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// Whole-day difference a - b for two YYYY-MM-DD strings.
export function ymdDiffDays(a, b) {
  const da = new Date(`${a}T12:00:00Z`).getTime();
  const db = new Date(`${b}T12:00:00Z`).getTime();
  return Math.round((da - db) / 86400000);
}

// --- JSON read/write ------------------------------------------------------
export async function readJson(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return fallback; }
}
export async function writeJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2));
}
