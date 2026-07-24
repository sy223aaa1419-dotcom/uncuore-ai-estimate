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

  const kv = getKV(env);

  // 問い合わせ履歴は可能な範囲で保存
  if (kv) {
    try {
      const at = new Date().toISOString();
      await kv.put(
        "inq:" + at + "-" + crypto.randomUUID().slice(0, 8),
        JSON.stringify({
          at, estimateNo, name, tel, mail, msg, wishMenu, source,
          ip: client.ip, userAgent: client.userAgent, country: client.country,
          colo: client.colo, rayId: client.rayId,
        })
      );
    } catch (e) {
      console.error("[contact] inquiry KV save failed:", e?.message || e);
    }
  }

  // キャンペーン版はKVの見積レコードを正として、お客様へ見積メールを送信
  if (isCamp) {
    if (!kv) return json({ message: "キャンペーン見積の保存先を確認できませんでした" }, 503);
    if (!estimateNo) return json({ message: "見積番号を確認できませんでした。最初からやり直してください。" }, 400);

    let rec;
    try {
      const raw = await kv.get("est:" + estimateNo);
      if (!raw) return json({ message: "キャンペーン見積データを取得できませんでした。最初からやり直してください。" }, 404);
      rec = JSON.parse(raw);
    } catch (e) {
      console.error("[contact] campaign estimate read failed:", e?.message || e);
      return json({ message: "キャンペーン見積データの取得に失敗しました" }, 500);
    }

    rec.name = name;
    rec.tel = tel;
    rec.mail = mail;
    if (wishMenu) rec.wishMenu = wishMenu;
    rec.history = Array.isArray(rec.history) ? rec.history.slice(-98) : [];
    const jstNow = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
    rec.history.push(`[${jstNow}] お問い合わせフォーム送信（${name}）`);

    let campEmailOk = false;
    try {
      campEmailOk = await sendCampaignEmail(env, rec, { name, mail, estimateNo });
    } catch (e) {
      console.error("[contact] campaign email error:", e?.message || e);
    }

    rec.campaignEmailStatus = campEmailOk ? "sent" : "failed";
    rec.history.push(`[${jstNow}] キャンペーン見積メール${campEmailOk ? "送信済み" : "送信失敗"}`);

    try {
      await kv.put("est:" + estimateNo, JSON.stringify(rec));
    } catch (e) {
      console.error("[contact] campaign estimate update failed:", e?.message || e);
      if (!campEmailOk) return json({ message: "キャンペーン見積メールの送信に失敗しました" }, 502);
      return json({ ok: true, warning: "storage_failed" }, 200);
    }

    if (!campEmailOk) {
      return json({ message: "キャンペーン見積メールの送信に失敗しました。メールアドレスをご確認ください。" }, 502);
    }
    return json({ ok: true }, 200);
  }

  // 通常版は既存どおり、見積レコードへ問い合わせ履歴を追記
  if (kv && estimateNo) {
    try {
      const raw = await kv.get("est:" + estimateNo);
      if (raw) {
        const rec = JSON.parse(raw);
        rec.name = rec.name || name;
        rec.tel = rec.tel || tel;
        rec.mail = rec.mail || mail;
        if (wishMenu) rec.wishMenu = wishMenu;
        rec.history = Array.isArray(rec.history) ? rec.history.slice(-99) : [];
        rec.history.push(`[${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}] お問い合わせフォーム送信（${name}）`);
        await kv.put("est:" + estimateNo, JSON.stringify(rec));
      }
    } catch (e) {
      console.error("[contact] normal estimate update failed:", e?.message || e);
    }
  }

  return json({ ok: true }, 200);
}

export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ message: "Method Not Allowed" }, 405);
}

