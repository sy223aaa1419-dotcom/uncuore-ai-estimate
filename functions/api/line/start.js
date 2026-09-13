const ORIGIN="https://ai.un-cuore.com";
function kvOf(env){return env.UNCUORE_KV||env.UC_KV||null;}
function html(body,status=200){return new Response(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Un cuore AI見積</title><body style="margin:0;background:#07101f;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Noto Sans JP',sans-serif"><main style="max-width:620px;margin:70px auto;padding:24px;text-align:center">${body}</main></body></html>`,{status,headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"}})}
async function metric(kv,name){try{const k=`metric:${name}`;const n=Number(await kv.get(k)||0);await kv.put(k,String(n+1));}catch(_){}}

export async function onRequestGet({request,env}){
  const kv=kvOf(env); if(!kv) return html("<h2>システム設定を確認中です</h2>",503);
  if(!env.LINE_LOGIN_CHANNEL_ID||!env.LINE_LOGIN_CHANNEL_SECRET) return html("<h2>LINE連携設定が未完了です</h2>",503);
  const u=new URL(request.url); const estimate=(u.searchParams.get("estimate")||"").trim();
  if(!/^UC-\d{8}-[A-Z0-9]{6}$/.test(estimate)) return html("<h2>見積番号を確認できませんでした</h2>",400);
  const quote=await kv.get(`quote:${estimate}`); if(!quote) return html("<h2>見積データが見つかりませんでした</h2>",404);
  const state=crypto.randomUUID().replace(/-/g,"");
  await kv.put(`lineoauth:${state}`,JSON.stringify({estimate,createdAt:new Date().toISOString()}),{expirationTtl:600});
  await metric(kv,"line_login_start");
  const q=new URLSearchParams({response_type:"code",client_id:env.LINE_LOGIN_CHANNEL_ID,redirect_uri:`${ORIGIN}/api/line/callback`,state,scope:"profile openid",bot_prompt:"aggressive"});
  return Response.redirect(`https://access.line.me/oauth2/v2.1/authorize?${q.toString()}`,302);
}
export async function onRequest(c){if(c.request.method==="GET")return onRequestGet(c);return new Response("Method Not Allowed",{status:405});}
