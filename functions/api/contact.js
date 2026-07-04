/**
 * Cloudflare Pages Function: /api/contact
 * 問い合わせフォームの内容を Resend 経由でメール送信する。
 *
 * 必要な環境変数（Cloudflare ダッシュボードで設定）:
 *   RESEND_API_KEY (Secret) … https://resend.com で発行（uncuore02@gmail.com で登録すること）
 *   CONTACT_TO     (任意)   … 宛先。未設定なら uncuore02@gmail.com
 *   CONTACT_FROM   (任意)   … 差出人。独自ドメインをResendで検証したら設定。未設定なら onboarding@resend.dev
 */

const DEFAULT_TO = "uncuore02@gmail.com";
const DEFAULT_FROM = "UNCUORE AI見積 <onboarding@resend.dev>";

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.RESEND_API_KEY) {
    return json({ message: "サーバー設定エラー（メールAPIキー未設定）" }, 500);
  }

  let body;
  try { body = await request.json(); }
  catch (_) { return json({ message: "不正なリクエストです" }, 400); }

  // ハニーポット（画面には表示されない欄。botが埋めたら静かに成功を装って破棄）
  if (body.website) return json({ ok: true }, 200);

  const name = str(body.name, 100);
  const tel = str(body.tel, 40);
  const mail = str(body.mail, 200);
  const msg = str(body.msg, 4000);
  const estimateNo = str(body.estimateNo, 40);

  if (!name || !tel || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
    return json({ message: "入力内容に不備があります" }, 400);
  }

  const subject = `【AI見積】お問い合わせ｜${name}様${estimateNo ? `（${estimateNo}）` : ""}`;
  const text =
`UNCUORE AI見積LPからお問い合わせがありました。

■お名前：${name}
■電話番号：${tel}
■メール：${mail}
${estimateNo ? `■見積番号：${estimateNo}\n` : ""}■送信日時：${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}

――― お問い合わせ内容 ―――
${msg || "（本文なし）"}

※このメールに返信すると、お客様（${mail}）宛に届きます。`;

  let res;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: env.CONTACT_FROM || DEFAULT_FROM,
        to: [env.CONTACT_TO || DEFAULT_TO],
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

  return json({ ok: true }, 200);
}

export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ message: "Method Not Allowed" }, 405);
}

function str(v, max) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
