/* Luca's Cut — cloud sync / backup (Vercel serverless function).
 * Stores the app's small data blob (numbers + logs; photos stay on-device) in
 * Vercel KV / Upstash Redis, keyed by a sync id. Last-write-wins on the client.
 *
 * Env (KV_* auto-injected by Vercel KV, or UPSTASH_* by the Upstash integration):
 *   KV_REST_API_URL / UPSTASH_REDIS_REST_URL
 *   KV_REST_API_TOKEN / UPSTASH_REDIS_REST_TOKEN
 *   APP_TOKEN, ALLOW_ORIGIN (shared with /api/analyze)
 */

export default async function handler(req, res) {
  const ALLOW = process.env.ALLOW_ORIGIN || "https://lindon-arch.github.io";
  res.setHeader("Access-Control-Allow-Origin", ALLOW);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-app-token");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") return res.status(204).end();

  const origin = req.headers.origin || "";
  if (origin && origin !== ALLOW) return res.status(403).json({ error: "forbidden origin" });
  if (process.env.APP_TOKEN && req.headers["x-app-token"] !== process.env.APP_TOKEN)
    return res.status(401).json({ error: "unauthorized" });

  const URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const TK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!URL || !TK) return res.status(500).json({ error: "no store configured" });

  const rawId = (req.query && req.query.id) || (req.body && req.body.id) || "";
  const id = String(rawId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  if (!id) return res.status(400).json({ error: "no id" });
  const key = "lc:" + id;
  const auth = { Authorization: `Bearer ${TK}` };

  try {
    if (req.method === "GET") {
      const r = await fetch(`${URL}/get/${encodeURIComponent(key)}`, { headers: auth });
      const j = await r.json();
      let data = null;
      if (j && j.result) { try { data = JSON.parse(j.result); } catch { data = null; } }
      return res.status(200).json({ data });
    }
    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "bad json" }); } }
      const payload = body && body.data;
      if (payload === undefined) return res.status(400).json({ error: "no data" });
      const r = await fetch(`${URL}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { ...auth, "content-type": "text/plain" },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(502).json({ error: "store", detail: j });
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: "GET or POST" });
  } catch (e) {
    return res.status(502).json({ error: "network", detail: String(e) });
  }
}
