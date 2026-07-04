/**
 * Cloudflare Pages Function: /api/estimate
 * 車両写真を受け取り、Anthropic API (Claude) で車種・サイズを判定する中継サーバー。
 *
 * - APIキーは環境変数 ANTHROPIC_API_KEY に設定（Cloudflare ダッシュボードで Secret として登録）
 * - プロンプトはサーバー側で固定 → エンドポイントを悪用した自由なAI利用を防止
 * - 受け付けるのは JPEG 画像の base64 のみ（約6MBまで）
 */

const PROMPT = `この写真に写っている自動車を判定してください。
以下のJSON形式のみで回答してください。前置き・説明・コードブロック記号は一切不要です。
{"maker":"メーカー名（例:トヨタ/日産/ホンダ/レクサス/BMW等）","model":"車種名（グレードや型式は含めず、車種名のみ。例:ヴォクシー、プリウス、N-BOX）","size":"S/M/L/LL/3Lのいずれか","confidence":"high/medium/low"}
サイズ区分の基準（この店舗独自の区分。一般的な車格とは異なるので厳守）:
S=軽自動車・コンパクトカー（ヤリス/アクア/N-BOX/デミオ/スイフト等）
M=小型セダン・コンパクトSUV・スポーツクーペ（カローラ/フィット/C-HR/ライズ/86/インプレッサ等）
L=セダン・ワゴン・ミドルSUV（プリウス/クラウン/カムリ/シビック/ヴェゼル/レヴォーグ/シエンタ/フリード等）
LL=ミニバン・大型SUV（ヴォクシー/ノア/セレナ/ステップワゴン/アルファード/ヴェルファイア/ハリアー/RAV4/CX-5/フォレスター/エクストレイル等）
3L=超大型車・大型バン（ハイエース/ランドクルーザー/キャラバンスーパーロング/大型アメ車等）
車が写っていない、または判定できない場合は {"error":"理由"} を返してください。`;

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // base64文字列として約8MB（元画像約6MB相当）

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.ANTHROPIC_API_KEY) {
    return json({ message: "サーバー設定エラー（APIキー未設定）" }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ message: "不正なリクエストです" }, 400);
  }

  const image = body && body.image;
  if (typeof image !== "string" || image.length < 100) {
    return json({ message: "画像データがありません" }, 400);
  }
  if (image.length > MAX_IMAGE_BYTES) {
    return json({ message: "画像サイズが大きすぎます" }, 413);
  }
  // base64 として妥当かの簡易チェック
  if (!/^[A-Za-z0-9+/=\s]+$/.test(image.slice(0, 1000))) {
    return json({ message: "画像データの形式が不正です" }, 400);
  }

  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
              { type: "text", text: PROMPT },
            ],
          },
        ],
      }),
    });
  } catch (e) {
    return json({ message: "AIサーバーへの接続に失敗しました" }, 502);
  }

  if (!upstream.ok) {
    let detail = "";
    try {
      const err = await upstream.json();
      detail = err && err.error && err.error.message ? err.error.message : "";
    } catch (_) {}
    const status = upstream.status === 429 ? 429 : 502;
    return json({ message: detail || `上流APIエラー（${upstream.status}）` }, status);
  }

  const data = await upstream.json();
  // クライアントには必要な content のみ返す（usage等の内部情報は返さない）
  return json({ content: data.content || [] }, 200);
}

// POST 以外は拒否
export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ message: "Method Not Allowed" }, 405);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
