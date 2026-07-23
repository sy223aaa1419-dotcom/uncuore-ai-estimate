/** Cloudflare Pages Function: /api/<action> */

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_RATE_MAX = 10;
const PUBLIC_RECORD_RATE_MAX = 20;
const RATE_WINDOW_SECONDS = 10 * 60;

function getKV(env) { return env.UNCUORE_KV || env.UC_KV || null; }
function siteKeyOf(env) { return env.VITE_TURNSTILE_SITE_KEY || env.TURNSTILE_SITE_KEY || ""; }

export async function onRequest(context) {
  const { request, env, params } = context;
  const action = String(params.action || "");
  const method = request.method;

  if (action === "health" && method === "GET") {
    return json({
      ok: true, functions: true, kvBound: !!getKV(env),
      adminPasswordSet: !!env.ADMIN_PASSWORD, resendKeySet: !!env.RESEND_API_KEY,
      anthropicKeySet: !!env.ANTHROPIC_API_KEY,
      turnstileEnabled: !!(env.TURNSTILE_SECRET_KEY && siteKeyOf(env)),
      time: new Date().toISOString(),
    }, 200);
  }

  // 公開設定。Site Keyは公開情報なので返してよい。
  if (action === "security-config" && method === "GET") {
    return json({ turnstileEnabled: !!(env.TURNSTILE_SECRET_KEY && siteKeyOf(env)), turnstileSiteKey: siteKeyOf(env) }, 200);
  }

  if (action === "login" && method === "POST") {
    if (!env.ADMIN_PASSWORD) return json({ message: "サーバー設定エラー：管理者パスワードが未設定です" }, 500);
    const client = clientInfo(request);
    if (getKV(env)) {
      const limited = await rateLimit(getKV(env), `rl:login:${client.ip || "unknown"}`, LOGIN_RATE_MAX, RATE_WINDOW_SECONDS);
      if (limited) return json({ message: "ログイン試行回数が多すぎます。しばらく時間をおいてください。" }, 429);
    }
    const b = await request.json().catch(() => ({}));
    const input = typeof b.pass === "string" ? b.pass : "";
    const expected = String(env.ADMIN_PASSWORD);
    if (!(await secureEqual(input, expected))) {
      await saveSecurityEvent(getKV(env), "admin_login_failed", client, {});
      return json({ message: "パスワードが違います" }, 401);
    }
    const token = await issueToken(expected, client.ip);
    return json({ ok: true, token, expiresIn: SESSION_TTL_MS / 1000 }, 200);
  }

  if (!getKV(env)) return json({ message: "サーバー設定エラー：KVが未設定です" }, 500);
  const kv = getKV(env);
  const client = clientInfo(request);

  const isAdmin = await verifyAdmin(request, env.ADMIN_PASSWORD);
  const needAdmin = () => json({ message: "認証エラー：管理者ログインが必要です" }, 401);

  try {
    /* ---------- 設定 ---------- */
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
      if (!sameOrigin(request)) return json({ message: "不正なリクエストです" }, 403);
      const limited = await rateLimit(kv, `rl:record:${client.ip || "unknown"}`, PUBLIC_RECORD_RATE_MAX, RATE_WINDOW_SECONDS);
      if (limited) return json({ message: "短時間のリクエストが多すぎます" }, 429);

      const b = await request.json().catch(() => null);
      if (!b || typeof b !== "object") return json({ message: "不正なデータです" }, 400);
      const rec = sanitizeEstimate(b);
      if (estimateHasDangerousMarkup(rec)) {
        await saveSecurityEvent(kv, "blocked_estimate_input", client, {});
        return json({ message: "使用できない文字列が含まれています" }, 400);
      }
      const ymd = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
      let seq = parseInt((await kv.get("seq:" + ymd)) || "0", 10);
      let no = "";
      for (let i = 0; i < 20; i++) {
        seq++; no = `UC-${ymd}-${String(seq).padStart(4, "0")}`;
        if (!(await kv.get("est:" + no))) break;
      }
      await kv.put("seq:" + ymd, String(seq), { expirationTtl: 60 * 60 * 24 * 3 });
      rec.no = no; rec.at = rec.at || new Date().toISOString();
      rec.audit = { ip: client.ip, userAgent: client.userAgent, country: client.country, colo: client.colo, rayId: client.rayId };
      await kv.put("est:" + no, JSON.stringify(rec));
      return json({ no }, 200);
    }
    if (action === "records" && method === "GET") {
      if (!isAdmin) return needAdmin();
      const list = await listAll(kv, "est:");
      list.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
      return json({ list }, 200);
    }
    if (action === "record" && method === "PUT") {
      if (!isAdmin) return needAdmin();
      const b = await request.json().catch(() => null);
      const rec = b && b.record;
      if (!rec || typeof rec.no !== "string" || !/^UC-\d{8}-(?:\d{4}|[A-Z0-9]{6})$/.test(rec.no)) return json({ message: "不正なデータです" }, 400);
      const s = JSON.stringify(rec);
      if (s.length > 200_000) return json({ message: "データが大きすぎます" }, 413);
      await kv.put("est:" + rec.no, s);
      return json({ ok: true }, 200);
    }
    if (action === "record" && method === "DELETE") {
      if (!isAdmin) return needAdmin();
      const no = new URL(request.url).searchParams.get("no") || "";
      if (!/^UC-\d{8}-(?:\d{4}|[A-Z0-9]{6})$/.test(no)) return json({ message: "不正なリクエストです" }, 400);
      await kv.delete("est:" + no);
      return json({ ok: true }, 200);
    }

    /* ---------- 問い合わせ ---------- */
    if (action === "inquiries" && method === "GET") {
      if (!isAdmin) return needAdmin();
      const list = await listAll(kv, "inq:");
      list.sort((a, b) => (String(a.at) < String(b.at) ? 1 : -1));
      return json({ list }, 200);
    }
    if (action === "security-events" && method === "GET") {
      if (!isAdmin) return needAdmin();
      const list = await listAll(kv, "sec:");
      list.sort((a, b) => (String(a.at) < String(b.at) ? 1 : -1));
      return json({ list }, 200);
    }

    return json({ message: "Not Found" }, 404);
  } catch (e) {
    console.error("[api]", e && e.stack ? e.stack : e);
    return json({ message: "サーバーエラーが発生しました" }, 500);
  }
}

