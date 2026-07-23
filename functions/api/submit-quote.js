/**
 * POST /api/submit-quote
 *
 * KVバインディング: UNCUORE_KV
 * Secrets: RESEND_API_KEY, FROM_EMAIL, NOTIFY_EMAIL, TURNSTILE_SECRET_KEY
 */

import { calcTotal, MENU_PRICING, OPTION_PRICING } from "../../src/shared-pricing.js";

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const CORS = {
  "Access-Control-Allow-Origin": "https://ai.un-cuore.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const headers = { ...CORS, "Content-Type": "application/json" };

  // ── RESEND_API_KEY 必須 ──
  if (!env.RESEND_API_KEY) {
    console.error("RESEND_API_KEY is not configured");
    return new Response(
      JSON.stringify({ error: "現在メール送信機能を準備中です。時間をおいてもう一度お試しください。" }),
      { status: 503, headers }
    );
  }

  // ── JSONパース ──
  let data;
  try { data = await request.json(); }
  catch { return new Response(JSON.stringify({ error: "リクエストの形式が正しくありません" }), { status: 400, headers }); }

  // ── Turnstile検証（TURNSTILE_SECRET_KEY設定時は必須） ──
  if (env.TURNSTILE_SECRET_KEY) {
    const token = data.turnstileToken;
    if (!token) {
      return new Response(
        JSON.stringify({ error: "セキュリティ認証トークンがありません" }),
        { status: 403, headers }
      );
    }
    try {
      const tv = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token }),
      });
      const tvResult = await tv.json();
      if (!tvResult.success) {
        console.warn("Turnstile failed:", tvResult["error-codes"]);
        return new Response(
          JSON.stringify({ error: "セキュリティ認証に失敗しました。ページを再読み込みしてお試しください。" }),
          { status: 403, headers }
        );
      }
    } catch (e) {
      console.error("Turnstile verify error:", e);
      return new Response(
        JSON.stringify({ error: "セキュリティ認証の確認中にエラーが発生しました" }),
        { status: 500, headers }
      );
    }
  }

  // ── バリデーション ──
  const { customer, vehicle, menu, optionIds = [] } = data;
  if (!customer?.name?.trim() || !customer?.email?.trim() || !customer?.phone?.trim()) {
    return new Response(JSON.stringify({ error: "お名前・メールアドレス・電話番号は必須です" }), { status: 400, headers });
  }
  if (!vehicle?.maker || !vehicle?.size || !vehicle?.carAge) {
    return new Response(JSON.stringify({ error: "車両情報が不足しています" }), { status: 400, headers });
  }
  if (!MENU_PRICING[menu]) {
    return new Response(JSON.stringify({ error: "無効なコーティングメニューです" }), { status: 400, headers });
  }
  if (!["S","M","L","LL","3L"].includes(vehicle.size)) {
    return new Response(JSON.stringify({ error: "無効なサイズです" }), { status: 400, headers });
  }
  if (!["new","used"].includes(vehicle.carAge)) {
    return new Response(JSON.stringify({ error: "無効な車両状態です" }), { status: 400, headers });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) {
    return new Response(JSON.stringify({ error: "メールアドレスの形式が正しくありません" }), { status: 400, headers });
  }
  if (!/^[0-9\-+() ]{10,}$/.test(customer.phone)) {
    return new Response(JSON.stringify({ error: "電話番号の形式が正しくありません" }), { status: 400, headers });
  }

  // ── サーバー側で金額再計算 ──
  const validOptionIds = (optionIds || []).filter(id => OPTION_PRICING[id]);
  const { menuPrice, menuDuration, options, optionTotal, total } = calcTotal(
    menu, vehicle.carAge, vehicle.size, validOptionIds
  );

  // ── 見積番号生成（日本時間基準 / Intl.DateTimeFormat使用） ──
  const nowUtc = new Date();
  const jstParts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(nowUtc);
  const jstMap = Object.fromEntries(jstParts.map(p => [p.type, p.value]));
  const dateStr = `${jstMap.year}${jstMap.month}${jstMap.day}`;
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
  const id = `UC-${dateStr}-${rand}`;
  

  // ── メールHTML（KV保存前に生成） ──
  const carAgeLabel = vehicle.carAge === "new" ? "新車（登録1ヶ月以内）" : "経年車（登録1ヶ月以上）";
  const optionsList = options.length > 0 ? options.map(o => esc(o.label)).join("、") : "なし";
  const totalFmt = Number(total).toLocaleString("ja-JP");
  const FROM = env.FROM_EMAIL || "noreply@mail.un-cuore.com";
  const NOTIFY = env.NOTIFY_EMAIL || "uncuore02@gmail.com";

  const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:'Hiragino Sans','Noto Sans JP',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:40px 20px;"><tr><td>
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
<tr><td style="background:#0d1b2e;padding:28px 40px;text-align:center;">
  <p style="color:#3a7bd5;font-size:11px;letter-spacing:0.3em;margin:0 0 6px;">CAR COATING SPECIALIST — YOKOHAMA</p>
  <p style="color:#fff;font-size:22px;font-weight:700;margin:0;">Un cuore</p>
