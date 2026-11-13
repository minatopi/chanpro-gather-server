// Vercel Serverless Function: /api/status
// Axiom token and Supabase service-role key are server-only environment variables.
"use strict";
const { createClient } = require("@supabase/supabase-js");

const FEATURES = [
  ["post","投稿の作成",["post-create"]],
  ["image","画像アップロード",["image-upload","image-register"]],
  ["read","タイムライン・投稿の読み込み",["db-read-batch","post-read","reply-list","reply-prefetch","limited-post-list","post-view"]],
  ["delete","投稿・返信の削除",["post-delete","reply-delete"]],
  ["pin","投稿の固定",["post-pin"]],
  ["reply","返信",["reply-create"]],
  ["like","いいね",["post-like-toggle"]],
  ["repost","リポスト",["repost-toggle"]],
  ["bookmark","ブックマーク",["bookmark-toggle"]],
  ["poll","アンケート",["poll-vote"]],
  ["follow","フォロー",["follow-toggle"]],
  ["report","報告・通報",["report","report-create"]],
  ["dm_send","DM送信",["dm-send"]],
  ["dm_read","DM閲覧",["dm-list","dm-get"]],
  ["chat","チャット",["chat-history-add","chat-history-delete","chat-pins-save"]],
  ["notification","通知",["notifications-read"]],
  ["developer_msg","開発者への連絡",["developer-inbox-send","developer-message-read"]],
  ["points_send","ポイント送信",["transfer-points"]],
  ["stamp","スタンプ購入",["stamp-purchase"]],
  ["bonus","ポイント獲得",["user-login-streak","weekly-points","chat-points"]],
  ["profile","プロフィール・設定",["user-update","profile-music-save","user-settings"]],
  ["account_delete","アカウント削除",["account-delete"]]
];
const ACTION_FEATURE = new Map(FEATURES.flatMap(([key,,actions]) => actions.map(a => [a,key])));
const CACHE = new Map();
const CACHE_MS = 30000;
const iso = d => new Date(d).toISOString();
const clampDays = n => Math.max(1,Math.min(30,Math.trunc(Number(n)||30)));

