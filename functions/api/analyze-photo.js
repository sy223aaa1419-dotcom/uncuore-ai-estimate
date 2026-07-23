/**
 * POST /api/analyze-photo
 * 写真からAI車種判定（Anthropic API proxy）
 *
 * Secret: ANTHROPIC_API_KEY
 * ファイルサイズ上限: 4MB（base64後 約5.3MB）
 */

const CORS = {
  "Access-Control-Allow-Origin": "https://ai.un-cuore.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_BASE64_SIZE = 5_500_000; // 約4MBの画像に相当

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

export async function onRequestPost({ request, env }) {
  const headers = { ...CORS, "Content-Type": "application/json" };

  if (!env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: "AI判定機能は現在利用できません" }), { status: 503, headers });
  }

  let body;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: "リクエストの形式が正しくありません" }), { status: 400, headers }); }

  const { base64Data, mediaType } = body;

  if (!base64Data) {
    return new Response(JSON.stringify({ error: "画像データが必要です" }), { status: 400, headers });
  }

  // MIMEタイプ検証
  const mime = mediaType || "image/jpeg";
  if (!ALLOWED_MIME.includes(mime)) {
    return new Response(JSON.stringify({ error: "JPEG、PNG、WebP形式の画像のみ対応しています" }), { status: 400, headers });
  }

  // ファイルサイズ制限（base64文字数で判定）
  if (base64Data.length > MAX_BASE64_SIZE) {
    return new Response(JSON.stringify({ error: "画像サイズが大きすぎます（4MB以下にしてください）" }), { status: 400, headers });
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 300,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mime, data: base64Data } },
            { type: "text", text: 'Identify the car maker and model in this image. Respond ONLY in JSON: {"maker":"Japanese maker name","model":"Japanese model name"}. If unidentifiable: {"maker":null,"model":null}' }
          ]
        }]
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("Anthropic API error:", res.status, errText);
      return new Response(JSON.stringify({ error: "AI判定に失敗しました" }), { status: 500, headers });
    }

    const apiData = await res.json();
    const text = apiData.content?.[0]?.text?.trim() || "";
    const clean = text.replace(/```json|```/g, "").trim();
    const result = JSON.parse(clean);
    return new Response(JSON.stringify(result), { status: 200, headers });
  } catch (err) {
    console.error("analyze-photo error:", err);
    return new Response(JSON.stringify({ error: "AI判定中にエラーが発生しました" }), { status: 500, headers });
  }
}
