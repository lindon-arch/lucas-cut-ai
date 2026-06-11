/* Luca's Cut — body-composition analysis proxy.
 * Holds the Anthropic API key server-side; the public app never sees it.
 * Calls Claude vision with a structured-output schema and returns the estimate.
 *
 * Env (set as Worker secrets/vars):
 *   ANTHROPIC_API_KEY  (secret, required)
 *   APP_TOKEN          (secret, required) — shared string the app sends; light abuse gate
 *   ALLOW_ORIGIN       (var, optional)    — defaults to the GitHub Pages origin
 *   MODEL              (var, optional)    — defaults to claude-opus-4-8; set to
 *                                           claude-sonnet-4-6 / claude-haiku-4-5 to cut cost
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

export default {
  async fetch(request, env) {
    const ALLOW_ORIGIN = env.ALLOW_ORIGIN || "https://lindon-arch.github.io";
    const cors = {
      "Access-Control-Allow-Origin": ALLOW_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, x-app-token",
      "Vary": "Origin",
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { ...cors, "content-type": "application/json" },
      });

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return json({ error: "POST only" }, 405);

    // Light abuse gate — not real auth (a public page can't hide a secret),
    // but it blocks casual misuse. Pair with an Anthropic spend cap.
    const origin = request.headers.get("Origin") || "";
    if (origin && origin !== ALLOW_ORIGIN) return json({ error: "forbidden origin" }, 403);
    if (env.APP_TOKEN && request.headers.get("x-app-token") !== env.APP_TOKEN)
      return json({ error: "unauthorized" }, 401);

    if (!env.ANTHROPIC_API_KEY) return json({ error: "server not configured" }, 500);

    let body;
    try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const images = Array.isArray(body.images) ? body.images.slice(0, 3) : [];
    if (!images.length) return json({ error: "no images" }, 400);
    const ctx = body.context || {};

    const content = images.map((im) => ({
      type: "image",
      source: { type: "base64", media_type: im.media_type || "image/jpeg", data: im.data },
    }));
    content.push({ type: "text", text: userPrompt(ctx) });

    const payload = {
      model: env.MODEL || "claude-opus-4-8",
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
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      data = await upstream.json();
    } catch (e) {
      return json({ error: "network", detail: String(e) }, 502);
    }
    if (!upstream.ok) return json({ error: "upstream", status: upstream.status, detail: data }, 502);

    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    let parsed;
    try { parsed = JSON.parse(text); } catch { return json({ error: "parse", raw: text }, 502); }
    return json(parsed, 200);
  },
};