// ── キャンペーン見積メール送信（お客様宛HTML） ──────────────────────────────
async function sendCampaignEmail(env, rec, contact) {
  let settings = {};
  try {
    const kv = getKV(env);
    if (kv) {
      const raw = await kv.get("settings");
      if (raw) settings = JSON.parse(raw);
    }
  } catch (e) {
    console.error("[contact] settings read failed:", e?.message || e);
  }

  const DEFAULT_C_TPL = {
    subject:"【Uncuore キャンペーン見積】{見積番号} {メーカー} {車種}",
    opening:"このたびはUncuore キャンペーンにご応募いただきありがとうございます。\nお車に合わせたキャンペーン見積をお送りします。",
    heading:"キャンペーン見積結果",
    labelCampaign:"キャンペーン",
    labelMenu:"対象コーティング",
    labelBenefit:"キャンペーン特典",
    labelNormal:"通常価格",
    labelCamp:"キャンペーン価格",
    labelYears:"耐久年数",
    labelFeat:"このプランの特徴",
    labelRec:"こんな方におすすめ",
    labelPrice:"税別・概算",
    note:"※ 表示価格は税別・概算です。車両の状態により変動する場合があります。\n正式なお見積は現車確認のうえご提示いたします。",
    lineText:"LINEで相談",
    telText:"045-548-8588",
    footer:"横浜市都筑区のカーコーティング専門店 Uncuore",
  };

  const T = Object.assign(
    {},
    DEFAULT_C_TPL,
    settings.campaignEmailTemplate && typeof settings.campaignEmailTemplate === "object"
      ? settings.campaignEmailTemplate
      : {}
  );
  const D = settings.menuDescriptions && typeof settings.menuDescriptions === "object"
    ? settings.menuDescriptions
    : {};
  const menus = Array.isArray(settings.menus) ? settings.menus : [];

  const FROM = env.FROM_EMAIL
    ? `Uncuore AI見積 <${env.FROM_EMAIL}>`
    : (env.CONTACT_FROM || "UNCUORE AI見積 <noreply@mail.un-cuore.com>");

  const esc = s => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const escNl = s => esc(s).replace(/\r?\n/g, "<br>");
  const yen = n => "¥" + Number(n || 0).toLocaleString("ja-JP");
  const value = (key, fallback="") => T[key] == null ? fallback : String(T[key]);
  const label = key => esc(value(key, DEFAULT_C_TPL[key] || ""));

  const name = contact.name || rec.name || "";
  const mail = contact.mail || rec.mail || "";
  const estimateNo = contact.estimateNo || "";
  const maker = rec.maker || "";
  const model = rec.model || "";
  const campaignName = rec.campaignName || settings.campaign?.name || "";
  const menuId = rec.menuId || settings.campaign?.menuId || "";
  const menuMaster = menus.find(m => m && m.id === menuId);
  const menuName = menuMaster?.name || rec.menu || "";
  const years = Number(rec.years || menuMaster?.years || 0);
  const descObj = D[menuId] || {};

  const subjectTemplate = value("subject", DEFAULT_C_TPL.subject);
  const replacements = {
    "{見積番号}": estimateNo,
    "{メーカー}": maker,
    "{車種}": model,
    "{名前}": name,
    "{キャンペーン名}": campaignName,
  };
  let subject = subjectTemplate;
  for (const [token, replacement] of Object.entries(replacements)) {
    subject = subject.split(token).join(String(replacement || ""));
  }

  const opening = value("opening", DEFAULT_C_TPL.opening);
  const heading = value("heading", DEFAULT_C_TPL.heading);
  const note = value("note", DEFAULT_C_TPL.note);
  const lineText = value("lineText", DEFAULT_C_TPL.lineText);
  const telText = value("telText", DEFAULT_C_TPL.telText);
  const footer = value("footer", DEFAULT_C_TPL.footer);

  const featBlock = descObj.feature
    ? `<div style="font-size:11px;font-weight:700;color:#2556a8;margin:12px 0 3px;">【${label("labelFeat")}】</div>
       <div style="font-size:12px;color:#444;line-height:1.7;">${escNl(descObj.feature)}</div>`
    : "";
  const recBlock = descObj.recommend
    ? `<div style="font-size:11px;font-weight:700;color:#2556a8;margin:12px 0 3px;">【${label("labelRec")}】</div>
       <div style="font-size:12px;color:#444;line-height:1.7;">${escNl(descObj.recommend)}</div>`
    : "";

  const benefits = Array.isArray(rec.options) ? rec.options.filter(Boolean) : [];
  const benefitHtml = benefits.length
    ? `<div style="background:#fffbe6;border:1px solid #f0c040;border-radius:6px;padding:12px 16px;margin:14px 0;">
         ${value("labelBenefit", DEFAULT_C_TPL.labelBenefit) ? `<div style="font-size:12px;font-weight:700;color:#b8860b;margin-bottom:6px;">🎁 ${label("labelBenefit")}</div>` : ""}
         ${benefits.map(t => `<div style="font-size:13px;color:#444;line-height:1.7;">${esc(t)}</div>`).join("")}
       </div>`
    : "";

  const normP = Number(rec.normalPrice || 0);
  const campP = Number(rec.campaignPrice || 0);
  const priceHtml = campP > 0
    ? `<div style="margin:18px 0;">
         ${value("labelNormal", DEFAULT_C_TPL.labelNormal) ? `<div style="font-size:13px;color:#7a8799;margin-bottom:2px;">${label("labelNormal")}</div>` : ""}
         <div style="font-size:18px;color:#888;text-decoration:line-through;margin-bottom:12px;">${yen(normP)}</div>
         ${value("labelCamp", DEFAULT_C_TPL.labelCamp) ? `<div style="font-size:13px;color:#2556a8;font-weight:700;margin-bottom:2px;">${label("labelCamp")}</div>` : ""}
         <div style="font-size:32px;color:#17233a;font-weight:800;line-height:1.25;">${yen(campP)}</div>
         ${value("labelPrice", DEFAULT_C_TPL.labelPrice) ? `<div style="font-size:11px;color:#888;margin-top:3px;">${label("labelPrice")}</div>` : ""}
       </div>`
    : `<div style="margin:18px 0;">
         ${value("labelNormal", DEFAULT_C_TPL.labelNormal) ? `<div style="font-size:13px;color:#7a8799;margin-bottom:2px;">${label("labelNormal")}</div>` : ""}
         <div style="font-size:32px;color:#17233a;font-weight:800;line-height:1.25;">${yen(normP)}</div>
         ${value("labelPrice", DEFAULT_C_TPL.labelPrice) ? `<div style="font-size:11px;color:#888;margin-top:3px;">${label("labelPrice")}</div>` : ""}
       </div>`;

  const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans','Noto Sans JP',sans-serif;color:#17233a;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 14px;background:#f4f6f8"><tr><td>
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;margin:auto;background:#fff;border-radius:10px;overflow:hidden">
<tr><td style="background:#0b1120;padding:26px 30px;text-align:center;color:white">
  <div style="font-size:22px;letter-spacing:.2em;font-weight:700">UNCUORE</div>
  <div style="font-size:10px;color:#7fb0ff;letter-spacing:.2em;margin-top:5px">CAMPAIGN ESTIMATE — YOKOHAMA</div>
</td></tr>
<tr><td style="padding:30px">
  <p style="font-size:16px;font-weight:700;margin:0 0 8px">${esc(name)} 様</p>
  ${opening ? `<p style="font-size:14px;line-height:1.8;color:#56647a;margin:0 0 22px">${escNl(opening)}</p>` : ""}
  <div style="background:#eef4ff;border-left:4px solid #2563eb;padding:12px 16px;margin-bottom:24px">
    <div style="font-size:10px;color:#2563eb">見積番号</div>
    <div style="font-size:18px;font-weight:700;margin-top:3px">${esc(estimateNo)}</div>
  </div>
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;margin-bottom:22px">
    <tr><td style="padding:6px 0;color:#7a8799;width:120px">お車</td><td style="padding:6px 0;font-weight:600">${esc(maker)} ${esc(model)}</td></tr>
    ${rec.size ? `<tr><td style="padding:6px 0;color:#7a8799">サイズ</td><td style="padding:6px 0;font-weight:600">${esc(rec.size)}</td></tr>` : ""}
    ${rec.condition ? `<tr><td style="padding:6px 0;color:#7a8799">車両状態</td><td style="padding:6px 0;font-weight:600">${esc(rec.condition)}</td></tr>` : ""}
    ${campaignName ? `<tr><td style="padding:6px 0;color:#7a8799">${label("labelCampaign")}</td><td style="padding:6px 0;font-weight:600">${esc(campaignName)}</td></tr>` : ""}
  </table>
  ${heading ? `<div style="font-size:13px;font-weight:700;border-bottom:2px solid #e7edf5;padding-bottom:7px;margin-bottom:14px">${esc(heading)}</div>` : ""}
  <div style="border:1px solid #e7edf5;border-radius:8px;padding:16px 20px;margin-bottom:8px">
    ${value("labelMenu", DEFAULT_C_TPL.labelMenu) ? `<div style="font-size:11px;color:#2556a8;font-weight:700;margin-bottom:4px">${label("labelMenu")}</div>` : ""}
    <div style="font-size:17px;color:#17233a;font-weight:700;line-height:1.5">${esc(menuName)}</div>
    ${years ? `<div style="font-size:12px;color:#7a8799;margin-top:7px">${label("labelYears")}：${esc(String(years))}年</div>` : ""}
    ${featBlock}${recBlock}${benefitHtml}${priceHtml}
  </div>
  ${note ? `<p style="font-size:11px;color:#7b8798;line-height:1.7;margin:18px 0 22px">${escNl(note)}</p>` : ""}
  ${(lineText || telText) ? `<table width="100%" cellpadding="0" cellspacing="0"><tr>
    ${lineText ? `<td style="padding-right:5px"><a href="https://line.me/ti/p/@271goter" style="display:block;text-align:center;background:#06c755;color:#fff;text-decoration:none;padding:14px 8px;border-radius:6px;font-size:13px;font-weight:700">${esc(lineText)}</a></td>` : ""}
    ${telText ? `<td style="padding-left:5px"><a href="tel:0455488588" style="display:block;text-align:center;background:#17233a;color:#fff;text-decoration:none;padding:14px 8px;border-radius:6px;font-size:13px;font-weight:700">${esc(telText)}</a></td>` : ""}
  </tr></table>` : ""}
</td></tr>
${footer ? `<tr><td style="background:#eef2f7;padding:16px;text-align:center;color:#8a96a8;font-size:10px">${esc(footer)}</td></tr>` : ""}
</table></td></tr></table>
</body></html>`;

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: FROM,
      to: [mail],
      subject,
      html,
    }),
  });

  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    console.error(`[contact] campaign email failed: status=${r.status} body=${errText}`);
    return false;
  }
  return true;
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
