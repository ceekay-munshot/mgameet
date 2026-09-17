/* xlsx-export.js — pure, testable workbook builder shared by the browser (app.js)
   and Node (QA test). Takes ExcelJS + rows + the U helpers; returns a Workbook. */
(function () {
  "use strict";

  // [header, field, width]
  const COLS = [
    ["Company", "company", 26], ["Sector", "sector", 20], ["Industry", "industry", 22],
    ["Sub-industry", "sub_industry", 24], ["Type", "event_type", 16], ["Event Date", "event_date", 15],
    ["Time", "event_time", 10], ["Mode", "mode", 12], ["Meeting With", "counterparty", 32],
    ["Venue", "venue", 22], ["Announced", "announced_at", 14], ["Source", "pdf_url", 12],
  ];
  const lastCol = String.fromCharCode(64 + COLS.length); // "L"

  async function buildWorkbook(ExcelJS, rows, U) {
    const wb = new ExcelJS.Workbook();
    wb.creator = "Investor Meet Tracker";
    wb.created = new Date();
    const ws = wb.addWorksheet("Meetings", { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = COLS.map(([h, , w]) => ({ header: h, width: w }));

    // header: bold white on brand fill, centered, taller, frozen (view above), autofilter
    const hr = ws.getRow(1); hr.height = 26;
    hr.eachCell((c) => {
      c.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11, name: "Calibri" };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF6366F1" } };
      c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    });
    ws.autoFilter = `A1:${lastCol}1`;

    rows.forEach((e, i) => {
      const r = ws.addRow([
        e.company || "", e.sector || "", e.industry || "", e.sub_industry || "",
        e.event_type || "", e.event_date ? new Date(e.event_date + "T00:00:00Z") : "",
        e.event_time ? U.fmtTime(e.event_time) : "", e.mode || "",
        U.clean(e.counterparty) || "", U.clean(e.venue) || "",
        e.announced_at ? new Date(e.announced_at + "T00:00:00Z") : "", null,
      ]);
      r.eachCell({ includeEmpty: true }, (c) => { c.alignment = { vertical: "top", wrapText: true }; });
      if (i % 2 === 1) r.eachCell({ includeEmpty: true }, (c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF7F6FD" } }; });
      // Type cell: light tint of the type colour + darkened bold text
      const tc = r.getCell(5);
      tc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: U.argbTint(U.typeColor(e.event_type)) } };
      tc.font = { bold: true, color: { argb: "FF" + U.darkHex(U.typeColor(e.event_type), 0.42) }, name: "Calibri" };
      tc.alignment = { vertical: "top", wrapText: true };
      r.getCell(6).numFmt = "ddd, dd mmm yyyy";
      r.getCell(11).numFmt = "dd mmm yyyy";
      const src = r.getCell(12);
      if (e.pdf_url) { src.value = { text: "Open PDF", hyperlink: e.pdf_url }; src.font = { color: { argb: "FF4F46E5" }, underline: true }; }
      else src.value = "—";
    });
    return wb;
  }

  const api = { COLS, buildWorkbook };
  if (typeof window !== "undefined") window.MeetsExport = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
