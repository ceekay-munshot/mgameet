/* ui.js — pure helpers for the Investor Meet Tracker dashboard.
   Everything hangs off window.U. No framework, no build. */
(function () {
  "use strict";

  // ---- event-type colors (used for pills AND charts — keep consistent) ----
  const TYPE_COLORS = {
    "One-on-One": "#6366F1",
    "Group Meeting": "#8B5CF6",
    "Analyst Meet": "#3B82F6",
    "Investor Meet": "#06B6D4",
    "Conference": "#EC4899",
    "Plant Visit": "#F59E0B",
    "Investor Day": "#10B981",
    "Earnings Call": "#F43F5E",
    "Other": "#94A3B8",
  };
  const TYPE_ICONS = {
    "One-on-One": "user",
    "Group Meeting": "users",
    "Analyst Meet": "bar-chart-3",
    "Investor Meet": "handshake",
    "Conference": "presentation",
    "Plant Visit": "factory",
    "Investor Day": "sparkles",
    "Earnings Call": "phone-call",
    "Other": "circle-dot",
  };
  const TYPE_ORDER = Object.keys(TYPE_COLORS);
  const MODE_STYLE = {
    "Virtual": { bg: "#e0f2fe", fg: "#0369a1", icon: "monitor" },
    "In-person": { bg: "#d1fae5", fg: "#047857", icon: "map-pin" },
    "Hybrid": { bg: "#ede9fe", fg: "#6d28d9", icon: "blend" },
  };

  const typeColor = (t) => TYPE_COLORS[t] || TYPE_COLORS.Other;

  // ---- color math ----
  function hexToRgb(hex) {
    const h = String(hex).replace("#", "");
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  function rgba(hex, a) { const { r, g, b } = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; }
  function darken(hex, amt) {
    const { r, g, b } = hexToRgb(hex); const f = (c) => Math.max(0, Math.round(c * (1 - amt)));
    return `rgb(${f(r)},${f(g)},${f(b)})`;
  }
  // light ARGB tint for Excel fills (mix toward white)
  function argbTint(hex, keep) {
    keep = keep == null ? 0.16 : keep; const { r, g, b } = hexToRgb(hex);
    const mix = (c) => Math.round(c * keep + 255 * (1 - keep));
    return "FF" + [mix(r), mix(g), mix(b)].map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
  }
  // darkened 6-hex (no #) for Excel text on a tinted cell
  function darkHex(hex, amt) {
    amt = amt == null ? 0.4 : amt; const { r, g, b } = hexToRgb(hex); const f = (c) => Math.max(0, Math.round(c * (1 - amt)));
    return [f(r), f(g), f(b)].map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
  }

  // ---- stable sector hue (each sector gets its own consistent color) ----
  function sectorHue(name) {
    const s = String(name || ""); let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
  }
  const sectorDot = (name) => `hsl(${sectorHue(name)} 62% 52%)`;
  function sectorPill(name) {
    if (!name) return "";
    const hue = sectorHue(name);
    return `<span class="pill" style="background:hsl(${hue} 85% 96%);color:hsl(${hue} 55% 32%);border:1px solid hsl(${hue} 70% 88%)"><span style="width:7px;height:7px;border-radius:9999px;background:${sectorDot(name)}"></span>${esc(name)}</span>`;
  }

  // ---- text ----
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  // strip feed noise: "3h ago" / "2 days ago" / "just now" and a duplicated tail
  function clean(s) {
    if (s == null) return "";
    let t = String(s).replace(/\s+/g, " ").trim();
    t = t.replace(/\b\d+\s*(?:s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|wk|wks|weeks?|mo|months?)\s+ago\b/gi, " ");
    t = t.replace(/\bjust now\b/gi, " ").replace(/\s+/g, " ").trim();
    return t;
  }

  // ---- pills ----
  function typePill(type) {
    const c = typeColor(type), ic = TYPE_ICONS[type] || TYPE_ICONS.Other;
    return `<span class="pill" style="background:${rgba(c, 0.14)};color:${darken(c, 0.36)}"><i data-lucide="${ic}"></i>${esc(type || "Other")}</span>`;
  }
  function modePill(mode) {
    const m = MODE_STYLE[mode]; if (!m) return `<span class="text-slate-300">—</span>`;
    return `<span class="pill" style="background:${m.bg};color:${m.fg}"><i data-lucide="${m.icon}"></i>${esc(mode)}</span>`;
  }

  // ---- dates (data is IST; keep everything in IST/UTC-stable math) ----
  const istToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  function addDays(ymd, n) { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function diffDays(ymd, from) { return Math.round((new Date(ymd + "T00:00:00Z") - new Date(from + "T00:00:00Z")) / 86400000); }
  function dateLabel(ymd) { // "Sun, 21 Sep"
    return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(ymd + "T00:00:00Z"));
  }
  function dayMonth(ymd) { return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(ymd + "T00:00:00Z")); }
  function friendlyWhen(ymd, today) {
    const d = diffDays(ymd, today);
    if (d === 0) return "Today"; if (d === 1) return "Tomorrow";
    if (d < 0) return `${-d} day${d === -1 ? "" : "s"} ago`;
    return `In ${d} days`;
  }
  function fmtTime(t) {
    if (!t) return ""; const m = /^(\d{1,2}):(\d{2})/.exec(String(t)); if (!m) return String(t);
    let h = +m[1]; const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return `${h}:${m[2]} ${ap}`;
  }
  function updatedLabel(iso) {
    if (!iso) return "—";
    try { return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" }).format(new Date(iso)) + " IST"; }
    catch { return "—"; }
  }

  // ---- misc ----
  function countUp(el, to, dur) {
    if (!el) return; to = +to || 0; dur = dur || 700; const start = performance.now();
    (function step(now) {
      const p = Math.min(1, (now - start) / dur); const e = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(to * e).toLocaleString();
      if (p < 1) requestAnimationFrame(step);
    })(start);
  }
  function debounce(fn, ms) { let t; return function () { clearTimeout(t); const a = arguments, c = this; t = setTimeout(() => fn.apply(c, a), ms); }; }
  function icons() { try { window.lucide && lucide.createIcons(); } catch (e) {} }
  const uniqSort = (arr) => [...new Set(arr.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));

  const U = {
    TYPE_COLORS, TYPE_ICONS, TYPE_ORDER, MODE_STYLE, typeColor,
    hexToRgb, rgba, darken, argbTint, darkHex, sectorHue, sectorDot, sectorPill,
    esc, clean, typePill, modePill,
    istToday, addDays, diffDays, dateLabel, dayMonth, friendlyWhen, fmtTime, updatedLabel,
    countUp, debounce, icons, uniqSort,
  };
  if (typeof window !== "undefined") window.U = U;
  if (typeof module !== "undefined" && module.exports) module.exports = U;
})();
