/* Luca's Cut — body-composition analysis proxy (Vercel serverless function).
 * Holds the Anthropic API key server-side; the public app never sees it.
 *
 * Env vars (set in Vercel project settings):
 *   ANTHROPIC_API_KEY  (required)
 *   APP_TOKEN          (required) — shared string the app sends; light abuse gate
 *   ALLOW_ORIGIN       (optional) — defaults to the GitHub Pages origin
 *   MODEL              (optional) — defaults to claude-opus-4-8
 */

const SYSTEM = [
  "You are a physique-assessment assistant analyzing photos of an adult man who is",
  "tracking a fat-loss cut for his own personal records. This is a rough VISUAL estimate",
  "for progress tracking — you are not a clinician and this is not medical advice.",
  "Estimate body-fat percentage conservatively and realistically from visible adiposity",
  "(abdomen, chest, flanks, back), muscle definition, separation, and vascularity.",
  "Assess muscle development by region. Be honest, specific, and encouraging — never shaming.",
  "If the photo is unclear, lower your confidence rather than guessing wildly.",
  "Return ONLY the structured JSON.",
].join(" ");

const SCHEMA = {
  type: "object",
  properties: {
    bodyFatPct: { type: "number" },
    bodyFatRange: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    visibleAbs: { type: "boolean" },
    muscleByRegion: { type: "string" },
    fatDistribution: { type: "string" },
    summary: { type: "string" },
    nextStep: { type: "string" },
  },
  required: [
    "bodyFatPct", "bodyFatRange", "confidence", "visibleAbs",
    "muscleByRegion", "fatDistribution", "summary", "nextStep",
  ],
  additionalProperties: false,
};

function userPrompt(ctx) {
  const bits = [];
  if (ctx.heightIn) bits.push(`Height ${ctx.heightIn} in`);
  if (ctx.weightLb) bits.push(`Weight ${ctx.weightLb} lb`);
  if (ctx.priorBf) bits.push(`Prior estimate ~${ctx.priorBf}% body fat`);
  if (ctx.notes) bits.push(`Athlete context: ${ctx.notes}`);
  const meta = bits.length ? ` Known context: ${bits.join("; ")}.` : "";
  return (
    `Analyze ${ctx.views || "these physique photo(s)"} and estimate body composition.` +
    meta +
    " Give one best body-fat % estimate, a plausible range, a confidence level," +
    " whether abs are visibly defined, muscle development by region, where fat concentrates," +
    " a 2–3 sentence summary, and one concrete next step."
  );
}

export default async function handler(req, res) {
  const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "https://lindon-arch.github.io";
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-app-token");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const origin = req.headers.origin || "";
  if (origin && origin !== ALLOW_ORIGIN) return res.status(403).json({ error: "forbidden origin" });
  if (process.env.APP_TOKEN && req.headers["x-app-token"] !== process.env.APP_TOKEN)
    return res.status(401).json({ error: "unauthorized" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "server not configured" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "bad json" }); } }
  body = body || {};
  const images = Array.isArray(body.images) ? body.images.slice(0, 3) : [];
  if (!images.length) return res.status(400).json({ error: "no images" });
  const ctx = body.context || {};

  const content = images.map((im) => ({
    type: "image",
    source: { type: "base64", media_type: im.media_type || "image/jpeg", data: im.data },
  }));
  content.push({ type: "text", text: userPrompt(ctx) });

  const payload = {
    model: process.env.MODEL || "claude-opus-4-8",
    max_tokens: 1024,
    system: SYSTEM,
    messages: [{ role: "user", content }],
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
  };

  let upstream, data;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    data = await upstream.json();
  } catch (e) {
    return res.status(502).json({ error: "network", detail: String(e) });
  }
  if (!upstream.ok) return res.status(502).json({ error: "upstream", status: upstream.status, detail: data });

  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  let parsed;
  try { parsed = JSON.parse(text); } catch { return res.status(502).json({ error: "parse", raw: text }); }
  return res.status(200).json(parsed);
}
