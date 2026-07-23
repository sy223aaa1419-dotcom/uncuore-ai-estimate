/**
 * GET /api/quotes  → 見積一覧取得（管理画面用）
 * 認証: Authorization: Bearer <token>
 * KVページング対応
 */

const CORS = {
  "Access-Control-Allow-Origin": "https://ai.un-cuore.com",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
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

export async function onRequestGet({ request, env }) {
  const headers = { ...CORS, "Content-Type": "application/json" };

  if (!(await verifyToken(request, env))) {
    return new Response(JSON.stringify({ error: "認証が必要です" }), { status: 401, headers });
  }

  try {
    // idx:プレフィックスで全インデックスキーをページング取得
    const allKeys = [];
    let cursor = undefined;
    do {
      const listResult = await env.UNCUORE_KV.list({
        prefix: "idx:",
        limit: 1000,
        cursor,
      });
      allKeys.push(...(listResult.keys || []));
      cursor = listResult.list_complete ? undefined : listResult.cursor;
    } while (cursor);

    // 日付降順ソート（キー名がISO日時を含む）
    allKeys.sort((a, b) => b.name.localeCompare(a.name));

    // 最大200件のquoteデータを取得
    const quotes = [];
    for (const key of allKeys.slice(0, 200)) {
      // キー形式: idx:2026-07-22T10:00:00.000Z_UC-20260722-ABCD12
      const parts = key.name.split("_");
      const quoteId = parts.slice(1).join("_"); // IDにアンダースコアが含まれる場合も対応
      if (!quoteId) continue;
      const raw = await env.UNCUORE_KV.get(`quote:${quoteId}`);
      if (raw) quotes.push(JSON.parse(raw));
    }

    return new Response(JSON.stringify({ ok: true, quotes }), { status: 200, headers });
  } catch (err) {
    console.error("quotes list error:", err);
    return new Response(JSON.stringify({ error: "データ取得に失敗しました" }), { status: 500, headers });
  }
}
