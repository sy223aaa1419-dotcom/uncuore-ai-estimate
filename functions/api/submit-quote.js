/**
 * POST /api/submit-quote
 * 既存の静的LP（index.html）専用：
 * - 通常版のAI見積完成後にお客様情報を受け取る
 * - KVの管理画面用 est: レコードへ保存
 * - お客様へ見積メールを自動送信
 *
 * KV: UNCUORE_KV（旧 UC_KV も後方互換）
 * Secrets: RESEND_API_KEY, FROM_EMAIL, NOTIFY_EMAIL, TURNSTILE_SECRET_KEY
 */

const SIZES = ["S","M","L","LL","3L"];
const DEFAULT_MENUS = [
  {id:"russo", name:"Cuore russo coat", years:5, priceNew:[190000,211000,234000,259000,288000], priceUsed:[201000,222000,244000,270000,299000]},
  {id:"ultra", name:"CERAMIC ULTRA + Original CERAMIC", years:5, priceNew:[188000,209000,231000,257000,286000], priceUsed:[200000,221000,242000,268000,297000]},
  {id:"hybrid", name:"HYBRID CERAMIC", years:3, priceNew:[148000,169000,191000,217000,246000], priceUsed:[160000,182000,202000,228000,257000]},
  {id:"cuore", name:"Cuore coat", years:3, priceNew:[140000,155000,170000,188000,208000], priceUsed:[151000,166000,181000,199000,219000]},
  {id:"original", name:"Original CERAMIC", years:1, priceNew:[105000,117000,129000,139000,151000], priceUsed:[112000,124000,135000,147000,159000]},
  {id:"veloce", name:"Veloce Coating", years:1, priceNew:[54000,62000,69000,78000,86000], priceUsed:[58000,66000,73000,82000,92000]},
];
const DEFAULT_OPTIONS = [
  {id:"win_all",name:"ウインドコート全面",sm:22000,l:26000},
  {id:"win_fr",name:"ウインドコートフロント",sm:13000,l:17000},
  {id:"resin",name:"樹脂パーツコーティング",sm:17000,l:24000},
  {id:"wheel",name:"ホイールコート",sm:20000,l:25000},
  {id:"room",name:"ルームクリーニング",sm:36000,l:42000},
  {id:"interior",name:"インテリアコーティング",sm:38000,l:44000},
  {id:"head",name:"ヘッドライトコーティング",sm:36000,l:38000},
  {id:"mekki",name:"メッキモールクリーニング",sm:34000,l:41000},
  {id:"detail",name:"細部コーティング",sm:22000,l:26000},
  {id:"deodor",name:"脱臭",sm:8000,l:11000},
  {id:"photocat",name:"無光触媒コーティング",sm:40000,l:48000},
];
const DEFAULT_LP_MENUS = [
  {id:"russo",selected:true,recommend:true,no1:true,ai:true,highlight:true,inquiry:true},
  {id:"veloce",selected:false,recommend:false,no1:false,ai:false,highlight:false,inquiry:true},
];