</td></tr>
<tr><td style="padding:36px 40px;">
  <p style="color:#1a2a3e;font-size:16px;font-weight:700;margin:0 0 6px;">${esc(customer.name)} 様</p>
  <p style="color:#555;font-size:14px;line-height:1.8;margin:0 0 24px;">この度はUncuore AI見積シミュレーションをご利用いただきありがとうございます。<br>AIが算出したお見積結果をお届けします。</p>
  <div style="background:#f0f4ff;border-left:4px solid #2556a8;padding:12px 16px;margin-bottom:24px;border-radius:0 4px 4px 0;">
    <p style="margin:0;font-size:11px;color:#2556a8;letter-spacing:0.1em;">見積番号</p>
    <p style="margin:4px 0 0;font-size:18px;font-weight:700;color:#0d1b2e;">${esc(id)}</p>
  </div>
  <p style="color:#0d1b2e;font-size:13px;font-weight:700;margin:0 0 8px;padding-bottom:4px;border-bottom:2px solid #e8eef4;">お車の情報</p>
  <table width="100%" style="margin-bottom:20px;">
    <tr><td style="padding:6px 0;font-size:13px;color:#777;width:120px;">メーカー</td><td style="padding:6px 0;font-size:13px;color:#1a2a3e;font-weight:500;">${esc(vehicle.maker)}</td></tr>
    <tr><td style="padding:6px 0;font-size:13px;color:#777;">車種</td><td style="padding:6px 0;font-size:13px;color:#1a2a3e;font-weight:500;">${esc(vehicle.model || "不明")}</td></tr>
    <tr><td style="padding:6px 0;font-size:13px;color:#777;">サイズ</td><td style="padding:6px 0;font-size:13px;color:#1a2a3e;font-weight:500;">${esc(vehicle.size)}</td></tr>
    <tr><td style="padding:6px 0;font-size:13px;color:#777;">車両状態</td><td style="padding:6px 0;font-size:13px;color:#1a2a3e;font-weight:500;">${carAgeLabel}</td></tr>
  </table>
  <p style="color:#0d1b2e;font-size:13px;font-weight:700;margin:0 0 8px;padding-bottom:4px;border-bottom:2px solid #e8eef4;">コーティングプラン</p>
  <table width="100%" style="margin-bottom:20px;">
    <tr><td style="padding:6px 0;font-size:13px;color:#777;width:120px;">メニュー</td><td style="padding:6px 0;font-size:13px;color:#1a2a3e;font-weight:500;">${esc(menu)}（耐久${esc(menuDuration)}）</td></tr>
    <tr><td style="padding:6px 0;font-size:13px;color:#777;">オプション</td><td style="padding:6px 0;font-size:13px;color:#1a2a3e;font-weight:500;">${optionsList}</td></tr>
  </table>
  <div style="background:#0d1b2e;border-radius:6px;padding:24px;text-align:center;margin-bottom:24px;">
    <p style="color:#3a7bd5;font-size:11px;letter-spacing:0.2em;margin:0 0 4px;">AI見積金額（税込）</p>
    <p style="color:#fff;font-size:36px;font-weight:700;margin:0 0 4px;">¥${totalFmt}</p>
    <p style="color:#a8b4c4;font-size:11px;margin:0;">※ 実際の料金は車両状態により変動する場合があります</p>
  </div>
  <p style="color:#555;font-size:14px;line-height:1.8;margin:0 0 20px;">ご質問・ご予約はお気軽にご相談ください。</p>
  <table width="100%" cellpadding="0" cellspacing="0"><tr>
    <td width="50%" style="padding-right:6px;"><a href="https://line.me/ti/p/@271goter" style="display:block;background:#06c755;color:#fff;text-align:center;padding:14px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:700;">💬 LINEで相談する</a></td>
    <td width="50%" style="padding-left:6px;"><a href="tel:0455488588" style="display:block;background:#1a2a3e;color:#fff;text-align:center;padding:14px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:700;">📞 045-548-8588</a></td>
  </tr></table>
