/**
 * Cloudflare Pages Function: /api/contact
 * 問い合わせ送信 + セキュリティ対策。
 *
 * 必須: RESEND_API_KEY
 * 任意: CONTACT_TO / CONTACT_FROM
 * 任意: TURNSTILE_SECRET_KEY（設定時のみTurnstileを必須化）
 * KV: UC_KV（問い合わせ履歴・レート制限・監査情報）
 */

const DEFAULT_TO = "uncuore02@gmail.com";
const DEFAULT_FROM = "UNCUORE AI見積 <noreply@mail.un-cuore.com>";
const MAX_BODY_BYTES = 32 * 1024;
const RATE_WINDOW_SECONDS = 10 * 60;
const RATE_MAX = 5;

function getKV(env) { return env.UNCUORE_KV || env.UC_KV || null; }

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.RESEND_API_KEY) return json({ message: "サーバー設定エラー（メールAPIキー未設定）" }, 500);
  if (!sameOrigin(request)) return json({ message: "不正なリクエストです" }, 403);

  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_BODY_BYTES) return json({ message: "送信データが大きすぎます" }, 413);

  const client = clientInfo(request);
  if (getKV(env)) {
    const limited = await rateLimit(getKV(env), `rl:contact:${client.ip || "unknown"}`, RATE_MAX, RATE_WINDOW_SECONDS);
    if (limited) return json({ message: "短時間に送信回数が多すぎます。しばらく時間をおいて再度お試しください。" }, 429);
  }

  let body;
  try { body = await request.json(); }
  catch (_) { return json({ message: "不正なリクエストです" }, 400); }

  // ハニーポット。botには成功を装い、メール送信・KV保存を行わない。
  if (body.website) return json({ ok: true }, 200);

  // Turnstile Secretを設定した場合のみ必須化（未設定なら既存運用を壊さない）。
  if (env.TURNSTILE_SECRET_KEY) {
    const token = str(body.turnstileToken, 4096);
    const ok = await verifyTurnstile(env.TURNSTILE_SECRET_KEY, token, client.ip);
    if (!ok) return json({ message: "セキュリティ確認に失敗しました。ページを再読み込みしてお試しください。" }, 403);
  }

  const name = str(body.name, 80);
  const tel = str(body.tel, 30);
  const mail = str(body.mail, 160).toLowerCase();
  const msg = str(body.msg, 3000);
  const estimateNo = str(body.estimateNo, 40);
  const wishMenu = str(body.wishMenu, 100);
  const source = body.source === "campaign" ? "campaign" : "normal";
  const campaignName = str(body.campaignName, 100);
  const normalPrice = safeMoney(body.normalPrice);
  const campaignPrice = safeMoney(body.campaignPrice);

  if (!validName(name) || !validTel(tel) || !validEmail(mail)) {
    return json({ message: "入力内容に不備があります" }, 400);
  }
  if ([name, tel, mail, msg, wishMenu, campaignName].some(hasDangerousMarkup)) {
    await saveSecurityEvent(getKV(env), "blocked_input", client, { estimateNo, source });
    return json({ message: "使用できない文字列が含まれています。入力内容をご確認ください。" }, 400);
  }

  const yen = n => "¥" + Number(n).toLocaleString("ja-JP");
  const isCamp = source === "campaign";
  const subject = `【AI見積${isCamp ? "・キャンペーン" : ""}】お問い合わせ｜${name}様${estimateNo ? `（${estimateNo}）` : ""}`;
  const campLines = isCamp
    ? `■流入タイプ：キャンペーン\n■キャンペーン名：${campaignName || "—"}\n■通常価格：${yen(normalPrice)}（税別）\n■キャンペーン価格：${campaignPrice ? yen(campaignPrice) + "（税別）" : "—（期間外・通常価格を表示）"}\n■割引額：${campaignPrice ? yen(Math.max(0, normalPrice - campaignPrice)) : "¥0"}\n`
    : `■流入タイプ：通常\n`;
  const text =