async function listAll(kv, prefix) {
  let cursor;
  const keys = [];
  do {
    const res = await kv.list({ prefix, limit: 1000, cursor });
    keys.push(...res.keys);
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor && keys.length < 5000);
  const vals = await Promise.all(keys.slice(0, 5000).map(k => kv.get(k.name)));
  const out = [];
  for (const v of vals) if (v) { try { out.push(JSON.parse(v)); } catch (_) {} }
  return out;
}

function sanitizeEstimate(b) {
  const s = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const arr = Array.isArray(b.options) ? b.options.slice(0, 30).map(x => s(String(x), 100)) : [];
  return {
    at: s(b.at, 40), name: s(b.name, 80), tel: s(b.tel, 30), mail: s(b.mail, 160), pref: s(b.pref, 20),
    maker: s(b.maker, 60), model: s(b.model, 100), size: s(b.size, 4), condition: s(b.condition, 10),
    menu: s(b.menu, 100), years: safeNum(b.years, 0, 30), options: arr, total: safeNum(b.total, 0, 100000000),
    source: b.source === "campaign" ? "campaign" : "normal", campaignName: s(b.campaignName, 100),
    normalPrice: safeNum(b.normalPrice, 0, 100000000), campaignPrice: safeNum(b.campaignPrice, 0, 100000000),
    status: "未対応", memo: "", history: [],
  };
}
function estimateHasDangerousMarkup(rec) {
  return [rec.name, rec.tel, rec.mail, rec.pref, rec.maker, rec.model, rec.menu, rec.campaignName, ...(rec.options || [])].some(hasDangerousMarkup);
}
function hasDangerousMarkup(v) {
  const s = String(v || "");
  return /<\s*\/?\s*(script|iframe|object|embed|svg|math|img|style|link|meta)\b/i.test(s) || /\bon\w+\s*=/i.test(s) || /javascript\s*:/i.test(s);
}
function safeNum(v, min, max) { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min; }

function clientInfo(request) {
  const cf = request.cf || {};
  return {
    ip: trunc(request.headers.get("CF-Connecting-IP"), 80), userAgent: trunc(request.headers.get("User-Agent"), 500),
    country: trunc(cf.country || request.headers.get("CF-IPCountry"), 8), colo: trunc(cf.colo, 20), rayId: trunc(request.headers.get("CF-Ray"), 80),
  };
}
function trunc(v, max) { return typeof v === "string" ? v.slice(0, max) : ""; }
function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try { return new URL(origin).host === new URL(request.url).host; } catch (_) { return false; }
}
async function rateLimit(kv, key, max, ttl) {
  try { const n = Number(await kv.get(key) || 0); if (n >= max) return true; await kv.put(key, String(n + 1), { expirationTtl: ttl }); }
  catch (_) {}
  return false;
}
async function saveSecurityEvent(kv, type, client, extra) {
  if (!kv) return;
  try { const at = new Date().toISOString(); await kv.put(`sec:${at}-${crypto.randomUUID().slice(0, 8)}`, JSON.stringify({ at, type, ...client, ...extra }), { expirationTtl: 60 * 60 * 24 * 30 }); }
  catch (_) {}
}

async function secureEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb); let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
async function issueToken(secret, ip) {
  const payload = b64url(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS, ip: ip || "" }));
  const sig = await hmac(secret, payload);
  return `${payload}.${sig}`;
}
async function verifyAdmin(request, secret) {
  if (!secret) return false;
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice(7); const parts = token.split("."); if (parts.length !== 2) return false;
  const expected = await hmac(String(secret), parts[0]); if (!(await secureEqual(parts[1], expected))) return false;
  try {
    const data = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    if (!data.exp || Date.now() > data.exp) return false;
    const ip = request.headers.get("CF-Connecting-IP") || "";
    return !data.ip || !ip || data.ip === ip;
  } catch (_) { return false; }
}
async function hmac(secret, value) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(value))));
}
function b64url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function fromB64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  const raw = atob(s); const out = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i); return out;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: securityHeaders({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }) });
}
function securityHeaders(extra = {}) {
  return { "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "strict-origin-when-cross-origin", "Permissions-Policy": "camera=(self), microphone=(), geolocation=()", ...extra };
}