</td></tr>
<tr><td style="background:#f0f4f8;padding:16px 40px;text-align:center;">
  <p style="color:#999;font-size:11px;margin:0;">横浜市都筑区のカーコーティング専門店 Uncuore<br><a href="https://ai.un-cuore.com/" style="color:#2556a8;">https://ai.un-cuore.com/</a></p>
</td></tr>
</table></td></tr></table></body></html>`;

  // ── お客様へメール送信（KV保存前に実行） ──
  let customerEmailOk = false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `Uncuore AI見積 <${FROM}>`,
        to: [customer.email.trim()],
        subject: `【Uncuore AI見積】${id} ${vehicle.maker} ${vehicle.model || ""}`,
        html,
      }),
    });
    if (r.ok) {
      customerEmailOk = true;
    } else {
      const errBody = await r.text();
      console.error(`Customer email failed: status=${r.status} body=${errBody}`);
    }
  } catch (err) {
    console.error("Customer email exception:", err.message);
  }

  // ── KVへ1回だけ保存（emailStatusをsent/failedで確定） ──
  const ttl = { expirationTtl: 60 * 60 * 24 * 365 * 2 };
  const emailStatus = customerEmailOk ? "sent" : "failed";
  const quote = {
    id, date: nowUtc.toISOString(),
    customer: {
      name: customer.name.trim(), email: customer.email.trim(),
      phone: customer.phone.trim(), pref: customer.pref || "",
    },
    vehicle: {
      maker: vehicle.maker, model: vehicle.model || "不明",
      size: vehicle.size, carAge: vehicle.carAge,
    },
    menu, menuDuration, options, menuPrice, optionTotal, total,
    status: "未対応", memo: "",
    emailStatus,
  };

  // ── KV保存（キー別に状態管理・成功済みキーは再putしない） ──
  // メール送信済みのため、KV失敗でも500は返さず warning で処理する
  let quoteSaved = false;
  let indexSaved = false;
  const kvQuoteKey  = `quote:${id}`;
  const kvIdxKey    = `idx:${nowUtc.toISOString()}_${id}`;
  const kvIdxValue  = JSON.stringify({ id, date: quote.date, name: customer.name.trim(), maker: vehicle.maker, model: vehicle.model || "不明", menu, total, status: "未対応", emailStatus });
  const kvQuoteValue = JSON.stringify(quote);

  for (let attempt = 1; attempt <= 3; attempt++) {
    // ① quote未保存の場合のみ保存
    if (!quoteSaved) {
      try {
        await env.UNCUORE_KV.put(kvQuoteKey, kvQuoteValue, ttl);
        quoteSaved = true;
      } catch (err) {
        console.error(`KV quote save error (attempt ${attempt}/3) [${id}]:`, err.message ?? err);
      }
    }
    // ② quote保存済みの場合のみ index を保存（孤立インデックス防止）
    if (quoteSaved && !indexSaved) {
      try {
        await env.UNCUORE_KV.put(kvIdxKey, kvIdxValue, ttl);
        indexSaved = true;
      } catch (err) {
        console.error(`KV index save error (attempt ${attempt}/3) [${id}]:`, err.message ?? err);
      }
    }
    // 両方成功したら終了
    if (quoteSaved && indexSaved) break;
    // 次リトライまで1100ms待機（KV書き込み間隔を確保）
    if (attempt < 3) await new Promise(r => setTimeout(r, 1100));
  }

  const kvSaved = quoteSaved && indexSaved;

  // メール失敗 → エラーを返す（KV保存の有無に関わらず）
  if (!customerEmailOk) {
    return new Response(
      JSON.stringify({ error: "メールの送信に失敗しました。もう一度お試しください。" }),
      { status: 500, headers }
    );
  }

  // メール成功・KV失敗 → 通知メールに警告を追加してフロントには warning を返す
  if (!kvSaved) {
    const kvFailText = `⚠️ KV保存失敗・管理画面未登録
