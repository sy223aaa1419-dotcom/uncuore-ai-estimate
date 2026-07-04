/**
 * Cloudflare Pages Function: /api/<action>（動的ルート）
 * 見積・問い合わせ・設定（メニュー価格等）をCloudflare KVに保存する共有データAPI。
 * 注: /api/estimate（AI判定）と /api/contact（メール送信）は静的ファイルが優先されるため、
 *     このファイルには到達しない。衝突を避けるため見積レコードは record/records という名前を使用。
 *
 * 必要な設定（Cloudflareダッシュボード）:
 *   1. KVネームスペースを作成し、Pagesプロジェクトに変数名 UC_KV でバインド
 *   2. Secret: ADMIN_PASSWORD … 管理画面のログインパスワード
 *
 * エンドポイント:
 *   POST   /api/login        … 管理パスワード検証（公開）
 *   POST   /api/record       … 見積レコード作成・見積番号発行（公開）
 *   GET    /api/records      … 見積一覧（管理者）
 *   PUT    /api/record       … 見積レコード更新（管理者）
 *   DELETE /api/record?no=…  … 見積レコード削除（管理者）
 *   GET    /api/inquiries    … 問い合わせ一覧（管理者）
 *   GET    /api/settings     … メニュー・価格・車種DB取得（公開／LP表示に必要）
 *   PUT    /api/settings     … 同保存（管理者）
 */

export async function onRequest(context) {
  const { request, env, params } = context;
  const action = String(params.action || "");
  const method = request.method;

  if (!env.UC_KV) {
    return json({ message: "サーバー設定エラー：KVが未設定です。CloudflareでKVネームスペースを作成し、変数名 UC_KV でバインドしてください（公開手順.md参照）" }, 500);
  }
  const kv = env.UC_KV;

  const adminKey = request.headers.get("X-Admin-Key") || "";
  const isAdmin = !!env.ADMIN_PASSWORD && adminKey === env.ADMIN_PASSWORD;
  const needAdmin = () => json({ message: "認証エラー：管理者ログインが必要です" }, 401);

  try {
    /* ---------- 管理ログイン ---------- */
    if (action === "login" && method === "POST") {
      if (!env.ADMIN_PASSWORD) return json({ message: "サーバー設定エラー：Secret ADMIN_PASSWORD が未設定です" }, 500);
      const b = await request.json().catch(() => ({}));
      if (typeof b.pass === "string" && b.pass === env.ADMIN_PASSWORD) return json({ ok: true }, 200);
      return json({ message: "パスワードが違います" }, 401);
    }

    /* ---------- 設定（メニュー・価格・車種DB） ---------- */
    if (action === "settings" && method === "GET") {
      const v = await kv.get("settings");
      return json({ settings: v ? JSON.parse(v) : null }, 200);
    }
    if (action === "settings" && method === "PUT") {
      if (!isAdmin) return needAdmin();
      const b = await request.json().catch(() => null);
      if (!b || typeof b !== "object") return json({ message: "不正なデータです" }, 400);
      const s = JSON.stringify(b);
      if (s.length > 2_000_000) return json({ message: "設定データが大きすぎます" }, 413);
      await kv.put("settings", s);
      return json({ ok: true }, 200);
    }

    /* ---------- 見積レコード ---------- */
    if (action === "record" && method === "POST") {
      // 公開：お客様の見積完了時に呼ばれる。見積番号はサーバー側で採番
      const b = await request.json().catch(() => null);
      if (!b || typeof b !== "object") return json({ message: "不正なデータです" }, 400);
      const rec = sanitizeEstimate(b);
      // JSTの日付で採番 UC-YYYYMMDD-0001
      const ymd = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
      let seq = parseInt((await kv.get("seq:" + ymd)) || "0", 10);
      let no = "";
      for (let i = 0; i < 20; i++) {
        seq++;
        no = `UC-${ymd}-${String(seq).padStart(4, "0")}`;
        if (!(await kv.get("est:" + no))) break; // 採番衝突を回避
      }
      await kv.put("seq:" + ymd, String(seq), { expirationTtl: 60 * 60 * 24 * 3 });
      rec.no = no;
      rec.at = rec.at || new Date().toISOString();
      await kv.put("est:" + no, JSON.stringify(rec));
      return json({ no }, 200);
    }
    if (action === "records" && method === "GET") {
      if (!isAdmin) return needAdmin();
      const list = await listAll(kv, "est:");
      // 見積番号（=キー）で新しい順に
      list.sort((a, b2) => (a.no < b2.no ? 1 : -1));
      return json({ list }, 200);
    }
    if (action === "record" && method === "PUT") {
      if (!isAdmin) return needAdmin();
      const b = await request.json().catch(() => null);
      const rec = b && b.record;
      if (!rec || typeof rec.no !== "string" || !rec.no.startsWith("UC-")) return json({ message: "不正なデータです" }, 400);
      const s = JSON.stringify(rec);
      if (s.length > 200_000) return json({ message: "データが大きすぎます" }, 413);
      await kv.put("est:" + rec.no, s);
      return json({ ok: true }, 200);
    }
    if (action === "record" && method === "DELETE") {
      if (!isAdmin) return needAdmin();
      const no = new URL(request.url).searchParams.get("no") || "";
      if (!no.startsWith("UC-")) return json({ message: "不正なリクエストです" }, 400);
      await kv.delete("est:" + no);
      return json({ ok: true }, 200);
    }

    /* ---------- 問い合わせ一覧 ---------- */
    if (action === "inquiries" && method === "GET") {
      if (!isAdmin) return needAdmin();
      const list = await listAll(kv, "inq:");
      list.sort((a, b2) => (String(a.at) < String(b2.at) ? 1 : -1));
      return json({ list }, 200);
    }

    return json({ message: "Not Found" }, 404);
  } catch (e) {
    return json({ message: "サーバーエラー：" + (e && e.message ? e.message : "不明") }, 500);
  }
}

/* KVから prefix 一致の全レコードを取得（最大1000件） */
async function listAll(kv, prefix) {
  const res = await kv.list({ prefix, limit: 1000 });
  const vals = await Promise.all(res.keys.map(k => kv.get(k.name)));
  const out = [];
  for (const v of vals) { if (v) { try { out.push(JSON.parse(v)); } catch (_) {} } }
  return out;
}

/* お客様入力由来の見積レコードを型・長さで正規化（KV汚染防止） */
function sanitizeEstimate(b) {
  const s = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
  const arr = Array.isArray(b.options) ? b.options.slice(0, 30).map(x => s(String(x), 100)) : [];
  return {
    at: s(b.at, 40),
    name: s(b.name, 100), tel: s(b.tel, 40), mail: s(b.mail, 200), pref: s(b.pref, 20),
    maker: s(b.maker, 60), model: s(b.model, 100), size: s(b.size, 4),
    condition: s(b.condition, 10), menu: s(b.menu, 100), years: Number(b.years) || 0,
    options: arr, total: Number(b.total) || 0,
    status: "未対応", memo: "", history: [],
  };
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
