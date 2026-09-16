const REGION = process.env.BEDROCK_REGION || "us-east-1";
const MODEL  = process.env.BEDROCK_MODEL_ID || "us.anthropic.claude-3-5-sonnet-20241022-v2:0";
const KEY    = process.env.BEDROCK_API_KEY;
const ENDPOINT = `https://bedrock-runtime.${REGION}.amazonaws.com/model/${encodeURIComponent(MODEL)}/converse`;
export const llmAvailable = !!KEY;

async function converse(body) {
  if (!KEY) throw new Error("BEDROCK_API_KEY not set");
  const r = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`bedrock ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  return (j?.output?.message?.content || []).map((c) => c.text || "").join("").trim();
}
export async function callText(system, user, maxTokens = 2000) {
  return converse({ system: [{ text: system }], messages: [{ role: "user", content: [{ text: user }] }],
    inferenceConfig: { maxTokens, temperature: 0.1 } });
}
export async function callWithPdf(system, instruction, pdfBuffer, maxTokens = 2500) {
  const bytes = Buffer.from(pdfBuffer).toString("base64");
  return converse({ system: [{ text: system }], messages: [{ role: "user", content: [
    { document: { format: "pdf", name: "announcement", source: { bytes } } }, { text: instruction } ] }],
    inferenceConfig: { maxTokens, temperature: 0.1 } });
}
export function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  return null;
}
