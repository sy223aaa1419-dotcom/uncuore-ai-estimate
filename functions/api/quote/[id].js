/**
 * GET   /api/quote/:id  → 見積詳細取得
 * PATCH /api/quote/:id  → ステータス・メモ更新
 * 認証: Authorization: Bearer <token>
 */

const CORS = {
  "Access-Control-Allow-Origin": "https://ai.un-cuore.com",
  "Access-Control-Allow-Methods": "GET, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

async function verifyToken(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace("Bearer ", "").trim();
  if (!token) return false;
  const val = await env.UNCUORE_KV.get(`session:${token}`);
  return val === "1";
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

export async function onRequestGet({ request, env, params }) {
  const headers = { ...CORS, "Content-Type": "application/json" };
  if (!(await verifyToken(request, env))) {
    return new Response(JSON.stringify({ error: "認証が必要です" }), { status: 401, headers });
  }
  const raw = await env.UNCUORE_KV.get(`quote:${params.id}`);
  if (!raw) return new Response(JSON.stringify({ error: "見積が見つかりません" }), { status: 404, headers });
  return new Response(raw, { status: 200, headers });
}

export async function onRequestPatch({ request, env, params }) {
  const headers = { ...CORS, "Content-Type": "application/json" };
  if (!(await verifyToken(request, env))) {
    return new Response(JSON.stringify({ error: "認証が必要です" }), { status: 401, headers });
  }

  const raw = await env.UNCUORE_KV.get(`quote:${params.id}`);
  if (!raw) return new Response(JSON.stringify({ error: "見積が見つかりません" }), { status: 404, headers });

  let body;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers }); }

  const quote = JSON.parse(raw);
  if (body.status !== undefined) quote.status = body.status;
  if (body.memo   !== undefined) quote.memo   = body.memo;

  await env.UNCUORE_KV.put(`quote:${params.id}`, JSON.stringify(quote), {
    expirationTtl: 60 * 60 * 24 * 365 * 2,
  });

  // ※ インデックスはIDX単体キー方式のためステータス更新は不要
  // （一覧取得時は常にquote:IDから最新を読む）

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
