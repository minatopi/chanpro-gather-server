/**
 * Independent ChanPro status API. Does not import or modify api/secure.js.
 * Deploy at chanpro-gather-server/api/status.js
 */
"use strict";
const E=process.env;
const AXIOM=E.AXIOM_TOKEN||"",DATASET=E.AXIOM_DATASET||"chanpro";
const TIMEOUT=8000;
const FEATURES=[
["post","投稿"],["reply","返信"],["read","投稿・返信の読み込み"],["delete","投稿・返信の削除"],["image","画像アップロード"],["pin","投稿固定"],["like","いいね"],["repost","リポスト"],["bookmark","ブックマーク"],["poll","投票"],["follow","フォロー"],["report","通報"],["dm_send","DM送信"],["dm_read","DM読み込み"],["chat","チャット"],["notification","通知"],["developer_msg","運営メッセージ"],["points_send","ポイント送信"],["stamp","スタンプ"],["bonus","ログイン・継続ボーナス"],["profile","プロフィール・設定"],["account_delete","アカウント削除"]
];
const ACTIONS={
"post-create":"post","reply-create":"reply","post-read":"read","reply-list":"read","reply-prefetch":"read","limited-post-list":"read","post-view":"read",
"post-delete":"delete","reply-delete":"delete","image-upload":"image","image-register":"image","post-pin":"pin","post-like-toggle":"like","repost-toggle":"repost","bookmark-toggle":"bookmark","poll-vote":"poll","follow-toggle":"follow","report":"report","report-create":"report",
"dm-send":"dm_send","dm-list":"dm_read","dm-get":"dm_read","chat-history-add":"chat","chat-history-delete":"chat","chat-pins-save":"chat","notifications-read":"notification","developer-inbox-send":"developer_msg","developer-message-read":"developer_msg",
"transfer-points":"points_send","stamp-purchase":"stamp","user-login-streak":"bonus","weekly-points":"bonus","chat-points":"bonus","user-update":"profile","profile-music-save":"profile","user-settings":"profile","account-delete":"account_delete"
};
const clean=(v,n=300)=>String(v??"").replace(/[\u0000-\u001f\u007f]/g," ").slice(0,n);
function out(res,status,data){res.status(status);res.setHeader("Content-Type","application/json; charset=utf-8");res.setHeader("Cache-Control","no-store");res.setHeader("X-Content-Type-Options","nosniff");res.end(JSON.stringify(data))}
async function get(url,opt={},ms=TIMEOUT){
 const c=new AbortController(),t=setTimeout(()=>c.abort(),ms);
 try{const r=await fetch(url,{...opt,signal:c.signal});const s=await r.text();let d;try{d=s?JSON.parse(s):null}catch(_){d={message:s.slice(0,250)}}if(!r.ok)throw Error(clean(d?.message||d?.details||`HTTP ${r.status}`));return d}finally{clearTimeout(t)}
}
async function queryAxiom(apl){
 if(!AXIOM)throw Error("AXIOM_TOKEN が未設定です");
 const d=await get("https://api.axiom.co/v1/datasets/_apl?format=legacy",{method:"POST",headers:{Authorization:`Bearer ${AXIOM}`,"Content-Type":"application/json"},body:JSON.stringify({apl})});
 if(Array.isArray(d.matches))return d.matches.map(x=>({_time:x._time,...(x.data||{})}));
 const t=d.tables?.[0];if(!t?.fields||!t?.columns)return [];
 return Array.from({length:(t.columns[0]||[]).length},(_,i)=>{const o={};t.fields.forEach((f,j)=>o[f.name]=t.columns[j]?.[i]);return o});
}
const ms=v=>{const n=new Date(v).getTime();return Number.isFinite(n)?n:0};
const labelTime=t=>new Date(t).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo",month:"2-digit",day:"2-digit",hour:"2-digit"});
function featureOf(row){return ACTIONS[String(row.action||"")]||String(row.feature||"")}
// These messages describe an expected user-side rejection, not a service failure.
const USER_ERROR_RE=/(すでに投票|既に投票|投票済み|already\s+voted|password.{0,20}(incorrect|wrong|invalid)|username.{0,20}(incorrect|wrong|invalid)|invalid.{0,20}(credentials|password|username)|ユーザー名.{0,20}(違|正しくない|間違)|パスワード.{0,20}(違|正しくない|間違)|ユーザー名またはパスワード|入力.{0,15}(不正|不足)|必須項目|重複しています|duplicate.{0,20}(vote|entry)|validation.{0,20}(error|failed))/i;
function isUserCaused(row){
 const message=[row.message,row.error,row.error_message,row.reason,row.details,row.response].filter(Boolean).join(" ");
 return USER_ERROR_RE.test(String(message));
}
function classify(row){
 if(isUserCaused(row))return null;
 if(row.type==="feature_blocked")return "blocked";
 if(row.type==="feature_status")return ["正常","稼働中","ok","healthy","up"].includes(String(row.status||"").toLowerCase())||["正常","稼働中"].includes(String(row.status||""))?"normal":"blocked";
 if(row.type==="api_error")return "error";
 if(row.type==="access")return Number(row.status||200)>=400?"error":"normal";
 return null;
}
async function dashboard(days){
 const logs=await queryAxiom(`['${DATASET.replace(/'/g,"''")}'] | where _time > ago(${days}d) | where type in ("access","api_error","feature_blocked","feature_status") | sort by _time desc | take 5000`);
 const map=new Map(FEATURES.map(([key,name])=>[key,{key,name,requests:0,errors:0,blocked:0,latencies:[],last_seen:null,last_state:"normal",last_state_time:0,last_message:""}]));
 const events=[];
 for(const r of logs){
  const key=featureOf(r),s=map.get(key);if(!s)continue;
  const time=ms(r._time),tm=time?new Date(time).toISOString():null;
  if(!s.last_seen||time>ms(s.last_seen))s.last_seen=tm;
  const state=classify(r);
  if(state===null)continue;
  if(["access","api_error"].includes(r.type)){
   s.requests++;
   if(state==="error")s.errors++;
   if(r.type==="access"&&state==="normal"){
    const n=Number(r.ms??r.duration_ms);if(Number.isFinite(n)&&n>=0)s.latencies.push(n);
   }
  }
  if(state==="blocked")s.blocked++;
  if(time>=s.last_state_time){
   s.last_state=state;s.last_state_time=time;
   s.last_message=state==="normal"?"":clean(r.message||r.error||r.reason||r.status|| (state==="blocked"?"機能停止の記録":"APIエラー"));
  }
  if(state==="error")events.push({time:tm,feature:key,feature_name:s.name,kind:"error",message:clean(r.message||r.error||r.error_message||r.action||"APIエラー")});
  if(state==="blocked")events.push({time:tm,feature:key,feature_name:s.name,kind:"blocked",message:clean(r.message||r.reason||r.status||"機能停止")});
 }
 const features=[...map.values()].map(s=>{
  const rate=s.requests?((s.requests-s.errors)/s.requests)*100:null;
  const state=s.last_state==="blocked"?"停止":s.last_state==="error"?"不具合":"正常";
  const count=Math.min(48,Math.max(12,days*4));
  const buckets=Array.from({length:count},(_,i)=>{
   const span=days*86400000/count,from=Date.now()-days*86400000+i*span,to=from+span;
   const rs=logs.filter(r=>featureOf(r)===s.key&&["access","api_error"].includes(r.type)&&!isUserCaused(r)&&ms(r._time)>=from&&ms(r._time)<to);
   const bad=rs.filter(r=>classify(r)==="error"),lat=rs.filter(r=>r.type==="access"&&classify(r)==="normal").map(r=>Number(r.ms??r.duration_ms)).filter(n=>Number.isFinite(n)&&n>=0);
   return {label:labelTime(from),success_rate:rs.length?(rs.length-bad.length)/rs.length*100:null,avg_ms:lat.length?lat.reduce((a,b)=>a+b,0)/lat.length:null};
  });
  return {key:s.key,name:s.name,requests:s.requests,errors:s.errors,blocked:s.blocked,success_rate:rate,avg_ms:s.latencies.length?s.latencies.reduce((a,b)=>a+b,0)/s.latencies.length:null,last_seen:s.last_seen,state,message:s.last_message,buckets};
 });
 events.sort((a,b)=>ms(b.time)-ms(a.time));
 return {ok:true,generated_at:new Date().toISOString(),features,events:events.slice(0,300)};
}
module.exports=async function(req,res){
 try{
  const action=String(req.query?.action||"dashboard");
  if(req.method==="OPTIONS"){res.setHeader("Allow","GET, OPTIONS");return res.status(204).end()}
  if(req.method==="GET"&&action==="health")return out(res,200,{ok:true,service:"chanpro-status-api",time:new Date().toISOString()});
  if(req.method==="GET"&&action==="dashboard"){const days=Math.max(1,Math.min(30,Number(req.query?.days||30)));return out(res,200,await dashboard(days))}
  return out(res,405,{ok:false,error:"許可されていない操作です"});
 }catch(e){return out(res,500,{ok:false,error:clean(e.message,500)})}
};
