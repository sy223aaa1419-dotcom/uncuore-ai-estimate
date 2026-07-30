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

  // KVの見積レコードから確定済みの車両情報を取得（estimateNoがある場合）
  // 通知メール（⑧）と問い合わせ履歴 inq:（⑨）の両方で使用する
  let vehicleInfo = null;
  let vehicleLines = "";
  if (estimateNo && getKV(env)) {
    try {
      // キャンペーン版/通常版: est: + estimateNo、旧形式: record: + estimateNo の両方を試みる
      let kvRec = null;
      const rawEst = await getKV(env).get("est:" + estimateNo);
      if (rawEst) {
        kvRec = JSON.parse(rawEst);
      } else {
        const rawRec = await getKV(env).get("record:" + estimateNo);
        if (rawRec) kvRec = JSON.parse(rawRec);
      }
      if (kvRec) {
        const vMaker = kvRec.maker || kvRec.vehicle?.maker || "";
        const vModel = kvRec.model || kvRec.vehicle?.model || "";
        const vSize  = kvRec.size  || kvRec.vehicle?.size  || "";
        const vCond  = kvRec.condition || (kvRec.vehicle?.carAge === "new" ? "新車" : kvRec.vehicle?.carAge === "used" ? "経年車" : "");
        if (vMaker || vModel) {
          vehicleInfo = { maker: vMaker, model: vModel, size: vSize, condition: vCond };
          vehicleLines = `■メーカー：${vMaker || "—"}\n■車種：${vModel || "—"}\n` +
            (vSize ? `■サイズ：${vSize}\n` : "") +
            (vCond ? `■車両状態：${vCond}\n` : "");
        }
      }
    } catch (_) {}
  }
  const text =
