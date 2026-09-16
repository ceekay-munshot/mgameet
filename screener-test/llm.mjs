// Claude (Anthropic) on Amazon Bedrock — Converse API, bearer key, model-chain + patient retry.
// Reuses the same config as our paramemo repo: BEDROCK_API_KEY (secret), AWS_REGION + BEDROCK_MODEL_IDS (vars).
const REGION = process.env.AWS_REGION || "us-east-1";
const KEY = process.env.BEDROCK_API_KEY;
const MODELS = (process.env.BEDROCK_MODEL_IDS || (process.env.BEDROCK_MODEL_ID || "").trim() ||
  "anthropic.claude-sonnet-5,us.anthropic.claude-sonnet-5,us.anthropic.claude-sonnet-4-5-20250929-v1:0")
  .split(",").map((s) => s.trim()).filter(Boolean);
export const llmAvailable = !!KEY;

async function converse(content, system, maxTokens) {
  if (!KEY) throw new Error("BEDROCK_API_KEY not set");
  const body = JSON.stringify({ system: [{ text: system }], messages: [{ role: "user", content }],
    inferenceConfig: { temperature: 0, maxTokens } });
  const ROUNDS = 6; // ride out Bedrock overload; returns instantly on success
  let lastErr = "";
  for (let round = 0; round < ROUNDS; round++) {
    let busy = false;
    for (const model of MODELS) {
      try {
        const res = await fetch(`https://bedrock-runtime.${REGION}.amazonaws.com/model/${encodeURIComponent(model)}/converse`, {
          method: "POST",
          headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json", accept: "application/json" },
          body, signal: AbortSignal.timeout(120000),
        });
        if (res.status === 429 || res.status >= 500) { lastErr = `HTTP ${res.status} (busy)`; busy = true; continue; }
        if ([400, 403, 404].includes(res.status)) { lastErr = `HTTP ${res.status} ${(await res.text()).slice(0,160)}`; continue; }
        if (res.status !== 200) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0,200)}`);
        const data = await res.json();
        const parts = data?.output?.message?.content;
        const text = Array.isArray(parts) ? parts.map((p) => p?.text || "").join("") : "";
        if (text) return text.trim();
        lastErr = "empty response";
      } catch (e) { lastErr = `network: ${e.message}`; busy = true; }
    }
    if (!busy) break;                         // all models unusable (not just busy) — waiting won't help
    if (round < ROUNDS - 1) { console.log(`  bedrock busy (${lastErr}); waiting 30s…`); await new Promise((r) => setTimeout(r, 30000)); }
  }
  throw new Error(`bedrock exhausted — last: ${lastErr}`);
}
export async function callText(system, user, maxTokens = 2000) {
  return converse([{ text: user }], system, maxTokens);
}
export async function callWithPdf(system, instruction, pdfBuffer, maxTokens = 2500) {
  const bytes = Buffer.from(pdfBuffer).toString("base64");
  return converse([{ document: { format: "pdf", name: "announcement", source: { bytes } } }, { text: instruction }], system, maxTokens);
}
export function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  return null;
}
