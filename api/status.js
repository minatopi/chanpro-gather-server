/**
 * Independent ChanPro status API. Does not import or modify api/secure.js.
 * Deploy at chanpro-gather-server/api/status.js
 */
"use strict";
const crypto=require("crypto");
const E=process.env,BASE=(E.SUPABASE_URL||"").replace(/\/+$/,""),KEY=E.SUPABASE_SERVICE_ROLE_KEY||"";
const AXIOM=E.AXIOM_TOKEN||"",DATASET=E.AXIOM_DATASET||"chanpro",ADMIN=E.STATUS_ADMIN_KEY||"",IP_SECRET=E.STATUS_IP_HASH_SECRET||"";
const METRICS=E.STATUS_METRICS_URL||"https://minatopi.github.io/chanpro-gather-surveillance/metrics.json";
const TIMEOUT=Math.max(2000,Math.min(15000,Number(E.STATUS_TEST_TIMEOUT_MS||8000)));
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
function eq(a,b){const x=Buffer.from(String(a||"")),y=Buffer.from(String(b||""));return x.length>0&&x.length===y.length&&crypto.timingSafeEqual(x,y)}
async function get(url,opt={},ms=TIMEOUT){
 const c=new AbortController(),t=setTimeout(()=>c.abort(),ms);
 try{const r=await fetch(url,{...opt,signal:c.signal});const s=await r.text();let d;try{d=s?JSON.parse(s):null}catch(_){d={message:s.slice(0,250)}}if(!r.ok)throw Error(clean(d?.message||d?.details||`HTTP ${r.status}`));return d}finally{clearTimeout(t)}
}
async function sb(path,opt={}){if(!BASE||!KEY)throw Error("Supabase環境変数が未設定です");return get(`${BASE}/rest/v1/${path}`,{...opt,headers:{apikey:KEY,Authorization:`Bearer ${KEY}`,"Content-Type":"application/json",...(opt.headers||{})}})}
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
async function dashboard(days){
 const logs=await queryAxiom(`['${DATASET.replace(/'/g,"''")}'] | where _time > ago(${days}d) | where type in ("access","api_error","feature_blocked","feature_status") | sort by _time desc | take 5000`);
 const map=new Map(FEATURES.map(([key,name])=>[key,{key,name,requests:0,errors:0,blocked:0,latencies:[],last_seen:null}]));
 const events=[];
 for(const r of logs){
  const key=featureOf(r),s=map.get(key);if(!s)continue;
  const tm=r._time?new Date(r._time).toISOString():null;
  if(r.type==="access"){s.requests++;if(Number(r.status||200)>=400)s.errors++;const n=Number(r.ms??r.duration_ms);if(Number.isFinite(n)&&n>=0)s.latencies.push(n)}
  if(r.type==="api_error"){s.requests++;s.errors++;events.push({time:tm,feature:key,feature_name:s.name,kind:"error",message:clean(r.message||r.error||r.action||"APIエラー")})}
  if(r.type==="feature_blocked"){s.blocked++;events.push({time:tm,feature:key,feature_name:s.name,kind:"blocked",message:clean(r.message||r.reason||"機能停止")})}
  if(r.type==="feature_status"&&!["正常","稼働中"].includes(r.status)){events.push({time:tm,feature:key,feature_name:s.name,kind:"blocked",message:clean(r.message||r.status)})}
  if(!s.last_seen||ms(tm)>ms(s.last_seen))s.last_seen=tm;
 }
 const features=[...map.values()].map(s=>{
  const rate=s.requests?((s.requests-s.errors)/s.requests)*100:null;
  const state=s.blocked?"停止":s.requests<1?"データ不足":s.requests>=5&&rate<95?"不具合":s.requests>=5&&rate<99?"注意":"正常";
  const buckets=Array.from({length:Math.min(48,Math.max(12,days*4))},(_,i)=>{
   const span=days*86400000/Math.min(48,Math.max(12,days*4)),from=Date.now()-days*86400000+i*span,to=from+span;
   const rs=logs.filter(r=>featureOf(r)===s.key&&["access","api_error"].includes(r.type)&&ms(r._time)>=from&&ms(r._time)<to);
   const bad=rs.filter(r=>r.type==="api_error"||Number(r.status)>=400),lat=rs.map(r=>Number(r.ms??r.duration_ms)).filter(n=>Number.isFinite(n)&&n>=0);
   return {label:labelTime(from),success_rate:rs.length?(rs.length-bad.length)/rs.length*100:null,avg_ms:lat.length?lat.reduce((a,b)=>a+b,0)/lat.length:null};
  });
  return {...s,success_rate:rate,avg_ms:s.latencies.length?s.latencies.reduce((a,b)=>a+b,0)/s.latencies.length:null,state,message:s.blocked?"停止ログあり":s.errors?"APIエラー記録あり":"",buckets};
 });
 events.sort((a,b)=>ms(b.time)-ms(a.time));
 return {ok:true,generated_at:new Date().toISOString(),features,events:events.slice(0,300)};
}
function ipHash(req){if(!IP_SECRET)throw Error("STATUS_IP_HASH_SECRET が未設定です");const ip=String(req.headers["x-forwarded-for"]||req.headers["x-real-ip"]||"unknown").split(",")[0].trim();return crypto.createHmac("sha256",IP_SECRET).update(ip).digest("hex")}
async function lockIp(hash){
 const r=await sb("rpc/claim_status_manual_test",{method:"POST",body:JSON.stringify({p_ip_hash:hash})}),x=Array.isArray(r)?r[0]:r;
 if(!x?.allowed){const e=Error("このIPからの手動テストは10分に1回までです");e.status=429;e.retry=x?.retry_after_seconds||600;throw e}
}
async function probeMetrics(){const d=await get(METRICS);const s=d?.["chanpro-gather"]?.stats;if(!s)throw Error("監視メトリクスの形式が不正です");return `${s.last_status||"不明"} / ${Number(s.total_checks||0)}回`}
async function probeAxiom(){const r=await queryAxiom(`['${DATASET.replace(/'/g,"''")}'] | where _time > ago(7d) | take 1`);return `${r.length}件以上の記録を確認`}
async function probeDb(){
 const id=crypto.randomUUID(),marker="status-test-"+id,start=Date.now();let created=false,problem="";
 try{
  await sb("status_test_records",{method:"POST",headers:{Prefer:"return=minimal"},body:JSON.stringify({id,marker,payload:{step:"created"}})});created=true;
  const a=await sb(`status_test_records?id=eq.${id}&select=id,marker,payload`);if(!Array.isArray(a)||a.length!==1||a[0].marker!==marker)throw Error("作成した行を読めません");
  await sb(`status_test_records?id=eq.${id}`,{method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify({payload:{step:"updated"}})});
  const b=await sb(`status_test_records?id=eq.${id}&select=payload`);if(b?.[0]?.payload?.step!=="updated")throw Error("更新を確認できません");
 }catch(e){problem=clean(e.message)}
 let cleanup="";if(created){try{await sb(`status_test_records?id=eq.${id}`,{method:"DELETE",headers:{Prefer:"return=minimal"}})}catch(e){cleanup=clean(e.message)}}
 return {feature:"専用DBの作成・読み込み・更新・削除",ok:!problem&&!cleanup,response_ms:Date.now()-start,message:cleanup?`削除失敗：${cleanup}`:problem||"専用テーブルのCRUDと後片付けを確認しました"};
}
function targets(){
 let a=[];try{a=JSON.parse(E.STATUS_TEST_TARGETS||"[]")}catch(_){throw Error("STATUS_TEST_TARGETSはJSON配列にしてください")}
 if(!Array.isArray(a))throw Error("STATUS_TEST_TARGETSはJSON配列にしてください");
 return a.slice(0,40).map((x,i)=>{const u=new URL(x.url);if(u.protocol!=="https:"||u.hostname==="localhost"||u.hostname.endsWith(".local"))throw Error("テスト先は公開HTTPS URLにしてください");return {feature:clean(x.feature||x.id||`接続先${i+1}`,80),url:u.href,method:String(x.method||"GET").toUpperCase()==="HEAD"?"HEAD":"GET"}});
}
async function probeTarget(t){const start=Date.now();try{const r=await get(t.url,{method:t.method,redirect:"manual",headers:{"User-Agent":"ChanPro-Status-Test/1.0"}});return {feature:t.feature,ok:true,response_ms:Date.now()-start,message:"HTTP応答を確認しました"}}catch(e){return {feature:t.feature,ok:false,response_ms:Date.now()-start,message:clean(e.message)}}}
async function run(req){
 await lockIp(ipHash(req));
 const checks=await Promise.all([
  (async()=>{const t=Date.now();try{return{feature:"監視メトリクス",ok:true,response_ms:Date.now()-t,message:await probeMetrics()}}catch(e){return{feature:"監視メトリクス",ok:false,response_ms:Date.now()-t,message:clean(e.message)}}})(),
  (async()=>{const t=Date.now();try{return{feature:"Axiomログ読み込み",ok:true,response_ms:Date.now()-t,message:await probeAxiom()}}catch(e){return{feature:"Axiomログ読み込み",ok:false,response_ms:Date.now()-t,message:clean(e.message)}}})(),
  probeDb(),...targets().map(probeTarget)
 ]);
 const finished=new Date().toISOString(),id=crypto.randomUUID(),result={id,source:"status-manual-test",started_at:finished,finished_at:finished,total:checks.length,passed:checks.filter(x=>x.ok).length,failed:checks.filter(x=>!x.ok).length,results:checks};
 try{await sb("status_test_runs",{method:"POST",headers:{Prefer:"return=minimal"},body:JSON.stringify(result)})}catch(_){}
 if(AXIOM){try{await get(`https://api.axiom.co/v1/datasets/${encodeURIComponent(DATASET)}/ingest`,{method:"POST",headers:{Authorization:`Bearer ${AXIOM}`,"Content-Type":"application/json"},body:JSON.stringify([{_time:finished,type:"status_self_test",...result}])})}catch(_){}}
 return result;
}
module.exports=async function(req,res){
 try{
  const action=String(req.query?.action||"dashboard");
  if(req.method==="OPTIONS"){res.setHeader("Allow","GET, POST, OPTIONS");return res.status(204).end()}
  if(req.method==="GET"&&action==="health")return out(res,200,{ok:true,service:"chanpro-status-api",time:new Date().toISOString()});
  if(req.method==="GET"&&action==="dashboard"){const days=Math.max(1,Math.min(30,Number(req.query?.days||30)));return out(res,200,await dashboard(days))}
  if(req.method==="POST"&&action==="run"){if(!ADMIN||!eq(req.headers["x-status-admin-key"],ADMIN))return out(res,401,{ok:false,error:"管理者テストキーが正しくありません"});return out(res,200,{ok:true,...await run(req)})}
  return out(res,405,{ok:false,error:"許可されていない操作です"});
 }catch(e){if(e.retry)res.setHeader("Retry-After",String(e.retry));return out(res,e.status||500,{ok:false,error:clean(e.message,500)})}
};
