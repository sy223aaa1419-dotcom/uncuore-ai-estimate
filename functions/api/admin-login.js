/**
 * POST /api/admin-login
 * 管理画面サーバー側認証
 *
 * Secret: ADMIN_PASSWORD
 * 認証成功後 → セッショントークンを返す
 */

const CORS = {
  "Access-Control-Allow-Origin": "https://ai.un-cuore.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

export async function onRequestPost({ request, env }) {
  const headers = { ...CORS, "Content-Type": "application/json" };

  if (!env.ADMIN_PASSWORD) {
    return new Response(JSON.stringify({ error: "管理画面が設定されていません" }), { status: 503, headers });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request" }), { status: 400, headers });
  }

  if (body.password !== env.ADMIN_PASSWORD) {
    // 遅延してブルートフォース対策
    await new Promise((r) => setTimeout(r, 500));
    return new Response(JSON.stringify({ error: "パスワードが正しくありません" }), { status: 401, headers });
  }

  // セッショントークン生成（KVに保存・24時間有効）
  const token = crypto.randomUUID();
  await env.UNCUORE_KV.put(`session:${token}`, "1", { expirationTtl: 60 * 60 * 24 });

  return new Response(JSON.stringify({ ok: true, token }), { status: 200, headers });
}
