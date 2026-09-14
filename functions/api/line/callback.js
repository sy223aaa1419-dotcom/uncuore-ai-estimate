const ORIGIN="https://ai.un-cuore.com";
function kvOf(env){return env.UNCUORE_KV||env.UC_KV||null;}
function html(body,status=200){return new Response(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Un cuore AI見積</title><body style="margin:0;background:#07101f;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Noto Sans JP',sans-serif"><main style="max-width:620px;margin:70px auto;padding:24px;text-align:center">${body}</main></body></html>`,{status,headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"}})}
async function metric(kv,name){try{const k=`metric:${name}`;const n=Number(await kv.get(k)||0);await kv.put(k,String(n+1));}catch(_){}}

function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
async function push(token,userId,message){return fetch("https://api.line.me/v2/bot/message/push",{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({to:userId,messages:[message]})});}
function flex(q){
 const v=q.vehicle||{}, offer=q.lineOffer||{}; const price=Number(offer.price||q.total||0).toLocaleString("ja-JP");
 const opts=(q.options||[]).map(x=>x.label||x.name).filter(Boolean); if(offer.windowCoat>0&&!opts.some(x=>String(x).includes("ウィンド")))opts.push("ウィンドウコート付");
 const row=(k,v)=>({type:"box",layout:"baseline",spacing:"sm",contents:[{type:"text",text:k,color:"#8FA6C8",size:"xs",flex:3},{type:"text",text:String(v||"—"),color:"#FFFFFF",size:"sm",wrap:true,flex:7}]});
 return {type:"flex",altText:`Un cuore AI見積結果 ${q.id}`,contents:{type:"bubble",styles:{body:{backgroundColor:"#07101F"},footer:{backgroundColor:"#07101F"}},body:{type:"box",layout:"vertical",spacing:"md",contents:[
  {type:"text",text:"UNCUORE AI ESTIMATE",color:"#4DA3FF",size:"xs",weight:"bold"},{type:"text",text:"AI見積結果",color:"#FFFFFF",size:"xl",weight:"bold"},
  row("見積番号",q.id),row("車種",`${v.maker||""} ${v.model||""}`.trim()),row("サイズ",v.size),row("車両状態",v.carAge==="new"?"新車":"経年車"),
  {type:"separator",color:"#263A59"},{type:"text",text:offer.menu||q.menu||"Original CERAMIC",color:"#FFFFFF",size:"lg",weight:"bold",wrap:true},
  {type:"text",text:offer.benefit||"",color:"#34E58A",size:"sm",weight:"bold",wrap:true},row("オプション",opts.join("・")||"なし"),
  {type:"text",text:`¥${price}`,color:"#34E58A",size:"xxl",weight:"bold",align:"end"},{type:"text",text:"税別・概算",color:"#8FA6C8",size:"xxs",align:"end"}
 ]},footer:{type:"box",layout:"vertical",spacing:"sm",contents:[
  {type:"button",style:"primary",color:"#06C755",action:{type:"message",label:"LINEで相談する",text:`${q.id} この見積について相談したいです`}},
  {type:"button",style:"secondary",action:{type:"message",label:"予約について相談する",text:`${q.id} 予約について相談したいです`}}
 ]}}};
}
function decodeIdTokenUserId(idToken){
 try{
  if(!idToken)return "";
  const p=idToken.split(".")[1];
  if(!p)return "";
  const b64=p.replace(/-/g,"+").replace(/_/g,"/");
  const padded=b64+"=".repeat((4-b64.length%4)%4);
  return JSON.parse(atob(padded)).sub||"";
 }catch(_){return "";}
}

async function completeLineDelivery(env,kv,sess,code){
 try{
  const form=new URLSearchParams({
   grant_type:"authorization_code",
   code,
   redirect_uri:`${ORIGIN}/api/line/callback`,
   client_id:env.LINE_LOGIN_CHANNEL_ID,
   client_secret:env.LINE_LOGIN_CHANNEL_SECRET
  });

  const tr=await fetch("https://api.line.me/oauth2/v2.1/token",{
   method:"POST",
   headers:{"Content-Type":"application/x-www-form-urlencoded"},
   body:form
  });
  if(!tr.ok){
   console.error("LINE token exchange failed",tr.status,await tr.text());
   await metric(kv,"line_auth_failed");
   return;
  }

  const tok=await tr.json();

  // openid scope の id_token から userId を取得し、
  // 通常は /v2/profile への追加通信を省略する。
  let userId=decodeIdTokenUserId(tok.id_token);
  if(!userId && tok.access_token){
   const pr=await fetch("https://api.line.me/v2/profile",{
    headers:{Authorization:`Bearer ${tok.access_token}`}
   });
   if(pr.ok){
    const profile=await pr.json();
    userId=profile.userId||"";
   }
  }
  if(!userId){
   console.error("LINE user id not found");
   await metric(kv,"line_profile_failed");
   return;
  }

  const qraw=await kv.get(`quote:${sess.estimate}`);
  if(!qraw){
   console.error("Quote not found",sess.estimate);
   await metric(kv,"line_quote_missing");
   return;
  }

  const q=JSON.parse(qraw);
  q.lineLinked=true;
  q.lineUserId=userId;
  q.lineLinkedAt=new Date().toISOString();

  // 保存系はまとめて並列実行
  const saveTasks=[
   kv.put(`quote:${q.id}`,JSON.stringify(q)),
   kv.put(`lineuser:${userId}:${q.id}`,"1"),
   metric(kv,"line_linked")
  ];

  const eraw=await kv.get(`est:${q.id}`);
  if(eraw){
   try{
    const e=JSON.parse(eraw);
    e.lineLinked=true;
    e.lineUserId=userId;
    e.lineLinkedAt=q.lineLinkedAt;
    saveTasks.push(kv.put(`est:${q.id}`,JSON.stringify(e)));
   }catch(_){}
  }
  await Promise.all(saveTasks);

  if(!env.LINE_CHANNEL_ACCESS_TOKEN){
   console.error("LINE_CHANNEL_ACCESS_TOKEN is missing");
   await metric(kv,"line_send_failed");
   return;
  }

  const sr=await push(env.LINE_CHANNEL_ACCESS_TOKEN,userId,flex(q));
  if(sr.ok){
   q.lineSent=true;
   q.lineSentAt=new Date().toISOString();
   await Promise.all([
    kv.put(`quote:${q.id}`,JSON.stringify(q)),
    metric(kv,"line_send_success")
   ]);
   return;
  }

  console.error("LINE push failed",sr.status,await sr.text());
  await metric(kv,"line_send_failed");
 }catch(e){
  console.error("LINE callback background error",e?.stack||e);
  try{await metric(kv,"line_callback_error");}catch(_){}
 }
}

export async function onRequestGet(context){
 const {request,env}=context;
 const kv=kvOf(env);
 if(!kv)return html("<h2>システム設定を確認中です</h2>",503);

 const u=new URL(request.url);
 const code=u.searchParams.get("code");
 const state=u.searchParams.get("state");
 const err=u.searchParams.get("error");

 if(err)return html(`<h2>LINE連携がキャンセルされました</h2><p>${esc(err)}</p><p><a style="color:#55aaff" href="/">AI見積へ戻る</a></p>`,400);
 if(!code||!state)return html("<h2>LINE認証情報を確認できませんでした</h2>",400);

 const raw=await kv.get(`lineoauth:${state}`);
 if(!raw)return html("<h2>認証の有効期限が切れました</h2><p>AI見積画面からもう一度お試しください。</p>",400);

 const sess=JSON.parse(raw);

 // state は先に無効化して二重実行を防止。
 await kv.delete(`lineoauth:${state}`);

 // 重い処理（LINEトークン交換・KV更新・見積結果Push）は
 // レスポンス後も Cloudflare 上で継続させる。
 context.waitUntil(completeLineDelivery(env,kv,sess,code));

 // ユーザーは待たせず、そのまま公式LINEトークへ。
 return Response.redirect("https://line.me/R/oaMessage/%40271goter",302);
}
export async function onRequest(c){if(c.request.method==="GET")return onRequestGet(c);return new Response("Method Not Allowed",{status:405});}
