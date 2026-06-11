/* Luca's Cut — meal macro estimator (Vercel serverless function).
 * Takes a text description and/or photo of a meal and estimates calories + macros
 * with a component breakdown and assumptions, so the user can double-check & adjust.
 *
 * Env: ANTHROPIC_API_KEY, APP_TOKEN, ALLOW_ORIGIN, MODEL (shared with /api/analyze).
 */

const SYSTEM = [
  "You are a careful nutrition estimator for someone tracking calories and protein on a cut.",
  "Given a text description and/or photo of a meal — which may name a specific restaurant or dish",
  "(e.g. 'blackened chicken sandwich from Main Course in New Paltz') — estimate the nutrition.",
  "Use your knowledge of typical restaurant portions, preparation, sides, sauces, and cooking fats.",
  "Identify each component you can, give total calories and grams of protein, carbs, and fat,",
  "and clearly state the key assumptions you made (portion size, sides included, sauce, oil) so the",
  "user can adjust. If a photo is provided, base it on what's visibly on the plate. Lean slightly",
  "conservative on calories rather than over- or under-shooting wildly. Return ONLY the structured JSON.",
].join(" ");

const SCHEMA = {
  type: "object",
  properties: {
    dish: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          calories: { type: "number" },
          protein: { type: "number" },
        },
        required: ["name", "calories", "protein"],
        additionalProperties: false,
      },
    },
    totalCalories: { type: "number" },
    totalProtein: { type: "number" },
    totalCarbs: { type: "number" },
    totalFat: { type: "number" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    assumptions: { type: "string" },
    summary: { type: "string" },
  },
  required: ["dish", "items", "totalCalories", "totalProtein", "totalCarbs", "totalFat", "confidence", "assumptions", "summary"],
  additionalProperties: false,
};

function foodPrompt(text, hasImg) {
  const desc = text ? ` The person described it as: "${text}".` : "";
  const img = hasImg ? " A photo of the meal is included — use what is visibly on the plate." : "";
  return (
    `Estimate the nutrition for this meal.${desc}${img}` +
    " Identify each component, give total calories and grams of protein/carbs/fat," +
    " list the key assumptions you made, and a one-line summary." +
    " If a specific restaurant or dish is named, base it on typical versions of that dish."
  );
}

export default async function handler(req, res) {
  const ALLOW = process.env.ALLOW_ORIGIN || "https://lindon-arch.github.io";
  res.setHeader("Access-Control-Allow-Origin", ALLOW);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-app-token");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const origin = req.headers.origin || "";
  if (origin && origin !== ALLOW) return res.status(403).json({ error: "forbidden origin" });
  if (process.env.APP_TOKEN && req.headers["x-app-token"] !== process.env.APP_TOKEN)
    return res.status(401).json({ error: "unauthorized" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "server not configured" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "bad json" }); } }
  body = body || {};
  const text = (body.text || "").toString().slice(0, 600).trim();
  const images = Array.isArray(body.images) ? body.images.slice(0, 2) : [];
  if (!text && !images.length) return res.status(400).json({ error: "no input" });

  const content = images.map((im) => ({
    type: "image",
    source: { type: "base64", media_type: im.media_type || "image/jpeg", data: im.data },
  }));
  content.push({ type: "text", text: foodPrompt(text, images.length > 0) });

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

  const out = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  let parsed;
  try { parsed = JSON.parse(out); } catch { return res.status(502).json({ error: "parse", raw: out }); }
  return res.status(200).json(parsed);
}