`UNCUORE AI見積LPからお問い合わせがありました。

■お名前：${name}
■電話番号：${tel}
■メール：${mail}
${estimateNo ? `■見積番号：${estimateNo}\n` : ""}${wishMenu ? `■希望メニュー：${wishMenu}\n` : ""}${campLines}■送信日時：${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}

――― お問い合わせ内容 ―――
${msg || "（本文なし）"}

※このメールに返信すると、お客様（${mail}）宛に届きます。`;

  let res;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: env.FROM_EMAIL ? `UNCUORE AI見積 <${env.FROM_EMAIL}>` : (env.CONTACT_FROM || DEFAULT_FROM),
        to: [env.NOTIFY_EMAIL || env.CONTACT_TO || DEFAULT_TO],
        reply_to: mail,
        subject,
        text,
      }),
    });
  } catch (_) {
    return json({ message: "メールサーバーへの接続に失敗しました" }, 502);
  }

  if (!res.ok) {
    let detail = "";
    try { const e = await res.json(); detail = e && e.message ? e.message : ""; } catch (_) {}
    return json({ message: detail || `メール送信に失敗しました（${res.status}）` }, 502);
  }

  if (getKV(env)) {
    try {
      const at = new Date().toISOString();
      await getKV(env).put(
        "inq:" + at + "-" + crypto.randomUUID().slice(0, 8),
        JSON.stringify({
          at, estimateNo, name, tel, mail, msg, wishMenu, source,
          ip: client.ip, userAgent: client.userAgent, country: client.country,
          colo: client.colo, rayId: client.rayId,
        })
      );
      if (estimateNo) {
        const raw = await getKV(env).get("est:" + estimateNo);
        if (raw) {
          const rec = JSON.parse(raw);
          rec.name = rec.name || name; rec.tel = rec.tel || tel; rec.mail = rec.mail || mail;
          if (wishMenu) rec.wishMenu = wishMenu;
          rec.history = Array.isArray(rec.history) ? rec.history.slice(-99) : [];
          rec.history.push(`[${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}] お問い合わせフォーム送信（${name}）`);
          await getKV(env).put("est:" + estimateNo, JSON.stringify(rec));
        }
      }
    } catch (_) { /* メール送信成功を妨げない */ }
  }

  return json({ ok: true }, 200);
}

export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ message: "Method Not Allowed" }, 405);
}

function clientInfo(request) {
  const cf = request.cf || {};
  return {
    ip: str(request.headers.get("CF-Connecting-IP"), 80),
    userAgent: str(request.headers.get("User-Agent"), 500),
    country: str(cf.country || request.headers.get("CF-IPCountry"), 8),
    colo: str(cf.colo, 20),
    rayId: str(request.headers.get("CF-Ray"), 80),
  };
}

function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true; // 一部ブラウザ/ナビゲーション互換
  try { return new URL(origin).host === new URL(request.url).host; }
  catch (_) { return false; }
}

async function rateLimit(kv, key, max, ttl) {
  try {
    const cur = Number(await kv.get(key) || 0);
    if (cur >= max) return true;
    await kv.put(key, String(cur + 1), { expirationTtl: ttl });
  } catch (_) {}
  return false;
}

async function verifyTurnstile(secret, token, ip) {
  if (!token) return false;
  try {
    const form = new FormData();
    form.append("secret", secret);
    form.append("response", token);
    if (ip) form.append("remoteip", ip);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const d = await r.json();
    return !!d.success;
  } catch (_) { return false; }
}

async function saveSecurityEvent(kv, type, client, extra) {
  if (!kv) return;
  try {
    const at = new Date().toISOString();
    await kv.put(`sec:${at}-${crypto.randomUUID().slice(0, 8)}`, JSON.stringify({ at, type, ...client, ...extra }), { expirationTtl: 60 * 60 * 24 * 30 });
  } catch (_) {}
}

function validName(v) { return v.length >= 1 && v.length <= 80; }
function validTel(v) { return /^[0-9+\-()\s]{8,30}$/.test(v); }
function validEmail(v) { return v.length <= 160 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v); }
function hasDangerousMarkup(v) {
  const s = String(v || "");
  return /<\s*\/?\s*(script|iframe|object|embed|svg|math|img|style|link|meta)\b/i.test(s)
    || /\bon\w+\s*=/i.test(s)
    || /javascript\s*:/i.test(s)
    || /data\s*:\s*text\/html/i.test(s);
}
function safeMoney(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100000000 ? Math.round(n) : 0;
}
function str(v, max) { return typeof v === "string" ? v.trim().slice(0, max) : ""; }
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: securityHeaders({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }),
  });
}
function securityHeaders(extra = {}) {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
    ...extra,
  };
}