見積番号: ${id}
お名前: ${customer.name.trim()}
メール: ${customer.email.trim()}
電話: ${customer.phone.trim()}
メーカー: ${vehicle.maker} / 車種: ${vehicle.model || "不明"} / サイズ: ${vehicle.size}
メニュー: ${menu} / 合計: ¥${Number(total).toLocaleString("ja-JP")}
※ 管理画面に自動登録されていません。手動で確認してください。`;
    console.error(`KV SAVE FAILED after 3 retries [${id}]:`, kvFailText);
    context.waitUntil(
      (async () => {
        try {
          const nr = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: `Uncuore システム <${FROM}>`,
              to: [NOTIFY],
              subject: `[⚠️KV保存失敗] ${id} ${customer.name.trim()} 要手動対応`,
              text: kvFailText,
            }),
          });
          if (!nr.ok) {
            const errBody = await nr.text();
            console.error(`KV-fail notify email failed: status=${nr.status} body=${errBody}`);
          }
        } catch (e) {
          console.error("KV-fail notify email exception:", e.message);
        }
      })()
    );
    return new Response(JSON.stringify({ ok: true, id, warning: "storage_failed" }), { status: 200, headers });
  }

  // ── Uncuore通知メール（waitUntilでバックグラウンド・ログ付き） ──
  const notifyText = `[新規AI見積リード] ${id}
お名前: ${customer.name.trim()} / メール: ${customer.email.trim()} / 電話: ${customer.phone.trim()}
送信日時: ${nowUtc.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}
メーカー: ${vehicle.maker} / 車種: ${vehicle.model || "不明"} / サイズ: ${vehicle.size} / 状態: ${carAgeLabel}
メニュー: ${menu}（耐久${menuDuration}）/ オプション: ${options.map(o => o.label).join("、") || "なし"}
AI見積金額: ¥${totalFmt}
管理画面: https://ai.un-cuore.com/#admin`;

  context.waitUntil(
    (async () => {
      try {
        const nr = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: `Uncuore システム <${FROM}>`, to: [NOTIFY], subject: `[新規リード] ${id} ${customer.name.trim()}`, text: notifyText }),
        });
        if (!nr.ok) {
          const errBody = await nr.text();
          console.error(`Notify email failed: status=${nr.status} body=${errBody}`);
        }
      } catch (e) {
        console.error("Notify email exception:", e.message);
      }
    })()
  );

  return new Response(JSON.stringify({ ok: true, id }), { status: 200, headers });
}
