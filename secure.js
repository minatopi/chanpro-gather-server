import crypto from 'node:crypto';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hash = value => crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
const today = () => { const d=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Tokyo'})); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const safe = u => ({ id:u.id, username:u.username, role:u.role || 'user', icon_url:u.icon_url || null, cover_url:u.cover_url || null, profile:u.profile || null, program_urls:u.program_urls || [], program_views:u.program_views || [], program_likes:u.program_likes || [], profile_music:u.profile_music || null, settings:u.settings || {}, points:Number(u.points||0), stamp_list:u.stamp_list || [], login_streak:Number(u.login_streak||0), last_login_date:u.last_login_date || null, ban_count:Number(u.ban_count||0), ban_until:u.ban_until || null, line_user_id:u.line_user_id || null, verified:!!u.verified });
async function sb(path, init={}) {
  if (!URL || !KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です');
  const r = await fetch(`${URL}/rest/v1/${path}`, { ...init, headers:{ apikey:KEY, Authorization:`Bearer ${KEY}`, 'Content-Type':'application/json', Prefer:'return=representation', ...(init.headers||{}) } });
  const t=await r.text(); let data=null; try{data=t?JSON.parse(t):null}catch{data=t}
  if(!r.ok) throw new Error(typeof data==='object'?(data?.message||data?.hint||JSON.stringify(data)):String(data));
  return data;
}
async function getUser(username) {
  const rows=await sb(`users?select=id,username,password_hash,role,ban_until,ban_count,icon_url,cover_url,profile,program_urls,profile_music,settings,points,stamp_list,login_streak,last_login_date,consecutive_post_weeks,last_post_week,program_views,program_likes,verified,line_user_id&username=eq.${encodeURIComponent(username)}&limit=1`);
  return rows?.[0]||null;
}
async function auth(body, {checkBan=true}={}) {
  const username=String(body.username||body.authUsername||'').trim(), password=String(body.password||'');
  if(!username||!password) throw Object.assign(new Error('ユーザー名とパスワードが必要です'),{status:401});
  const u=await getUser(username);
  if(!u||u.password_hash!==hash(password)) throw Object.assign(new Error('ユーザー名またはパスワードが違います'),{status:401});
  if(checkBan && u.ban_until && new Date(u.ban_until).getTime()>Date.now()) throw Object.assign(new Error('このアカウントはBAN中です'),{status:403});
  return u;
}
function deviceHash(v){const s=String(v||'').trim();if(!s||s.length>256)throw Object.assign(new Error('端末識別子が必要です'),{status:400});return s}
export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method!=='POST')return res.status(405).json({ok:false,error:'POST only'});
  try {
    const b=req.body||{}, action=String(b.action||'');
    if(!action)throw Object.assign(new Error('action が必要です'),{status:400});

    if(action==='login'){
      const u=await auth(b,{checkBan:false}); const dh=deviceHash(b.deviceHash);
      const active=await sb(`chat_device_bans?select=id&target_user_id=eq.${encodeURIComponent(u.id)}&target_device_hash=eq.${encodeURIComponent(dh)}&ban_until=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`).catch(()=>[]);
      const legacy=await sb(`banned_devices?select=id,reason&device_hash=eq.${encodeURIComponent(dh)}&limit=1`).catch(()=>[]);
      if(active?.length || legacy?.length || (u.ban_until&&new Date(u.ban_until)>new Date()))throw Object.assign(new Error('BAN中のためログインできません'),{status:403});
      const bound=await sb(`user_devices?select=id,user_id&device_hash=eq.${encodeURIComponent(dh)}`);
      const userIds=[...new Set((bound||[]).map(x=>x.user_id).filter(Boolean))];
      if(!userIds.includes(u.id)&&userIds.length>=3)throw Object.assign(new Error('この端末で利用できるアカウント数の上限です'),{status:403});
      await sb(`user_devices?on_conflict=user_id,device_hash`,{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify({user_id:u.id,device_hash:dh,device_info:{source:'chanpro-gather'},last_login_at:new Date().toISOString()})});
      return res.status(200).json({ok:true,user:safe(u),isAdmin:['admin','developer'].includes(u.role)});
    }

    if(action==='register'){
      const username=String(b.username||'').trim(), password=String(b.password||''), dh=deviceHash(b.deviceHash);
      if(username.length<2||username.length>32||password.length<8)throw Object.assign(new Error('ユーザー名は2〜32文字、パスワードは8文字以上にしてください'),{status:400});
      const devices=await sb(`user_devices?select=id,user_id&device_hash=eq.${dh}`);
      const ids=[...new Set((devices||[]).map(x=>x.user_id).filter(Boolean))];
      if(ids.length>=3)throw Object.assign(new Error('この端末から作成できるアカウント数の上限です'),{status:403});
      const exists=await sb(`users?select=id&username=eq.${encodeURIComponent(username)}&limit=1`);
      if(exists?.length)throw Object.assign(new Error('そのユーザー名は使用されています'),{status:409});
      const created=await sb('users',{method:'POST',body:JSON.stringify({username,password_hash:hash(password),role:'user'})});
      const u=created?.[0]; if(!u)throw new Error('アカウント作成に失敗しました');
      await sb('user_devices',{method:'POST',body:JSON.stringify({user_id:u.id,device_hash:dh})});
      return res.status(201).json({ok:true,user:safe(u)});
    }

    if(action==='post-create'){
      const u=await auth(b); const content=String(b.content||'').trim();
      if(!content||content.length>10000)throw Object.assign(new Error('投稿内容が空か、長すぎます'),{status:400});
      const created=await sb('posts',{method:'POST',body:JSON.stringify({user_id:u.id,content,image_url:b.image_url||null,is_limited:!!b.is_limited,quote_post_id:b.quote_post_id||null,poll:b.poll||null})});
      const tags=[...new Set(content.replace(/```html\s*\n[\s\S]*?\n```/gi,'').match(/#[\p{L}\p{N}_]+/gu)||[])].map(x=>x.slice(1).toLowerCase());
      for(const tag of tags){const rows=await sb(`hashtags?select=tag,usage_count&tag=eq.${encodeURIComponent(tag)}&limit=1`);if(rows?.length)await sb(`hashtags?tag=eq.${encodeURIComponent(tag)}`,{method:'PATCH',body:JSON.stringify({usage_count:Number(rows[0].usage_count||0)+1,updated_at:new Date().toISOString()})});else await sb('hashtags',{method:'POST',body:JSON.stringify({tag,usage_count:1,updated_at:new Date().toISOString()})});}
      return res.status(201).json({ok:true,post:created?.[0]||null});
    }

    if(action==='post-pin'){
      const u=await auth(b);const id=String(b.postId||'');if(!id)throw Object.assign(new Error('postId が必要です'),{status:400});
      const posts=await sb(`posts?select=id,user_id,is_pinned&id=eq.${encodeURIComponent(id)}&limit=1`);const post=posts?.[0];
      if(!post)throw Object.assign(new Error('投稿が見つかりません'),{status:404});
      if(post.user_id!==u.id)throw Object.assign(new Error('自分の投稿だけ固定できます'),{status:403});
      const pinned=!!b.pinned;
      if(pinned)await sb(`posts?user_id=eq.${encodeURIComponent(u.id)}&is_pinned=eq.true`,{method:'PATCH',body:JSON.stringify({is_pinned:false})});
      const rows=await sb(`posts?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(u.id)}`,{method:'PATCH',body:JSON.stringify({is_pinned:pinned})});
      return res.status(200).json({ok:true,pinned:rows?.[0]?.is_pinned??pinned});
    }
    if(action==='post-delete'){
      const u=await auth(b); const id=String(b.postId||''); if(!id)throw Object.assign(new Error('postId が必要です'),{status:400});
      const posts=await sb(`posts?select=id,user_id,content& id=eq.${encodeURIComponent(id)}&limit=1`.replace('& id=','&id=')); const p=posts?.[0];
      if(!p)throw Object.assign(new Error('投稿が見つかりません'),{status:404});
      if(p.user_id!==u.id&&!['admin','developer'].includes(u.role))throw Object.assign(new Error('削除権限がありません'),{status:403});
      await sb(`posts?id=eq.${encodeURIComponent(id)}`,{method:'DELETE'});
      const tags=[...new Set(String(p.content||'').replace(/```html\s*\n[\s\S]*?\n```/gi,'').match(/#[\p{L}\p{N}_]+/gu)||[])].map(x=>x.slice(1).toLowerCase());
      for(const tag of tags){const rows=await sb(`hashtags?select=tag,usage_count&tag=eq.${encodeURIComponent(tag)}&limit=1`);if(!rows?.length)continue;const next=Math.max(0,Number(rows[0].usage_count||0)-1);if(next===0)await sb(`hashtags?tag=eq.${encodeURIComponent(tag)}`,{method:'DELETE'});else await sb(`hashtags?tag=eq.${encodeURIComponent(tag)}`,{method:'PATCH',body:JSON.stringify({usage_count:next,updated_at:new Date().toISOString()})});}
      return res.status(200).json({ok:true,message:'投稿を削除しました'});
    }

    if(action==='user-update'){
      const u=await auth(b,{checkBan:false}); const patch={};
      if(b.newUsername!==undefined){const name=String(b.newUsername).trim();if(name.length<2||name.length>32)throw Object.assign(new Error('ユーザー名は2〜32文字です'),{status:400});const dup=await sb(`users?select=id&username=eq.${encodeURIComponent(name)}&id=neq.${encodeURIComponent(u.id)}&limit=1`);if(dup?.length)throw Object.assign(new Error('そのユーザー名は使用されています'),{status:409});patch.username=name;}
      if(b.newPassword!==undefined){const pw=String(b.newPassword);if(pw.length<8)throw Object.assign(new Error('パスワードは8文字以上です'),{status:400});patch.password_hash=hash(pw);}
      if(b.profile!==undefined)patch.profile=String(b.profile).slice(0,2000);
      if(b.icon_url!==undefined)patch.icon_url=String(b.icon_url).slice(0,2000);
      if(b.cover_url!==undefined)patch.cover_url=String(b.cover_url).slice(0,2000);
      if(b.program_urls!==undefined){if(!Array.isArray(b.program_urls)||b.program_urls.length>10)throw Object.assign(new Error('program_urls が不正です'),{status:400});patch.program_urls=b.program_urls.map(x=>String(x).slice(0,2000));}
      if(b.profile_music!==undefined)patch.profile_music=b.profile_music;
      if(b.settings!==undefined){const existing=u.settings&&typeof u.settings==='object'?u.settings:{};patch.settings={...existing,...b.settings};}
      if(!Object.keys(patch).length)throw Object.assign(new Error('変更内容がありません'),{status:400});
      const rows=await sb(`users?id=eq.${encodeURIComponent(u.id)}`,{method:'PATCH',body:JSON.stringify(patch)});
      return res.status(200).json({ok:true,user:rows?.[0]?safe(rows[0]):null,message:'アカウント情報を更新しました'});
    }

    if(action==='user-login-streak'){
      const u=await auth(b);const now=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Tokyo'}));const day=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;const last=u.last_login_date?String(u.last_login_date).slice(0,10):null;let streak=Number(u.login_streak||0),bonus=0;
      if(last===day)return res.status(200).json({ok:true,awarded:false,streak,points:Number(u.points||0),bonus:0});
      if(last){const prev=new Date(now);prev.setDate(prev.getDate()-1);const prevDay=`${prev.getFullYear()}-${String(prev.getMonth()+1).padStart(2,'0')}-${String(prev.getDate()).padStart(2,'0')}`;streak=last===prevDay?streak+1:1}else streak=1;
      bonus=5+(streak%7===0?10:0);const points=Number(u.points||0)+bonus;await sb(`users?id=eq.${encodeURIComponent(u.id)}`,{method:'PATCH',body:JSON.stringify({login_streak:streak,last_login_date:day,points})});
      return res.status(200).json({ok:true,awarded:true,streak,points,bonus});
    }
    if(action==='stamp-purchase'){
      const u=await auth(b);const amount=Number(b.amount),url=String(b.stampUrl||'');if(!Number.isFinite(amount)||amount<1||!url||url.length>2000)throw Object.assign(new Error('スタンプ購入情報が不正です'),{status:400});
      const points=Number(u.points||0);if(points<amount)throw Object.assign(new Error('ポイントが足りません'),{status:400});const stamps=Array.isArray(u.stamp_list)?u.stamp_list:[];
      const rows=await sb(`users?id=eq.${encodeURIComponent(u.id)}`,{method:'PATCH',body:JSON.stringify({points:points-amount,stamp_list:[...stamps,url]})});
      return res.status(200).json({ok:true,points:points-amount,stamp_list:[...stamps,url]});
    }
    if(action==='transfer-points'){
      const u=await auth(b);const targetId=String(b.targetUserId||''),amount=Number(b.amount);if(!targetId||!Number.isFinite(amount)||amount<1||amount>1000)throw Object.assign(new Error('送信ポイントが不正です'),{status:400});if(targetId===u.id)throw Object.assign(new Error('自分には送信できません'),{status:400});if(Number(u.points||0)<amount)throw Object.assign(new Error('ポイントが足りません'),{status:400});
      const targets=await sb(`users?select=id,points& id=eq.${encodeURIComponent(targetId)}&limit=1`.replace('& id=','&id='));const target=targets?.[0];if(!target)throw Object.assign(new Error('相手ユーザーが見つかりません'),{status:404});
      await sb(`users?id=eq.${encodeURIComponent(u.id)}`,{method:'PATCH',body:JSON.stringify({points:Number(u.points||0)-amount})});await sb(`users?id=eq.${encodeURIComponent(targetId)}`,{method:'PATCH',body:JSON.stringify({points:Number(target.points||0)+amount})});
      return res.status(200).json({ok:true,points:Number(u.points||0)-amount});
    }
    if(action==='weekly-points'){
      const u=await auth(b);const jst=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Tokyo'}));
      const isoWeek=d=>{const x=new Date(d);x.setHours(0,0,0,0);x.setDate(x.getDate()+3-(x.getDay()+6)%7);const y=new Date(x.getFullYear(),0,4);return x.getFullYear()+'-W'+String(1+Math.round(((x-y)/86400000-3+(y.getDay()+6)%7)/7)).padStart(2,'0')};
      const week=isoWeek(jst),prev=isoWeek(new Date(jst.getTime()-7*86400000)),last=u.last_post_week||null;let streak=Number(u.consecutive_post_weeks||0),awarded=false;
      if(last!==week){streak=last===prev?streak+1:1;awarded=true;}
      const bonus=awarded?30*streak:0,points=Number(u.points||0)+bonus;
      const rows=await sb(`users?id=eq.${encodeURIComponent(u.id)}`,{method:'PATCH',body:JSON.stringify({points,consecutive_post_weeks:streak,last_post_week:week})});
      return res.status(200).json({ok:true,awarded,points,streak,bonus,user:rows?.[0]?safe(rows[0]):null});
    }
    if(action==='user-settings'){
      const u=await auth(b,{checkBan:false});
      const allowed=['home_chat_enabled','home_chat_width','chat_sound_enabled','chat_theme'];
      const settings={};for(const key of allowed){if(Object.prototype.hasOwnProperty.call(b.settings||{},key))settings[key]=b.settings[key];}
      if(!Object.keys(settings).length)throw Object.assign(new Error('設定がありません'),{status:400});
      const rows=await sb(`users?id=eq.${encodeURIComponent(u.id)}`,{method:'PATCH',body:JSON.stringify({settings:{...(u.settings||{}),...settings}})});
      return res.status(200).json({ok:true,settings:rows?.[0]?.settings||{...(u.settings||{}),...settings}});
    }
    if(action==='account-delete'){
      const u=await auth(b,{checkBan:false});
      await sb(`users?id=eq.${encodeURIComponent(u.id)}`,{method:'DELETE'});
      return res.status(200).json({ok:true,message:'アカウントを削除しました'});
    }
    if(action==='admin-user-update'){
      const actor=await auth(b,{checkBan:false});if(!['admin','developer'].includes(actor.role))throw Object.assign(new Error('管理者権限が必要です'),{status:403});
      const target=String(b.targetUserId||'');if(!target)throw Object.assign(new Error('対象ユーザーが必要です'),{status:400});const patch={};
      if(b.role!==undefined){if(!['user','admin','developer'].includes(b.role))throw Object.assign(new Error('role が不正です'),{status:400});patch.role=b.role;}
      if(b.verified!==undefined)patch.verified=!!b.verified;
      if(b.banUntil!==undefined)patch.ban_until=b.banUntil;
      if(b.deleteAccount===true){await sb(`users?id=eq.${encodeURIComponent(target)}`,{method:'DELETE'});return res.status(200).json({ok:true,message:'ユーザーを削除しました'});}
      if(!Object.keys(patch).length)throw Object.assign(new Error('変更内容がありません'),{status:400});
      const rows=await sb(`users?id=eq.${encodeURIComponent(target)}`,{method:'PATCH',body:JSON.stringify(patch)});
      return res.status(200).json({ok:true,user:rows?.[0]?safe(rows[0]):null});
    }
    if(action==='report'){
      const u=await auth(b); const message=String(b.message||'').trim();if(!message||message.length>2000)throw Object.assign(new Error('報告内容を入力してください'),{status:400});
      await sb('gather_reports',{method:'POST',body:JSON.stringify({user_id:u.id,username:u.username,content:message})});
      return res.status(201).json({ok:true,message:'報告を送信しました'});
    }

    if(action==='ban'){
      const actor=await auth(b,{checkBan:false}); if(!['admin','developer'].includes(actor.role))throw Object.assign(new Error('BAN権限がありません'),{status:403});
      const targetId=String(b.targetUserId||''), dh=deviceHash(b.deviceHash);if(!targetId)throw Object.assign(new Error('対象ユーザーが必要です'),{status:400});
      const duplicate=await sb(`chat_device_bans?select=id&actor_user_id=eq.${encodeURIComponent(actor.id)}&target_user_id=eq.${encodeURIComponent(targetId)}&actor_device_hash=eq.${dh}&ban_date=eq.${today()}&limit=1`);
      if(duplicate?.length)throw Object.assign(new Error('この端末からこのユーザーへの本日のBANは実行済みです'),{status:409});
      const targetUsers=await sb(`users?select=id,ban_count,points& id=eq.${encodeURIComponent(targetId)}&limit=1`.replace('& id=','&id='));
      const target=targetUsers?.[0];if(!target)throw Object.assign(new Error('対象ユーザーが見つかりません'),{status:404});
      const targetDevices=await sb(`user_devices?select=device_hash&user_id=eq.${encodeURIComponent(targetId)}`);
      const targetHashes=[...new Set((targetDevices||[]).map(x=>x.device_hash).filter(Boolean))];
      if(!targetHashes.length)throw Object.assign(new Error('対象ユーザーの端末情報がありません。対象ユーザーが再ログインしてから実行してください'),{status:409});
      const banCount=Number(target.ban_count||0)+1;const minutes=Number(b.banMinutes)||5*banCount;
      const banUntil=b.banUntil||new Date(Date.now()+Math.max(1,minutes)*60*1000).toISOString();
      await sb(`users?id=eq.${encodeURIComponent(targetId)}`,{method:'PATCH',body:JSON.stringify({ban_count:banCount,ban_until:banUntil,points:Math.max(0,Number(target.points||0)-100)})});
      await sb('chat_device_bans',{method:'POST',body:JSON.stringify(targetHashes.map(target_device_hash=>({actor_user_id:actor.id,target_user_id:targetId,actor_device_hash:dh,target_device_hash,ban_date:today(),ban_until:banUntil}))});
      return res.status(200).json({ok:true,message:'対象ユーザーの登録端末をBANしました',banUntil,minutes});
    }

    if(action==='dm-list'||action==='dm-send'){
      // Intentionally require username + password on every DM operation. No browser-only session token is accepted.
      const u=await auth(b); const table='messages';
      if(action==='dm-list'){
        const peer=String(b.withUserId||'');
        const filter=peer?`&or=(and(sender_id.eq.${encodeURIComponent(u.id)},receiver_id.eq.${encodeURIComponent(peer)}),and(sender_id.eq.${encodeURIComponent(peer)},receiver_id.eq.${encodeURIComponent(u.id)}))`:`&or=(sender_id.eq.${encodeURIComponent(u.id)},receiver_id.eq.${encodeURIComponent(u.id)})`;
        const order=peer?'asc':'desc';
        const rows=await sb(`${table}?select=id,sender_id,receiver_id,content,created_at${filter}&order=created_at.${order}&limit=200`);
        return res.status(200).json({ok:true,messages:rows||[]});
      }
      const recipient=String(b.recipientId||''),content=String(b.content||'').trim();if(!recipient||!content||content.length>5000)throw Object.assign(new Error('宛先またはメッセージが不正です'),{status:400});
      const rows=await sb(table,{method:'POST',body:JSON.stringify({sender_id:u.id,receiver_id:recipient,content})});
      return res.status(201).json({ok:true,message:rows?.[0]||null});
    }
    if(action==='post-view'){
      const u=await auth(b);const id=String(b.postId||'');if(!id)throw Object.assign(new Error('postId が必要です'),{status:400});
      const found=await sb(`posts?select=id,user_id,views&id=eq.${encodeURIComponent(id)}&limit=1`);const p=found?.[0];if(!p)throw Object.assign(new Error('投稿が見つかりません'),{status:404});
      if(p.user_id===u.id)return res.status(200).json({ok:true,views:Number(p.views||0)});
      const rows=await sb(`posts?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({views:Number(p.views||0)+1})});
      return res.status(200).json({ok:true,views:Number(rows?.[0]?.views??Number(p.views||0)+1)});
    }
    if(action==='chat-points'){
      const u=await auth(b);const amount=Number(b.amount);if(!Number.isInteger(amount)||amount===0||Math.abs(amount)>5000)throw Object.assign(new Error('ポイント数が不正です'),{status:400});
      const limits=await sb(`chat_point_limits?select=user_id,last_change_at&user_id=eq.${encodeURIComponent(u.id)}&limit=1`).catch(()=>[]);
      if(limits?.[0]&&Date.now()-new Date(limits[0].last_change_at).getTime()<3000)throw Object.assign(new Error('ポイント更新は少し待ってから再試行してください'),{status:429});
      const next=Math.max(0,Number(u.points||0)+amount);
      if(limits?.length)await sb(`chat_point_limits?user_id=eq.${encodeURIComponent(u.id)}`,{method:'PATCH',body:JSON.stringify({last_change_at:new Date().toISOString()})});
      else await sb('chat_point_limits',{method:'POST',body:JSON.stringify({user_id:u.id,last_change_at:new Date().toISOString()})});
      await sb(`users?id=eq.${encodeURIComponent(u.id)}`,{method:'PATCH',body:JSON.stringify({points:next})});
      return res.status(200).json({ok:true,points:next});
    }
    if(action==='image-register'){
      const u=await auth(b);const imageUrl=String(b.imageUrl||''),deleteUrl=b.deleteUrl?String(b.deleteUrl):null;
      if(!/^https:\/\/(i\.)?ibb\.co\//i.test(imageUrl)&&!/^https:\/\/(i\.)?ibb\.co\//i.test(imageUrl))throw Object.assign(new Error('ImgBB画像URLが不正です'),{status:400});
      if(deleteUrl&&!/^https:\/\/ibb\.co\//i.test(deleteUrl)&&!/^https:\/\/api\.imgbb\.com\//i.test(deleteUrl))throw Object.assign(new Error('ImgBB削除URLが不正です'),{status:400});
      await sb('chat_image_assets',{method:'POST',body:JSON.stringify({user_id:u.id,image_url:imageUrl,delete_url:deleteUrl})});
      return res.status(201).json({ok:true});
    }
    if(action==='db-mutate'){
      const u=await auth(b);const table=String(b.table||''),method=String(b.method||'').toUpperCase();
      const query=String(b.query||'');const params=new URLSearchParams(query.startsWith('?')?query.slice(1):query);
      const isAdmin=['admin','developer'].includes(u.role);
      // Post view count is the only generic posts update permitted; the server increments it itself.
      if(table==='posts'&&method==='PATCH'&&b.body&&Object.keys(b.body).length===1&&Object.prototype.hasOwnProperty.call(b.body,'views')){
        const idFilter=params.get('id')||'';const match=idFilter.match(/^eq\.(.+)$/);if(!match)throw Object.assign(new Error('投稿IDが必要です'),{status:400});
        const id=decodeURIComponent(match[1]);const found=await sb(`posts?select=id,views&id=eq.${encodeURIComponent(id)}&limit=1`);if(!found?.[0])throw Object.assign(new Error('投稿が見つかりません'),{status:404});
        const changed=await sb(`posts?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({views:Number(found[0].views||0)+1})});
        return res.status(200).json({ok:true,data:changed||[],contentRange:'*/1'});
      }
      const allowed=new Set(['likes','reposts','bookmarks','follows','replies','poll_votes','notifications','reports']);
      if(!allowed.has(table)||!['POST','PATCH','PUT','DELETE'].includes(method))throw Object.assign(new Error('このテーブルの直接変更は禁止されています'),{status:403});
      const ownerField={likes:'user_id',reposts:'user_id',bookmarks:'user_id',follows:'follower_id',replies:'user_id',poll_votes:'user_id',notifications:'user_id',reports:'reporter_id'}[table];
      let rows=Array.isArray(b.body)?b.body:[b.body].filter(Boolean);
      if(method==='POST'||method==='PUT'){
        if(!rows.length)throw Object.assign(new Error('変更データが空です'),{status:400});
        if(params.has('on_conflict'))throw Object.assign(new Error('直接 upsert は許可されていません'),{status:403});
        for(const row of rows){
          if(table==='notifications'){
            if(String(row.actor_id||'')!==u.id||String(row.user_id||'')===u.id)throw Object.assign(new Error('通知の作成者または宛先が不正です'),{status:403});
            const type=String(row.type||'');if(!['like','repost','reply','reply_reply','post','follow','poll'].includes(type))throw Object.assign(new Error('通知タイプが不正です'),{status:400});
            let related=false;
            if(type==='follow'||type==='post'){
              const rel=await sb(`follows?select=id&follower_id=eq.${encodeURIComponent(row.user_id)}&following_id=eq.${encodeURIComponent(u.id)}&limit=1`);related=!!rel?.length;
            }else if(row.post_id){
              const rel=await sb(`posts?select=user_id&id=eq.${encodeURIComponent(row.post_id)}&limit=1`);
              if(rel?.length&&['like','repost','poll'].includes(type))related=String(rel[0].user_id)===String(row.user_id);
              if(rel?.length&&['reply','reply_reply'].includes(type)){
                const reply=await sb(`replies?select=id&post_id=eq.${encodeURIComponent(row.post_id)}&user_id=eq.${encodeURIComponent(row.user_id)}&limit=1`);related=!!reply?.length||String(rel[0].user_id)===String(row.user_id);
              }
            }
            if(!related)throw Object.assign(new Error('通知の宛先と対象データが一致しません'),{status:403});
          }else if(table==='reports'){
            if(String(row.reporter_id||'')!==u.id)throw Object.assign(new Error('通報者が一致しません'),{status:403});
            if(!String(row.reason||'').trim()||String(row.reason).length>2000)throw Object.assign(new Error('通報理由が不正です'),{status:400});
          }else if(String(row[ownerField]||'')!==u.id)throw Object.assign(new Error('自分のデータだけ変更できます'),{status:403});
        }
      }else{
        // Fetch the affected rows with service role, then authorize every row before mutation.
        const filters=new URLSearchParams();for(const [k,v] of params.entries())if(!['select','order','limit','offset','on_conflict'].includes(k))filters.append(k,v);
        filters.set('select','*');filters.set('limit','1000');
        const existing=await sb(`${table}?${filters.toString()}`);
        if(!Array.isArray(existing))throw Object.assign(new Error('対象データを確認できません'),{status:400});
        for(const row of existing){
          if(table==='reports'){
            if(!isAdmin&&String(row.reporter_id||'')!==u.id)throw Object.assign(new Error('通報データを変更する権限がありません'),{status:403});
            if(method==='PATCH'&&!isAdmin)throw Object.assign(new Error('通報状態を変更できません'),{status:403});
          }else if(table==='notifications'){
            if(String(row.user_id||'')!==u.id)throw Object.assign(new Error('他人の通知は変更できません'),{status:403});
          }else if(String(row[ownerField]||'')!==u.id&&!isAdmin)throw Object.assign(new Error('他人のデータは変更できません'),{status:403});
        }
        // Avoid allowing arbitrary notification content or report escalation through update.
        if(table==='notifications'&&method==='PATCH'){
          const patch=b.body||{};if(Object.keys(patch).some(k=>!['read','is_read','seen'].includes(k)))throw Object.assign(new Error('通知の変更項目が不正です'),{status:403});
        }
        if(table==='reports'&&method==='PATCH'&&!isAdmin)throw Object.assign(new Error('管理者権限が必要です'),{status:403});
      }
      // Limit report status updates to server-verified admins and never allow user identity fields to be changed.
      if(table==='reports'&&method==='PATCH'&&!isAdmin)throw Object.assign(new Error('管理者権限が必要です'),{status:403});
      const q= query.startsWith('?')?query.slice(1):query;
      const path=`${table}${q?`?${q}`:''}`;
      const headers={};if(b.prefer)headers.Prefer=b.prefer;
      const data=await sb(path,{method,headers,body:(method==='DELETE'?undefined:JSON.stringify(b.body))});
      return res.status(200).json({ok:true,data:data===undefined?null:data,contentRange:Array.isArray(data)?`*/${data.length}`:'*/0'});
    }
    throw Object.assign(new Error('未対応の action です'),{status:400});
  }catch(e){return res.status(e.status||500).json({ok:false,error:e.message||'サーバーエラー'});}
}
