/* app.js — Investor Meet Tracker dashboard.
   Reads ./data/events.json (+ metadata.json), renders 3 tabs, filters, charts, Excel export. */
(function () {
  "use strict";
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  let DATA = { events: [] }, META = {};
  const TODAY = U.istToday();
  const charts = {}; let chartsBuilt = false;

  const state = {
    type: "", sector: "", industry: "", subIndustry: "", mode: "",
    preset: "all", from: "", to: "", search: "",
    view: "table", tableLimit: 25,
  };

  /* ---------------- boot ---------------- */
  async function boot() {
    show("#loading"); hide("#errorState"); hide("#appRoot");
    try {
      const [ev, md] = await Promise.all([
        fetch("./data/events.json", { cache: "no-store" }).then((r) => { if (!r.ok) throw new Error("events.json " + r.status); return r.json(); }),
        fetch("./data/metadata.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
      ]);
      DATA = ev && Array.isArray(ev.events) ? ev : { events: [] };
      META = md || {};
      init();
      hide("#loading"); show("#appRoot");
    } catch (e) {
      hide("#loading");
      $("#errorMsg").textContent = "We couldn't reach data/events.json (" + (e.message || e) + "). Run the pipeline to generate it.";
      show("#errorState"); U.icons();
    }
  }
  const show = (s) => { const el = $(s); if (el) el.classList.remove("hidden"); };
  const hide = (s) => { const el = $(s); if (el) el.classList.add("hidden"); };

  /* ---------------- init ---------------- */
  function init() {
    // updated badge + footer note
    $("#updatedBadge").querySelector("span").textContent = "Updated " + U.updatedLabel(META.updated_at || DATA.generated_at);
    $("#genNote").textContent = "Data as of " + U.updatedLabel(DATA.generated_at || META.updated_at) + " · " + (DATA.events.length) + " upcoming.";

    // KPIs (prefer metadata, fall back to computed)
    const confs = DATA.events.filter((e) => e.event_type === "Conference").length;
    const companies = META.companies != null ? META.companies : new Set(DATA.events.map((e) => e.company).filter(Boolean)).size;
    U.countUp($("#kpi-upcoming"), META.total_upcoming != null ? META.total_upcoming : DATA.events.length);
    U.countUp($("#kpi-today"), META.today_count != null ? META.today_count : DATA.events.filter((e) => U.diffDays(e.event_date, TODAY) === 0).length);
    U.countUp($("#kpi-week"), META.week_count != null ? META.week_count : DATA.events.filter((e) => { const d = U.diffDays(e.event_date, TODAY); return d >= 0 && d <= 7; }).length);
    U.countUp($("#kpi-companies"), companies);
    U.countUp($("#kpi-confs"), confs);

    populateFacets();
    wire();
    renderUpcoming();
    renderConferences();
    U.icons();
  }

  /* ---------------- filters / facets ---------------- */
  function fill(sel, values, allLabel) {
    const el = $(sel), cur = el.value;
    el.innerHTML = `<option value="">${allLabel}</option>` + values.map((v) => `<option value="${U.esc(v)}">${U.esc(v)}</option>`).join("");
    if (values.includes(cur)) el.value = cur;
  }
  function populateFacets() {
    const ev = DATA.events;
    const types = U.TYPE_ORDER.filter((t) => ev.some((e) => e.event_type === t));
    fill("#f-type", types, "All types");
    fill("#f-sector", U.uniqSort(ev.map((e) => e.sector)), "All sectors");
    fill("#f-mode", ["Virtual", "In-person", "Hybrid"].filter((m) => ev.some((e) => e.mode === m)), "Any mode");
    cascadeIndustry();
  }
  function cascadeIndustry() {
    const ev = DATA.events;
    const inSec = (e) => !state.sector || e.sector === state.sector;
    fill("#f-industry", U.uniqSort(ev.filter(inSec).map((e) => e.industry)), "All industries");
    if (!$("#f-industry").value) state.industry = "";
    cascadeSub();
  }
  function cascadeSub() {
    const ev = DATA.events;
    const ok = (e) => (!state.sector || e.sector === state.sector) && (!state.industry || e.industry === state.industry);
    fill("#f-subindustry", U.uniqSort(ev.filter(ok).map((e) => e.sub_industry)), "All sub-industries");
    if (!$("#f-subindustry").value) state.subIndustry = "";
  }

  function getFiltered() {
    const q = U.clean(state.search).toLowerCase();
    return DATA.events.filter((e) => {
      if (state.type && e.event_type !== state.type) return false;
      if (state.sector && e.sector !== state.sector) return false;
      if (state.industry && e.industry !== state.industry) return false;
      if (state.subIndustry && e.sub_industry !== state.subIndustry) return false;
      if (state.mode && e.mode !== state.mode) return false;
      if (state.from && e.event_date < state.from) return false;
      if (state.to && e.event_date > state.to) return false;
      if (q) {
        const hay = [e.company, e.counterparty, e.venue].map((x) => U.clean(x).toLowerCase()).join(" ");
        if (!hay.includes(q)) return false;
      }
      return true;
    }).sort((a, b) => (a.event_date < b.event_date ? -1 : a.event_date > b.event_date ? 1 : String(a.company || "").localeCompare(String(b.company || ""))));
  }

  function setPreset(p) {
    state.preset = p;
    if (p === "today") { state.from = TODAY; state.to = TODAY; }
    else if (p === "week") { state.from = TODAY; state.to = U.addDays(TODAY, 6); }
    else if (p === "d15") { state.from = TODAY; state.to = U.addDays(TODAY, 14); }
    else if (p === "d30") { state.from = TODAY; state.to = U.addDays(TODAY, 29); }
    else if (p === "all") { state.from = ""; state.to = ""; }
    // custom: leave from/to as-is
    $("#f-from").value = state.from; $("#f-to").value = state.to; $("#f-preset").value = p;
  }

  /* ---------------- render: Upcoming ---------------- */
  function renderUpcoming() {
    const rows = getFiltered();
    $("#shownCount").textContent = `${rows.length} of ${DATA.events.length} shown`;
    const body = $("#upcomingBody");
    if (!rows.length) { body.innerHTML = emptyState("No meetings match — try clearing filters."); U.icons(); return; }
    body.innerHTML = state.view === "table" ? renderTable(rows) : renderTimeline(rows);
    const more = $("#showMoreBtn");
    if (more) more.addEventListener("click", () => { state.tableLimit += 25; renderUpcoming(); });
    U.icons();
  }

  function whenCell(e) {
    const rel = U.friendlyWhen(e.event_date, TODAY);
    const soon = U.diffDays(e.event_date, TODAY);
    const col = soon === 0 ? "#EC4899" : soon === 1 ? "#A855F7" : "#6366F1";
    return `<div class="leading-tight"><span class="font-semibold" style="color:${col}">${rel}</span><div class="text-[.72rem] text-slate-400">${U.dateLabel(e.event_date)}</div></div>`;
  }
  function srcLink(e) {
    if (!e.pdf_url) return `<span class="text-slate-300">—</span>`;
    return `<a href="${U.esc(e.pdf_url)}" target="_blank" rel="noopener" class="src-btn" title="Open exchange PDF"><i data-lucide="file-text"></i></a>`;
  }
  const dash = (v) => (v && String(v).trim() ? U.esc(U.clean(v)) : `<span class="text-slate-300">—</span>`);

  function renderTable(rows) {
    const total = rows.length;
    const shown = rows.slice(0, state.tableLimit);
    const trs = shown.map((e) => `<tr>
      <td><div class="font-semibold text-slate-800">${U.esc(e.company || "—")}</div><div class="mt-1">${U.sectorPill(e.sector)}</div></td>
      <td>${U.typePill(e.event_type)}</td>
      <td>${whenCell(e)}</td>
      <td class="font-mono text-[.78rem] text-slate-500">${e.event_time ? U.esc(U.fmtTime(e.event_time)) : '<span class="text-slate-300">—</span>'}</td>
      <td>${U.modePill(e.mode)}</td>
      <td class="text-slate-700">${dash(e.counterparty)}</td>
      <td class="text-slate-500">${dash(e.venue)}</td>
      <td class="text-center">${srcLink(e)}</td>
    </tr>`).join("");
    const moreBtn = total > state.tableLimit
      ? `<div class="text-center mt-3"><button id="showMoreBtn" class="chip bg-white border border-slate-200 text-slate-600 hover:border-violet-300 mx-auto">Show ${Math.min(25, total - state.tableLimit)} more · ${total - state.tableLimit} hidden <i data-lucide="chevron-down" class="w-4 h-4"></i></button></div>`
      : "";
    return `<div class="card overflow-hidden"><div class="hscroll"><table class="mtable min-w-[860px]">
      <thead><tr><th>Company</th><th>Type</th><th>When</th><th>Time</th><th>Mode</th><th>Meeting with</th><th>Venue</th><th class="text-center">Source</th></tr></thead>
      <tbody>${trs}</tbody></table></div></div>${moreBtn}`;
  }

  function renderTimeline(rows) {
    const groups = {};
    rows.forEach((e) => { (groups[e.event_date] = groups[e.event_date] || []).push(e); });
    const dates = Object.keys(groups).sort();
    return dates.map((d) => {
      const rel = U.friendlyWhen(d, TODAY), n = groups[d].length;
      const hot = U.diffDays(d, TODAY) <= 1;
      const head = `<div class="flex items-center gap-2 mb-2 mt-1">
        <span class="chip text-white text-xs" style="background-image:linear-gradient(100deg,${hot ? "#EC4899,#A855F7" : "#6366F1,#8B5CF6"})">${U.esc(rel)} · ${U.dayMonth(d)}</span>
        <span class="text-xs font-semibold text-slate-400">${n} meeting${n > 1 ? "s" : ""}</span>
        <div class="h-px flex-1 bg-slate-200/70"></div></div>`;
      const cards = groups[d].map((e) => `<div class="card card-hover p-3.5">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0"><div class="font-semibold text-slate-800 truncate">${U.esc(e.company || "—")}</div><div class="mt-1">${U.sectorPill(e.sector)}</div></div>
          ${srcLink(e)}
        </div>
        <div class="flex flex-wrap items-center gap-1.5 mt-2.5">${U.typePill(e.event_type)}${U.modePill(e.mode)}${e.event_time ? `<span class="pill bg-slate-100 text-slate-500"><i data-lucide="clock"></i>${U.esc(U.fmtTime(e.event_time))}</span>` : ""}</div>
        ${e.counterparty ? `<div class="text-[.8rem] text-slate-600 mt-2 flex items-start gap-1.5"><i data-lucide="handshake" class="w-3.5 h-3.5 mt-0.5 text-slate-400"></i><span>${U.esc(U.clean(e.counterparty))}</span></div>` : ""}
        ${e.venue ? `<div class="text-[.78rem] text-slate-400 mt-1 flex items-center gap-1.5"><i data-lucide="map-pin" class="w-3.5 h-3.5"></i>${U.esc(U.clean(e.venue))}</div>` : ""}
      </div>`).join("");
      return `<div class="mb-4">${head}<div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">${cards}</div></div>`;
    }).join("");
  }

  function emptyState(msg) {
    return `<div class="card p-12 text-center"><div class="mx-auto mb-3 grid place-items-center w-14 h-14 rounded-2xl bg-violet-50 text-violet-400"><i data-lucide="calendar-x" class="w-7 h-7"></i></div>
      <p class="font-semibold text-slate-600">${U.esc(msg)}</p><p class="text-sm text-slate-400 mt-1">Adjust the filters above to see more.</p></div>`;
  }

  /* ---------------- render: Conferences ---------------- */
  const CONF_RE = /summit|forum|conference|conclave|\btrip\b|symposium|expo|investor day/i;
  function renderConferences() {
    const isConf = (e) => e.event_type === "Conference" || (e.counterparty && CONF_RE.test(e.counterparty));
    const groups = {};
    DATA.events.filter(isConf).forEach((e) => {
      const key = U.clean(e.counterparty) || (e.company + " · " + e.event_type);
      (groups[key] = groups[key] || { name: key, events: [] }).events.push(e);
    });
    let cards = Object.values(groups).map((g) => {
      const ds = g.events.map((e) => e.event_date).sort();
      g.min = ds[0]; g.max = ds[ds.length - 1];
      return g;
    }).sort((a, b) => (a.min < b.min ? -1 : a.min > b.min ? 1 : 0));

    const body = $("#confBody");
    if (!cards.length) { body.innerHTML = `<div class="md:col-span-2 xl:col-span-3">${emptyState("No conferences in the current window.")}</div>`; U.icons(); return; }

    body.innerHTML = cards.map((g, i) => {
      const hue = (i * 47) % 360;
      const range = g.min === g.max ? U.dateLabel(g.min) : `${U.dayMonth(g.min)} – ${U.dayMonth(g.max)}`;
      const comps = g.events.map((e) => `<div class="flex items-center justify-between gap-2 py-1.5 border-t border-slate-100">
        <div class="min-w-0"><span class="font-semibold text-sm text-slate-700">${U.esc(e.company || "—")}</span> <span class="text-[.72rem] text-slate-400">· ${U.dayMonth(e.event_date)}${e.event_time ? " · " + U.esc(U.fmtTime(e.event_time)) : ""}</span><div class="mt-1">${U.sectorPill(e.sector)}</div></div>
        ${srcLink(e)}</div>`).join("");
      return `<div class="card card-hover p-4 flex flex-col">
        <div class="flex items-start gap-2.5 mb-2">
          <div class="kpi-ico" style="background:hsl(${hue} 85% 95%);color:hsl(${hue} 60% 42%)"><i data-lucide="presentation"></i></div>
          <div class="min-w-0"><h3 class="font-display font-semibold text-slate-800 leading-tight">${U.esc(g.name)}</h3>
          <div class="flex items-center gap-2 mt-1"><span class="pill" style="background:hsl(${hue} 85% 96%);color:hsl(${hue} 55% 35%)"><i data-lucide="calendar"></i>${range}</span><span class="text-[.72rem] font-semibold text-slate-400">${g.events.length} compan${g.events.length > 1 ? "ies" : "y"}</span></div></div>
        </div>
        <div class="mt-1">${comps}</div>
      </div>`;
    }).join("");
    U.icons();
  }

  /* ---------------- Overview charts ---------------- */
  const BASE_TEXT = { fontFamily: "Inter, sans-serif" };
  function chartMsg(id, msg) { const el = $("#" + id); if (el) el.innerHTML = `<div class="h-full grid place-items-center text-sm text-slate-400">${U.esc(msg)}</div>`; }

  function buildCharts() {
    if (chartsBuilt) return;
    if (!window.echarts) { ["chart-perday", "chart-type", "chart-mode", "chart-companies", "chart-sector"].forEach((id) => chartMsg(id, "Charts need an internet connection to load.")); return; }
    chartsBuilt = true;
    const ev = DATA.events;
    const mk = (id) => (charts[id] = echarts.init($("#" + id)));
    const tt = { trigger: "item", backgroundColor: "rgba(255,255,255,.97)", borderColor: "#eee", textStyle: { color: "#334155", fontFamily: "Inter" }, extraCssText: "box-shadow:0 8px 24px -8px rgba(16,24,40,.25);border-radius:10px" };

    // 1) meetings per day
    const maxD = ev.reduce((m, e) => (e.event_date > m ? e.event_date : m), TODAY);
    const days = []; let cur = TODAY, guard = 0;
    while (cur <= maxD && guard < 60) { days.push(cur); cur = U.addDays(cur, 1); guard++; }
    const perCount = days.map((d) => ev.filter((e) => e.event_date === d).length);
    const perComp = days.map((d) => U.uniqSort(ev.filter((e) => e.event_date === d).map((e) => e.company)));
    mk("chart-perday").setOption({
      textStyle: BASE_TEXT, legend: { data: ["Meetings"], top: 0, right: 0, icon: "roundRect", textStyle: { color: "#64748b" } },
      grid: { left: 6, right: 12, top: 34, bottom: 4, containLabel: true },
      tooltip: Object.assign({}, tt, { trigger: "axis", axisPointer: { type: "shadow" }, formatter: (p) => {
        const i = p[0].dataIndex; const cs = perComp[i];
        const list = cs.slice(0, 10).map((c) => "• " + U.esc(c)).join("<br>") + (cs.length > 10 ? `<br>+${cs.length - 10} more` : "");
        return `<b>${U.dateLabel(days[i])}</b><br>${p[0].value} meeting${p[0].value === 1 ? "" : "s"}${cs.length ? "<br>" + list : ""}`;
      } }),
      xAxis: { type: "category", data: days.map((d) => U.dayMonth(d)), axisTick: { show: false }, axisLine: { lineStyle: { color: "#e2e8f0" } }, axisLabel: { color: "#94a3b8", fontSize: 10, interval: 0, hideOverlap: true, rotate: days.length > 12 ? 38 : 0 } },
      yAxis: { type: "value", minInterval: 1, splitLine: { lineStyle: { color: "#f1f5f9" } }, axisLabel: { color: "#94a3b8" } },
      series: [{ name: "Meetings", type: "bar", data: perCount, barMaxWidth: 34, itemStyle: { borderRadius: [7, 7, 0, 0], color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: "#A855F7" }, { offset: 1, color: "#6366F1" }]) }, emphasis: { itemStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: "#EC4899" }, { offset: 1, color: "#8B5CF6" }]) } } }],
    });

    // 2) by type donut
    const typeData = U.TYPE_ORDER.filter((t) => ev.some((e) => e.event_type === t)).map((t) => ({ name: t, value: ev.filter((e) => e.event_type === t).length, itemStyle: { color: U.typeColor(t) } }));
    mk("chart-type").setOption({
      textStyle: BASE_TEXT, tooltip: Object.assign({}, tt, { formatter: "{b}<br><b>{c}</b> ({d}%)" }),
      legend: { type: "scroll", bottom: 0, textStyle: { color: "#64748b", fontSize: 11 }, icon: "circle" },
      series: [{ type: "pie", radius: ["46%", "72%"], center: ["50%", "44%"], avoidLabelOverlap: true, itemStyle: { borderColor: "#fff", borderWidth: 3 }, label: { show: false }, emphasis: { scale: true, scaleSize: 6, label: { show: true, formatter: "{b}\n{d}%", fontFamily: "Space Grotesk", fontWeight: 600, color: "#334155" } }, data: typeData }],
    });

    // 3) mode donut
    const modeDefs = [["Virtual", "#0ea5e9"], ["In-person", "#10b981"], ["Hybrid", "#8b5cf6"], ["Not specified", "#cbd5e1"]];
    const modeData = modeDefs.map(([n, c]) => ({ name: n, value: ev.filter((e) => (n === "Not specified" ? !e.mode : e.mode === n)).length, itemStyle: { color: c } })).filter((d) => d.value > 0);
    mk("chart-mode").setOption({
      textStyle: BASE_TEXT, tooltip: Object.assign({}, tt, { formatter: "{b}<br><b>{c}</b> ({d}%)" }),
      legend: { bottom: 0, textStyle: { color: "#64748b", fontSize: 11 }, icon: "circle" },
      series: [{ type: "pie", radius: ["46%", "72%"], center: ["50%", "44%"], itemStyle: { borderColor: "#fff", borderWidth: 3 }, label: { show: true, formatter: "{d}%", fontFamily: "Space Grotesk", fontWeight: 600, color: "#475569", fontSize: 12 }, data: modeData }],
    });

    // 4) busiest companies (horizontal, top 10)
    const byComp = {}; ev.forEach((e) => { if (e.company) byComp[e.company] = (byComp[e.company] || 0) + 1; });
    const top = Object.entries(byComp).sort((a, b) => b[1] - a[1]).slice(0, 10).reverse();
    mk("chart-companies").setOption({
      textStyle: BASE_TEXT, legend: { data: ["Meetings"], top: 0, right: 0, icon: "roundRect", textStyle: { color: "#64748b" } },
      grid: { left: 6, right: 26, top: 30, bottom: 4, containLabel: true },
      tooltip: Object.assign({}, tt, { trigger: "axis", axisPointer: { type: "shadow" }, formatter: (p) => `<b>${U.esc(p[0].name)}</b><br>${p[0].value} meeting${p[0].value === 1 ? "" : "s"}` }),
      xAxis: { type: "value", minInterval: 1, splitLine: { lineStyle: { color: "#f1f5f9" } }, axisLabel: { color: "#94a3b8" } },
      yAxis: { type: "category", data: top.map((t) => t[0]), axisTick: { show: false }, axisLine: { show: false }, axisLabel: { color: "#475569", fontSize: 11 } },
      series: [{ name: "Meetings", type: "bar", data: top.map((t) => t[1]), barMaxWidth: 20, label: { show: true, position: "right", color: "#94a3b8", fontWeight: 600 }, itemStyle: { borderRadius: [0, 6, 6, 0], color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [{ offset: 0, color: "#6366F1" }, { offset: 1, color: "#EC4899" }]) } }],
    });

    // 5) by sector (horizontal, sector hue)
    const bySec = {}; ev.forEach((e) => { if (e.sector) bySec[e.sector] = (bySec[e.sector] || 0) + 1; });
    const secs = Object.entries(bySec).sort((a, b) => b[1] - a[1]).reverse();
    mk("chart-sector").setOption({
      textStyle: BASE_TEXT, legend: { data: ["Meetings"], top: 0, right: 0, icon: "roundRect", textStyle: { color: "#64748b" } },
      grid: { left: 6, right: 26, top: 30, bottom: 4, containLabel: true },
      tooltip: Object.assign({}, tt, { trigger: "axis", axisPointer: { type: "shadow" }, formatter: (p) => `<b>${U.esc(p[0].name)}</b><br>${p[0].value} meeting${p[0].value === 1 ? "" : "s"}` }),
      xAxis: { type: "value", minInterval: 1, splitLine: { lineStyle: { color: "#f1f5f9" } }, axisLabel: { color: "#94a3b8" } },
      yAxis: { type: "category", data: secs.map((t) => t[0]), axisTick: { show: false }, axisLine: { show: false }, axisLabel: { color: "#475569", fontSize: 11 } },
      series: [{ name: "Meetings", type: "bar", data: secs.map((t) => ({ value: t[1], itemStyle: { color: U.sectorDot(t[0]), borderRadius: [0, 6, 6, 0] } })), barMaxWidth: 18, label: { show: true, position: "right", color: "#94a3b8", fontWeight: 600 } }],
    });
  }
  const resizeCharts = U.debounce(() => Object.values(charts).forEach((c) => c && c.resize()), 120);

  /* ---------------- Excel export ---------------- */
  const COLS = [
    ["Company", "company", 26], ["Sector", "sector", 20], ["Industry", "industry", 22], ["Sub-industry", "sub_industry", 24],
    ["Type", "event_type", 16], ["Event Date", "event_date", 15], ["Time", "event_time", 10], ["Mode", "mode", 12],
    ["Meeting With", "counterparty", 32], ["Venue", "venue", 24], ["Announced", "announced_at", 14], ["Source", "pdf_url", 12],
  ];
  async function exportExcel() {
    const rows = getFiltered();
    const fname = `meets_${TODAY}.xlsx`;
    if (!window.ExcelJS) return exportCsv(rows);
    try {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Meetings", { views: [{ state: "frozen", ySplit: 1 }] });
      ws.columns = COLS.map(([h, , w]) => ({ header: h, width: w }));
      // header
      const hr = ws.getRow(1); hr.height = 26;
      hr.eachCell((c) => {
        c.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11, name: "Calibri" };
        c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF6366F1" } };
        c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      });
      ws.autoFilter = "A1:L1";
      rows.forEach((e, i) => {
        const r = ws.addRow([
          e.company || "", e.sector || "", e.industry || "", e.sub_industry || "",
          e.event_type || "", e.event_date ? new Date(e.event_date + "T00:00:00Z") : "", e.event_time ? U.fmtTime(e.event_time) : "",
          e.mode || "", U.clean(e.counterparty) || "", U.clean(e.venue) || "", e.announced_at ? new Date(e.announced_at + "T00:00:00Z") : "", null,
        ]);
        r.eachCell({ includeEmpty: true }, (c) => { c.alignment = { vertical: "top", wrapText: true }; });
        if (i % 2 === 1) r.eachCell({ includeEmpty: true }, (c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF7F6FD" } }; });
        // type tint (col E)
        const tc = r.getCell(5); tc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: U.argbTint(U.typeColor(e.event_type)) } }; tc.font = { bold: true, color: { argb: "FF" + U.darkHex(U.typeColor(e.event_type), 0.42) }, name: "Calibri" }; tc.alignment = { vertical: "top", wrapText: true };
        r.getCell(6).numFmt = "ddd, dd mmm yyyy";
        r.getCell(11).numFmt = "dd mmm yyyy";
        const src = r.getCell(12);
        if (e.pdf_url) { src.value = { text: "Open PDF", hyperlink: e.pdf_url }; src.font = { color: { argb: "FF4F46E5" }, underline: true }; }
        else src.value = "—";
      });
      const buf = await wb.xlsx.writeBuffer();
      dl(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), fname);
    } catch (e) { console.error(e); exportCsv(rows); }
  }
  function exportCsv(rows) {
    const head = COLS.map((c) => c[0]);
    const line = (arr) => arr.map((v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`).join(",");
    const body = rows.map((e) => line([e.company, e.sector, e.industry, e.sub_industry, e.event_type, e.event_date, e.event_time ? U.fmtTime(e.event_time) : "", e.mode, U.clean(e.counterparty), U.clean(e.venue), e.announced_at, e.pdf_url]));
    dl(new Blob([[line(head)].concat(body).join("\n")], { type: "text/csv" }), `meets_${TODAY}.csv`);
  }
  function dl(blob, name) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500); }

  /* ---------------- tabs + wiring ---------------- */
  function switchTab(name) {
    $$("[role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
    ["upcoming", "overview", "conferences"].forEach((t) => $("#panel-" + t).classList.toggle("hidden", t !== name));
    const p = $("#panel-" + name); p.classList.remove("fade-in"); void p.offsetWidth; p.classList.add("fade-in");
    if (name === "overview") { buildCharts(); setTimeout(resizeCharts, 60); }
    U.icons();
  }

  function wire() {
    const rerender = U.debounce(renderUpcoming, 60);
    $("#f-search").addEventListener("input", U.debounce((e) => { state.search = e.target.value; state.tableLimit = 25; renderUpcoming(); }, 200));
    $("#f-type").addEventListener("change", (e) => { state.type = e.target.value; state.tableLimit = 25; rerender(); });
    $("#f-sector").addEventListener("change", (e) => { state.sector = e.target.value; state.industry = ""; state.subIndustry = ""; cascadeIndustry(); state.tableLimit = 25; rerender(); });
    $("#f-industry").addEventListener("change", (e) => { state.industry = e.target.value; state.subIndustry = ""; cascadeSub(); state.tableLimit = 25; rerender(); });
    $("#f-subindustry").addEventListener("change", (e) => { state.subIndustry = e.target.value; state.tableLimit = 25; rerender(); });
    $("#f-mode").addEventListener("change", (e) => { state.mode = e.target.value; state.tableLimit = 25; rerender(); });
    $("#f-preset").addEventListener("change", (e) => { setPreset(e.target.value); state.tableLimit = 25; rerender(); });
    $("#f-from").addEventListener("change", (e) => { state.from = e.target.value; state.preset = "custom"; $("#f-preset").value = "custom"; state.tableLimit = 25; rerender(); });
    $("#f-to").addEventListener("change", (e) => { state.to = e.target.value; state.preset = "custom"; $("#f-preset").value = "custom"; state.tableLimit = 25; rerender(); });
    $("#clearBtn").addEventListener("click", () => {
      Object.assign(state, { type: "", sector: "", industry: "", subIndustry: "", mode: "", preset: "all", from: "", to: "", search: "", tableLimit: 25 });
      $("#f-search").value = ""; ["#f-type", "#f-sector", "#f-mode"].forEach((s) => ($(s).value = ""));
      $("#f-from").value = ""; $("#f-to").value = ""; $("#f-preset").value = "all";
      populateFacets(); renderUpcoming();
    });
    $("#viewTable").addEventListener("click", () => setView("table"));
    $("#viewTimeline").addEventListener("click", () => setView("timeline"));
    $("#exportBtn").addEventListener("click", exportExcel);
    $("#retryBtn").addEventListener("click", boot);
    $$("[role=tab]").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
    window.addEventListener("resize", resizeCharts);
  }
  function setView(v) {
    state.view = v;
    $("#viewTable").setAttribute("aria-pressed", String(v === "table"));
    $("#viewTimeline").setAttribute("aria-pressed", String(v === "timeline"));
    state.tableLimit = 25; renderUpcoming();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