function json(obj,status=200){
  return new Response(JSON.stringify(obj),{
    status,
    headers:{
      "Content-Type":"application/json; charset=utf-8",
      "Cache-Control":"no-store",
      "X-Content-Type-Options":"nosniff",
      "X-Frame-Options":"DENY",
      "Referrer-Policy":"strict-origin-when-cross-origin",
    }
  });
}
function kvOf(env){ return env.UNCUORE_KV || env.UC_KV || null; }
function esc(v){
  return String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
function str(v,max){ return typeof v==="string" ? v.trim().slice(0,max) : ""; }
function sameOrigin(request){
  const origin=request.headers.get("Origin");
  if(!origin) return true;
  try{return new URL(origin).host===new URL(request.url).host;}catch(_){return false;}
}
async function verifyTurnstile(secret,token,ip){
  if(!secret) return true;
  if(!token) return false;
  try{
    const form=new FormData();
    form.append("secret",secret);
    form.append("response",token);
    if(ip) form.append("remoteip",ip);
    const r=await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify",{method:"POST",body:form});
    const d=await r.json();
    return !!d.success;
  }catch(_){return false;}
}
async function rateLimit(kv,key,max,ttl){
  try{
    const n=Number(await kv.get(key)||0);
    if(n>=max) return true;
    await kv.put(key,String(n+1),{expirationTtl:ttl});
  }catch(_){}
  return false;
}
function optionPrice(o,size){ return (size==="S"||size==="M") ? Number(o.sm||0) : Number(o.l||0); }
function menuBase(m,condition,size){
  const i=SIZES.indexOf(size);
  if(i<0) return 0;
  const arr=condition==="new" ? m.priceNew : m.priceUsed;
  return Number(Array.isArray(arr) ? arr[i]||0 : 0);
}
const DEFAULT_MENU_DESCRIPTIONS = {
  "russo":    { feature: "どのコーティングをも超える超スペックコーティングシステムです。深みのある艶と高い保護性能を備えたハイグレードなコーティングで、愛車の美しさを長期間にわたって維持します。", recommend: "最高峰のコーティングで愛車を長期間守りたい方、艶と保護性能の両方を妥協したくない方" },
  "ultra":    { feature: "最高峰の光沢と耐久性を誇る疎水性ハイスペックコーティングです。セラミックウルトラとオリジナルセラミックを組み合わせた二層構造で、美観と保護力を高いレベルで実現します。", recommend: "光沢と耐久性を高いレベルで両立させたい方、長期間メンテナンスの手間を減らしたい方" },
  "hybrid":   { feature: "プロテクションフィルム、ラッピング、マット塗装など特殊な塗装面にも対応した次世代コーティングシステムです。幅広い車両に対応し、塗装面をしっかり保護します。", recommend: "プロテクションフィルムやラッピング車、マット塗装の愛車をお持ちの方" },
  "cuore":    { feature: "他社では味わえないUncuoreオリジナルのハイクオリティーコーティングシステムです。優れた光沢と防汚性能を発揮し、愛車を美しく保ちます。", recommend: "品質にこだわりながらコストパフォーマンスも重視したい方" },
  "original": { feature: "信頼のオリジナルセラミックコーティングです。ガラス系の硬い皮膜が塗装面を保護し、美しい艶を長期間維持します。", recommend: "セラミックコーティングをリーズナブルに体験したい方、定期的にメンテナンスを行いたい方" },
  "veloce":   { feature: "手軽にカーコーティングを施工したい方におすすめのエントリープランです。コーティングの基本的な保護効果と艶を手頃な価格でご提供します。", recommend: "初めてコーティングを試したい方、まずはリーズナブルにコーティング効果を体験したい方" },
};

const DEFAULT_EMAIL_TEMPLATE = {
  subject: "【Uncuore AI見積】{見積番号} {メーカー} {車種}",
  opening: "AI見積シミュレーションをご利用いただきありがとうございます。\nお車に合わせた概算見積をお送りします。",
  heading: "AI見積結果",
  labelRecommend: "AIおすすめプラン",
  labelCompare: "比較プラン",
  labelFeat: "このプランの特徴",
  labelRec: "こんな方におすすめ",
  labelYears: "耐久年数",
  labelPrice: "税別・概算",
  note: "※ 各金額は施工メニューと選択オプションを含む税別の概算です。\n車両状態により実際の金額が変わる場合があります。\n正式なお見積は現車確認のうえご提示いたします。",
  lineText: "LINEで相談",
  telText: "045-548-8588",
  footer: "横浜市都筑区のカーコーティング専門店 Uncuore",
};

async function loadPricing(kv){
  let saved=null;
  try{
    const raw=await kv.get("settings");
    if(raw) saved=JSON.parse(raw);
  }catch(_){}
  const menus=Array.isArray(saved?.menus)&&saved.menus.length ? saved.menus : DEFAULT_MENUS;
  const options=Array.isArray(saved?.options)&&saved.options.length ? saved.options : DEFAULT_OPTIONS;
  const lpMenus=Array.isArray(saved?.lpMenus)&&saved.lpMenus.length ? saved.lpMenus : DEFAULT_LP_MENUS;
  const savedDesc = saved?.menuDescriptions;
  const menuDescriptions = (savedDesc && typeof savedDesc === "object") ? savedDesc : DEFAULT_MENU_DESCRIPTIONS;
  const savedEmailTemplate = (saved?.emailTemplate && typeof saved.emailTemplate === "object" && !Array.isArray(saved.emailTemplate)) ? saved.emailTemplate : {};
  const emailTemplate = Object.assign({}, DEFAULT_EMAIL_TEMPLATE, savedEmailTemplate);
  return {menus,options,lpMenus,menuDescriptions,emailTemplate};
}
function computeResults(cfg,condition,size,optionIds){
  const selectedOptions=(Array.isArray(optionIds)?optionIds:[])
    .map(id=>cfg.options.find(o=>o.id===id))
    .filter(Boolean);
  const optionTotal=selectedOptions.reduce((s,o)=>s+optionPrice(o,size),0);
  let visible=cfg.lpMenus
    .map(c=>({conf:c,m:cfg.menus.find(x=>x.id===c.id)}))
    .filter(x=>x.m);
  if(!visible.length) visible=cfg.menus.slice(0,2).map(m=>({conf:{id:m.id,inquiry:true},m}));
  const results=visible.map(({conf,m})=>({
    id:m.id,
    name:m.name,
    years:Number(m.years||0),
    total:menuBase(m,condition,size)+optionTotal,
    recommend:!!conf.recommend,
    no1:!!conf.no1,
    ai:!!conf.ai,
    highlight:!!conf.highlight,
  }));
  return {
    selectedOptions:selectedOptions.map(o=>({id:o.id,name:o.name,price:optionPrice(o,size)})),
    optionTotal,
    results
  };
}
function makeId(){
  const parts=new Intl.DateTimeFormat("ja-JP",{timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());
  const m=Object.fromEntries(parts.map(p=>[p.type,p.value]));
  const rand=crypto.randomUUID().replace(/-/g,"").slice(0,6).toUpperCase();
  return `UC-${m.year}${m.month}${m.day}-${rand}`;
}
async function saveRecord(kv,key,value){
  for(let i=1;i<=3;i++){
    try{
      await kv.put(key,value);
      return true;
    }catch(e){
      console.error(`[submit-quote] KV save ${i}/3 failed`,e?.message||e);
      if(i<3) await new Promise(r=>setTimeout(r,1100));
    }
  }
  return false;
}

export async function onRequestOptions(){
  return new Response(null,{status:204,headers:{
    "Access-Control-Allow-Origin":"https://ai.un-cuore.com",
    "Access-Control-Allow-Methods":"POST, OPTIONS",
    "Access-Control-Allow-Headers":"Content-Type",
  }});
}

export async function onRequestPost(context){
  const {request,env}=context;
  const kv=kvOf(env);
  if(!sameOrigin(request)) return json({error:"不正なリクエストです"},403);
  if(!kv) return json({error:"現在見積機能の設定を確認中です。時間をおいてもう一度お試しください。"},503);
  if(!env.RESEND_API_KEY) return json({error:"現在メール送信機能を準備中です。時間をおいてもう一度お試しください。"},503);

  const ip=(request.headers.get("CF-Connecting-IP")||"unknown").slice(0,80);
  if(await rateLimit(kv,`rl:submit-quote:${ip}`,8,600)){
    return json({error:"短時間に送信回数が多すぎます。少し時間をおいてお試しください。"},429);
  }

  let body;
  try{body=await request.json();}catch(_){return json({error:"リクエストの形式が正しくありません"},400);}

  if(env.TURNSTILE_SECRET_KEY){
    const ok=await verifyTurnstile(env.TURNSTILE_SECRET_KEY,str(body.turnstileToken,4096),ip);
    if(!ok) return json({error:"セキュリティ確認に失敗しました。もう一度お試しください。"},403);
  }

  const name=str(body.customer?.name,80);
  const email=str(body.customer?.email,160).toLowerCase();
  const phone=str(body.customer?.phone,30);
  const pref=str(body.customer?.pref,20);
  const maker=str(body.vehicle?.maker,60);
  const model=str(body.vehicle?.model,100);
  const size=str(body.vehicle?.size,4);
  const carAge=str(body.vehicle?.carAge,10);

  if(!name || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) || !/^[0-9+\-()\s]{8,30}$/.test(phone)){
    return json({error:"お名前・メールアドレス・電話番号をご確認ください。"},400);
  }
  if(!maker || !SIZES.includes(size) || !["new","used"].includes(carAge)){
    return json({error:"車両情報が不足しています。最初からやり直してください。"},400);
  }

  const cfg=await loadPricing(kv);
  const calc=computeResults(cfg,carAge,size,body.optionIds);
  if(!calc.results.length) return json({error:"見積メニューを取得できませんでした。"},500);

  const id=makeId();
  const now=new Date();
  const conditionLabel=carAge==="new"?"新車":"経年車";
  const fullCondition=carAge==="new"?"新車（登録1か月以内）":"経年車（登録1か月以上）";
  const FROM=env.FROM_EMAIL||"noreply@mail.un-cuore.com";
  const NOTIFY=env.NOTIFY_EMAIL||"uncuore02@gmail.com";
  const optText=calc.selectedOptions.length ? calc.selectedOptions.map(o=>`${esc(o.name)}（+¥${o.price.toLocaleString("ja-JP")}）`).join("<br>") : "なし";

  const escNl = v => esc(v).replace(/\n/g,"<br>");
  const T = cfg.emailTemplate || {};
  const labelRecommend = T.labelRecommend || DEFAULT_EMAIL_TEMPLATE.labelRecommend;
  const labelCompare   = T.labelCompare   || DEFAULT_EMAIL_TEMPLATE.labelCompare;
  const labelFeat      = T.labelFeat      || DEFAULT_EMAIL_TEMPLATE.labelFeat;
  const labelRec       = T.labelRec       || DEFAULT_EMAIL_TEMPLATE.labelRec;
  const labelYears     = T.labelYears     || DEFAULT_EMAIL_TEMPLATE.labelYears;
  const labelPrice     = T.labelPrice     || DEFAULT_EMAIL_TEMPLATE.labelPrice;
  const menuHtml=calc.results.map((r,i)=>{
    const desc = cfg.menuDescriptions?.[r.id] || {};
    const feat = desc.feature   ? `<div style="font-size:11px;font-weight:700;color:#2556a8;margin:10px 0 3px;">【${esc(labelFeat)}】</div><div style="font-size:12px;color:#444;line-height:1.7;">${escNl(desc.feature)}</div>` : "";
    const rec  = desc.recommend ? `<div style="font-size:11px;font-weight:700;color:#2556a8;margin:10px 0 3px;">【${esc(labelRec)}】</div><div style="font-size:12px;color:#444;line-height:1.7;">${escNl(desc.recommend)}</div>` : "";
    const hasdesc = feat || rec;
    return `<tr><td style="padding:16px 0 ${hasdesc?"8":"0"}px;border-bottom:${hasdesc?"none":"1px solid #e7edf5"};">
      <div style="font-size:12px;color:#2556a8;font-weight:700;">${(r.recommend||i===0)?esc(labelRecommend):esc(labelCompare)}</div>
      <div style="font-size:17px;color:#17233a;font-weight:700;margin-top:3px;">${esc(r.name)}</div>
      <div style="font-size:26px;color:#17233a;font-weight:800;margin-top:6px;">¥${Number(r.total).toLocaleString("ja-JP")}</div>
      <div style="font-size:11px;color:#888;margin-top:2px;">${esc(labelPrice)}</div>
      <div style="font-size:12px;color:#777;margin-top:4px;">${esc(labelYears)}：${r.years}年</div>
      ${feat}${rec}
    </td></tr>${hasdesc?`<tr><td style="border-bottom:1px solid #e7edf5;padding:0;"></td></tr>`:""}`;
  }).join("");

    // メールテンプレート変数（管理画面で変更可、未設定はデフォルト値）
  const tpl = cfg.emailTemplate || {};
  const tplOpening  = escNl(tpl.opening || DEFAULT_EMAIL_TEMPLATE.opening);
  const tplHeading  = esc(tpl.heading || DEFAULT_EMAIL_TEMPLATE.heading);
  const tplNote     = escNl(tpl.note || DEFAULT_EMAIL_TEMPLATE.note);
  const tplLineTxt  = esc(tpl.lineText || DEFAULT_EMAIL_TEMPLATE.lineText);
  const tplTelTxt   = esc(tpl.telText || DEFAULT_EMAIL_TEMPLATE.telText);
  const tplFooter   = esc(tpl.footer || DEFAULT_EMAIL_TEMPLATE.footer);

  const customerHtml=`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans','Noto Sans JP',sans-serif;color:#17233a;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 14px;background:#f4f6f8"><tr><td>
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;margin:auto;background:#fff;border-radius:10px;overflow:hidden">
<tr><td style="background:#0b1120;padding:26px 30px;text-align:center;color:white"><div style="font-size:22px;letter-spacing:.2em;font-weight:700">UNCUORE</div><div style="font-size:10px;color:#7fb0ff;letter-spacing:.2em;margin-top:5px">AI ESTIMATE — YOKOHAMA</div></td></tr>
<tr><td style="padding:30px">
<p style="font-size:16px;font-weight:700;margin:0 0 8px">${esc(name)} 様</p>
<p style="font-size:14px;line-height:1.8;color:#56647a;margin:0 0 22px">${tplOpening}</p>
<div style="background:#eef4ff;border-left:4px solid #2563eb;padding:12px 16px;margin-bottom:24px"><div style="font-size:10px;color:#2563eb">見積番号</div><div style="font-size:18px;font-weight:700;margin-top:3px">${esc(id)}</div></div>
<table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;margin-bottom:22px">
<tr><td style="padding:6px 0;color:#7a8799;width:120px">お車</td><td style="padding:6px 0;font-weight:600">${esc(maker)} ${esc(model)}</td></tr>
<tr><td style="padding:6px 0;color:#7a8799">サイズ</td><td style="padding:6px 0;font-weight:600">${esc(size)}</td></tr>
<tr><td style="padding:6px 0;color:#7a8799">車両状態</td><td style="padding:6px 0;font-weight:600">${fullCondition}</td></tr>
<tr><td style="padding:6px 0;color:#7a8799;vertical-align:top">オプション</td><td style="padding:6px 0;font-weight:600">${optText}</td></tr>
</table>
<div style="font-size:13px;font-weight:700;border-bottom:2px solid #e7edf5;padding-bottom:7px">${tplHeading}</div>
<table width="100%" cellpadding="0" cellspacing="0">${menuHtml}</table>
<p style="font-size:11px;color:#7b8798;line-height:1.7;margin:18px 0 22px">${tplNote}</p>
<table width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:5px"><a href="https://line.me/ti/p/@271goter" style="display:block;text-align:center;background:#06c755;color:#fff;text-decoration:none;padding:14px 8px;border-radius:6px;font-size:13px;font-weight:700">${tplLineTxt}</a></td>
<td style="padding-left:5px"><a href="tel:0455488588" style="display:block;text-align:center;background:#17233a;color:#fff;text-decoration:none;padding:14px 8px;border-radius:6px;font-size:13px;font-weight:700">${tplTelTxt}</a></td>
</tr></table>
</td></tr>
<tr><td style="background:#eef2f7;padding:16px;text-align:center;color:#8a96a8;font-size:10px">${tplFooter}</td></tr>
</table></td></tr></table></body></html>`;

  let customerEmailOk=false;
  try{
    const r=await fetch("https://api.resend.com/emails",{
      method:"POST",
      headers:{"Authorization":`Bearer ${env.RESEND_API_KEY}`,"Content-Type":"application/json"},
      body:JSON.stringify({
        from:`Uncuore AI見積 <${FROM}>`,
        to:[email],
        subject:Object.entries({"{見積番号}":id,"{メーカー}":maker,"{車種}":model,"{名前}":name})
          .reduce((s,[token,value])=>s.split(token).join(value),String(tpl.subject||DEFAULT_EMAIL_TEMPLATE.subject))
          .replace(/[\r\n]+/g," ").slice(0,240),
        html:customerHtml
      })
    });
    if(r.ok) customerEmailOk=true;
    else console.error("[submit-quote] customer email failed",r.status,await r.text());
  }catch(e){console.error("[submit-quote] customer email exception",e?.message||e);}

  const record={
    no:id,
    at:now.toISOString(),
    name,tel:phone,mail:email,pref,
    maker,model,size,condition:conditionLabel,
    menu:calc.results.map(r=>r.name).join(" / "),
    years:calc.results[0].years,
    options:calc.selectedOptions.map(o=>o.name),
    total:calc.results[0].total,
    source:"normal",campaignName:"",normalPrice:0,campaignPrice:0,
    status:"未対応",memo:"",
    history:[`[${now.toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"})}] AI見積メール ${customerEmailOk?"送信済み":"送信失敗"}`],
    emailStatus:customerEmailOk?"sent":"failed",
    resultMenus:calc.results,
  };

  const saved=await saveRecord(kv,`est:${id}`,JSON.stringify(record));

  if(!customerEmailOk){
    return json({error:"メールの送信に失敗しました。メールアドレスをご確認のうえ、もう一度お試しください。"},500);
  }

  const notifyText=`[新規AI見積リード] ${id}
お名前: ${name}
メール: ${email}
電話: ${phone}
送信日時: ${now.toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"})}
車両: ${maker} ${model} / ${size} / ${conditionLabel}
オプション: ${calc.selectedOptions.map(o=>o.name).join("、")||"なし"}
見積: ${calc.results.map(r=>`${r.name} ¥${Number(r.total).toLocaleString("ja-JP")}（税別）`).join(" / ")}
管理画面: https://ai.un-cuore.com/#admin`;

  if(!saved){
    const warning=`⚠️ KV保存失敗・管理画面未登録\n${notifyText}`;
    console.error("[submit-quote]",warning);
    context.waitUntil((async()=>{
      try{
        const r=await fetch("https://api.resend.com/emails",{
          method:"POST",
          headers:{"Authorization":`Bearer ${env.RESEND_API_KEY}`,"Content-Type":"application/json"},
          body:JSON.stringify({from:`Uncuore システム <${FROM}>`,to:[NOTIFY],subject:`[⚠️KV保存失敗] ${id} 要手動対応`,text:warning})
        });
        if(!r.ok) console.error("[submit-quote] kv warning email failed",r.status,await r.text());
      }catch(e){console.error("[submit-quote] kv warning exception",e?.message||e);}
    })());
    return json({ok:true,id,warning:"storage_failed"},200);
  }

  context.waitUntil((async()=>{
    try{
      const r=await fetch("https://api.resend.com/emails",{
        method:"POST",
        headers:{"Authorization":`Bearer ${env.RESEND_API_KEY}`,"Content-Type":"application/json"},
        body:JSON.stringify({from:`Uncuore システム <${FROM}>`,to:[NOTIFY],reply_to:email,subject:`[新規AI見積リード] ${id} ${name}`,text:notifyText})
      });
      if(!r.ok) console.error("[submit-quote] notify failed",r.status,await r.text());
    }catch(e){console.error("[submit-quote] notify exception",e?.message||e);}
  })());

  return json({ok:true,id},200);
}

export async function onRequest(context){
  if(context.request.method==="POST") return onRequestPost(context);
  if(context.request.method==="OPTIONS") return onRequestOptions(context);
  return json({error:"Method Not Allowed"},405);
}