function parseAxiom(body) {
  if (Array.isArray(body?.matches)) return body.matches.map(x => ({_time:x._time,...(x.data||{})}));
  const table = body?.tables?.[0];
  if (!table?.columns || !table?.fields) return [];
  const count = (table.columns[0]||[]).length, out=[];
  for(let i=0;i<count;i++){const row={};table.fields.forEach((f,j)=>row[f.name]=table.columns[j]?.[i]);out.push(row);}
  return out;
}
async function getLogs(days) {
  const token=process.env.AXIOM_TOKEN, dataset=process.env.AXIOM_DATASET||"chanpro";
  if(!token) throw new Error("AXIOM_TOKEN がVercelに設定されていません");
  const apl=`['${dataset.replace(/'/g,"") }'] | where _time > ago(${days}d) | where source == "gather-api" | where type == "access" or type == "api_error" or type == "feature_blocked" | project _time,type,action,status,ms,feature,feature_label,message,reason | sort by _time desc | take 20000`;
  const response=await fetch("https://api.axiom.co/v1/datasets/_apl?format=legacy",{
    method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
    body:JSON.stringify({apl}),signal:AbortSignal.timeout(12000)
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(data.message||`Axiom HTTP ${response.status}`);
  return parseAxiom(data);
}
async function getSettings() {
  const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!url||!key) throw new Error("Supabaseのサーバー環境変数が設定されていません");
  const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data,error}=await db.from("app_settings").select("key,value");
  if(error) throw error;
  return new Map((data||[]).map(x=>[x.key,x.value]));
}
function bucketLabel(t) {
  return new Date(t).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo",month:"2-digit",day:"2-digit",hour:"2-digit"});
}
function aggregate(rows, settings, days) {
  const now=Date.now(), since=now-days*86400000, bucketMs=days===1?3600000:days===7?6*3600000:24*3600000;
  const results=FEATURES.map(([key,name])=>{
    const actions=new Set(FEATURES.find(x=>x[0]===key)[2]);
    const access=rows.filter(r=>r.type==="access"&&actions.has(String(r.action))&&new Date(r._time).getTime()>=since);
    const errors=access.filter(r=>Number(r.status)>=400);
    const apiErrors=rows.filter(r=>r.type==="api_error"&&actions.has(String(r.action))&&new Date(r._time).getTime()>=since);
    const recentApiErrors=apiErrors.filter(r=>new Date(r._time).getTime()>=now-15*60000);
    const blocked=rows.some(r=>r.type==="feature_blocked"&&r.feature===key&&new Date(r._time).getTime()>=now-15*60000);
    const disabled=settings.get("feature_"+key)===false;
    const latencies=access.map(r=>Number(r.ms)).filter(n=>Number.isFinite(n)&&n>=0);
    const ok=access.length-errors.length;
    const rate=access.length?ok/access.length*100:null;
    const recentError=Math.max(errors.filter(r=>new Date(r._time).getTime()>=now-15*60000).length,recentApiErrors.length);
    const totalErrors=Math.max(errors.length,apiErrors.length);
    let state="データ不足",message="";
    if(disabled||blocked){state="停止";message=settings.get("feature_"+key+"_message")||"管理設定により機能が停止されています。";}
    else if(recentError>=3){state="不具合";message="直近15分以内に複数のAPIエラーが記録されています。";}
    else if((access.length>=5&&rate<98)||totalErrors>0){state="注意";message="集計期間内にAPIエラーが記録されています。";}
    else if(access.length>=3){state="正常";}
    const buckets=[];
    const count=Math.min(48,Math.ceil(days*86400000/bucketMs));
    for(let i=count-1;i>=0;i--){
      const a=now-(i+1)*bucketMs,b=now-i*bucketMs;
      const group=access.filter(r=>{const t=new Date(r._time).getTime();return t>=a&&t<b;});
      const good=group.filter(r=>Number(r.status)<400).length;
      const ms=group.map(r=>Number(r.ms)).filter(n=>Number.isFinite(n)&&n>=0);
      buckets.push({label:bucketLabel(b),success_rate:group.length?good/group.length*100:null,avg_ms:ms.length?ms.reduce((x,y)=>x+y,0)/ms.length:null});
    }
    const last=access.reduce((v,r)=>!v||new Date(r._time)>new Date(v)?r._time:v,null);
    return {key,name,state,message,requests:access.length,errors:totalErrors,success_rate:rate,avg_ms:latencies.length?latencies.reduce((a,b)=>a+b,0)/latencies.length:null,last_seen:last,buckets};
  });
  const events=[];
  rows.filter(r=>["api_error","feature_blocked"].includes(r.type)).forEach(r=>{
    const key=r.feature||ACTION_FEATURE.get(String(r.action))||"unknown";
    const def=FEATURES.find(x=>x[0]===key);
    events.push({time:r._time,kind:r.type==="feature_blocked"?"blocked":"error",feature:key,feature_name:def?.[1]||r.feature_label||key,message:String(r.message||r.reason|| (r.type==="feature_blocked"?"機能停止が記録されました":"APIエラーが記録されました")).slice(0,300)});
  });
  return {features:results,events:events.sort((a,b)=>new Date(b.time)-new Date(a.time)).slice(0,300)};
}
module.exports = async function handler(req,res) {
  res.setHeader("Content-Type","application/json; charset=utf-8");
  res.setHeader("Cache-Control","public, max-age=15, stale-while-revalidate=15");
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET, OPTIONS");
  if(req.method==="OPTIONS") return res.status(204).end();
  if(req.method!=="GET") return res.status(405).json({ok:false,error:"GET only"});
  const days=clampDays(req.query?.days);
  const cacheKey=String(days),cached=CACHE.get(cacheKey);
  if(cached&&Date.now()-cached.at<CACHE_MS) return res.status(200).json(cached.value);
  try {
    const [logs,settings]=await Promise.all([getLogs(days),getSettings()]);
    const value={ok:true,generated_at:iso(Date.now()),days,...aggregate(logs,settings,days)};
    CACHE.set(cacheKey,{at:Date.now(),value});
    return res.status(200).json(value);
  } catch(e) {
    console.error("status API error:",e?.message||e);
    return res.status(503).json({ok:false,error:"稼働情報の取得に失敗しました。サーバー設定とログ保存状況を確認してください。"});
  }
};