`UNCUORE AI見積LPからお問い合わせがありました。

■見積番号：${estimateNo || "—"}
${vehicleLines}■お名前：${name}
■電話番号：${tel}
■メール：${mail}
${wishMenu ? `■希望メニュー：${wishMenu}\n` : ""}${campLines}■送信日時：${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}

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
      // 問い合わせ履歴に車両情報（maker / model / size / condition）を含めて保存
      const inqVehicle = vehicleInfo
        ? { maker: vehicleInfo.maker, model: vehicleInfo.model, size: vehicleInfo.size, condition: vehicleInfo.condition }
        : {};
      await getKV(env).put(
        "inq:" + at + "-" + crypto.randomUUID().slice(0, 8),
        JSON.stringify({
          at, estimateNo, name, tel, mail, msg, wishMenu, source,
          ...inqVehicle,
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

          if (isCamp && mail) {
            // キャンペーン版のみ：お客様へ見積メールを自動送信
            let campEmailOk = false;
            try {
              campEmailOk = await sendCampaignEmail(env, rec, { name, mail, estimateNo });
            } catch (e) {
              console.error("[contact] campaign email error:", e?.message || e);
            }
            rec.campaignEmailStatus = campEmailOk ? "sent" : "failed";
            rec.history.push(`[${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}] キャンペーン見積メール${campEmailOk ? "送信済み" : "送信失敗"}（${name}）`);
            // キャンペーン版の場合はメール送信結果をレスポンスに含める
            await getKV(env).put("est:" + estimateNo, JSON.stringify(rec));
            if (!campEmailOk) return json({ message: "メールの送信に失敗しました。もう一度お試しください。" }, 502);
            return json({ ok: true }, 200);
          }

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

// ── キャンペーン見積メール送信（お客様宛HTML） ──────────────────────────────
async function sendCampaignEmail(env, rec, contact) {
  let settings = {};
  try {
    const kv = getKV(env);
    if (kv) { const raw = await kv.get("settings"); if (raw) settings = JSON.parse(raw); }
  } catch (_) {}

  // テンプレート（デフォルト値 Object.assign で保護）
  const DEFAULT_C_TPL = {
    subject:"【Uncuore キャンペーン見積】{見積番号} {メーカー} {車種}",
    opening:"このたびはUncuoreキャンペーンにご応募いただきありがとうございます。\nお車に合わせたキャンペーン価格をお送りします。",
    heading:"キャンペーン見積結果",
    labelNormal:"通常価格", labelCamp:"キャンペーン価格", labelPrice:"税別・概算",
    note:"※ 表示価格は税別・概算です。車両の状態により変動する場合があります。\n正式なお見積は現車確認のうえご提示いたします。",
    lineText:"LINEで相談", telText:"045-548-8588",
    footer:"横浜市都筑区のカーコーティング専門店 Uncuore",
  };
  const T = Object.assign({}, DEFAULT_C_TPL,
    (settings.campaignEmailTemplate && typeof settings.campaignEmailTemplate === "object")
      ? settings.campaignEmailTemplate : {}
  );
  const D = settings.menuDescriptions || {};

  const FROM   = env.FROM_EMAIL ? `Uncuore AI見積 <${env.FROM_EMAIL}>` : "UNCUORE AI見積 <noreply@mail.un-cuore.com>";
  const NOTIFY = env.NOTIFY_EMAIL || env.CONTACT_TO || "uncuore02@gmail.com";

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function escNl(s) { return esc(s).replace(/\n/g, "<br>"); }
  function yen(n) { return "¥" + Number(n || 0).toLocaleString("ja-JP"); }

  const name       = contact.name || rec.name || "";
  const mail       = contact.mail || rec.mail || "";
  const estimateNo = contact.estimateNo || "";
  const maker      = rec.maker || "";
  const model      = rec.model || "";

  const subject = T.subject
    .replace("{見積番号}", estimateNo).replace("{メーカー}", maker)
    .replace("{車種}", model).replace("{名前}", name);

  // コーティング別説明
  const menuId  = rec.menuId || "";
  const descObj = D[menuId] || {};
  const featBlock = descObj.feature
    ? `<div style="font-size:11px;font-weight:700;color:#2556a8;margin:10px 0 3px;">【このプランの特徴】</div>
       <div style="font-size:12px;color:#444;line-height:1.7;">${escNl(descObj.feature)}</div>` : "";
  const recBlock = descObj.recommend
    ? `<div style="font-size:11px;font-weight:700;color:#2556a8;margin:10px 0 3px;">【こんな方におすすめ】</div>
       <div style="font-size:12px;color:#444;line-height:1.7;">${escNl(descObj.recommend)}</div>` : "";

  // 特典
  const tokuten = Array.isArray(rec.options) ? rec.options : [];
  const tokutenHtml = tokuten.length
    ? `<div style="background:#fffbe6;border:1px solid #f0c040;border-radius:6px;padding:12px 16px;margin:14px 0;">
         <div style="font-size:12px;font-weight:700;color:#b8860b;margin-bottom:6px;">🎁 キャンペーン特典</div>
         ${tokuten.map(t => `<div style="font-size:13px;color:#444;line-height:1.7;">${esc(t)}</div>`).join("")}
       </div>` : "";

  // 価格（縦並び・キャンペーン価格を大きく）
  const normP = Number(rec.normalPrice || 0);
  const campP = Number(rec.campaignPrice || 0);
  const priceHtml = campP > 0
    ? `<div style="margin:16px 0;">
         <div style="font-size:13px;color:#7a8799;margin-bottom:2px;">${esc(T.labelNormal)}</div>
         <div style="font-size:18px;color:#888;text-decoration:line-through;margin-bottom:12px;">${yen(normP)}</div>
         <div style="font-size:13px;color:#2556a8;font-weight:700;margin-bottom:2px;">${esc(T.labelCamp)}</div>
         <div style="font-size:32px;color:#17233a;font-weight:800;margin-bottom:2px;">${yen(campP)}</div>
         <div style="font-size:11px;color:#888;">${esc(T.labelPrice)}</div>
       </div>`
    : normP > 0
    ? `<div style="margin:16px 0;">
         <div style="font-size:13px;color:#7a8799;margin-bottom:2px;">${esc(T.labelNormal)}</div>
         <div style="font-size:32px;color:#17233a;font-weight:800;margin-bottom:2px;">${yen(normP)}</div>
         <div style="font-size:11px;color:#888;">${esc(T.labelPrice)}</div>
       </div>` : "";

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
  <p style="font-size:14px;line-height:1.8;color:#56647a;margin:0 0 22px">${escNl(T.opening)}</p>
  <div style="background:#eef4ff;border-left:4px solid #2563eb;padding:12px 16px;margin-bottom:24px">
    <div style="font-size:10px;color:#2563eb">見積番号</div>
    <div style="font-size:18px;font-weight:700;margin-top:3px">${esc(estimateNo)}</div>
  </div>
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;margin-bottom:20px">
    <tr><td style="padding:6px 0;color:#7a8799;width:100px">お車</td><td style="padding:6px 0;font-weight:600">${esc(maker)} ${esc(model)}</td></tr>
    ${rec.size && rec.size !== "—" ? `<tr><td style="padding:6px 0;color:#7a8799">サイズ</td><td style="padding:6px 0;font-weight:600">${esc(rec.size)}</td></tr>` : ""}
    ${rec.condition ? `<tr><td style="padding:6px 0;color:#7a8799">車両状態</td><td style="padding:6px 0;font-weight:600">${esc(rec.condition)}</td></tr>` : ""}
    ${rec.campaignName ? `<tr><td style="padding:6px 0;color:#7a8799">キャンペーン</td><td style="padding:6px 0;font-weight:600">${esc(rec.campaignName)}</td></tr>` : ""}
  </table>
  <div style="font-size:13px;font-weight:700;border-bottom:2px solid #e7edf5;padding-bottom:7px;margin-bottom:14px">${esc(T.heading)}</div>
  <div style="border:1px solid #e7edf5;border-radius:8px;padding:16px 20px;margin-bottom:8px">
    <div style="font-size:17px;color:#17233a;font-weight:700;margin-bottom:4px">${esc(rec.menu || "")}</div>
    ${rec.years ? `<div style="font-size:12px;color:#7a8799;margin-bottom:8px">耐久年数：${esc(String(rec.years))}年</div>` : ""}
    ${featBlock}${recBlock}
    ${tokutenHtml}
    ${priceHtml}
  </div>
  <p style="font-size:11px;color:#7b8798;line-height:1.7;margin:18px 0 22px">${escNl(T.note)}</p>
  <table width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="padding-right:5px"><a href="https://line.me/ti/p/@271goter" style="display:block;text-align:center;background:#06c755;color:#fff;text-decoration:none;padding:14px 8px;border-radius:6px;font-size:13px;font-weight:700">${esc(T.lineText)}</a></td>
    <td style="padding-left:5px"><a href="tel:0455488588" style="display:block;text-align:center;background:#17233a;color:#fff;text-decoration:none;padding:14px 8px;border-radius:6px;font-size:13px;font-weight:700">${esc(T.telText)}</a></td>
  </tr></table>
</td></tr>
<tr><td style="background:#eef2f7;padding:16px;text-align:center;color:#8a96a8;font-size:10px">${esc(T.footer)}</td></tr>
</table></td></tr></table>
</body></html>`;

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({ from: FROM, to: [mail], subject, html }),
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