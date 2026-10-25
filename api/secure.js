const { createClient } = require("@supabase/supabase-js");
const crypto = require("node:crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const IP_HASH_SECRET = process.env.IP_HASH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const POSTHOG_PROJECT_KEY = process.env.POSTHOG_PROJECT_KEY || "";
const SESSION_SECRET = process.env.SESSION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const POSTHOG_API_HOST = (process.env.POSTHOG_API_HOST || "https://us.i.posthog.com").replace(/\/$/, "");
const IP_RATE_LIMIT = Math.max(20, Number(process.env.IP_RATE_LIMIT || 120));
const IP_RATE_WINDOW_SECONDS = Math.max(60, Number(process.env.IP_RATE_WINDOW_SECONDS || 300));
const IP_BLOCK_SECONDS = Math.max(60, Number(process.env.IP_BLOCK_SECONDS || 3600));

function getClientIp(req) {
  // Vercel が付与する接続元IPを優先。クライアントのJSON本文からIPを受け取らない。
  const real = req.headers["x-real-ip"];
  const forwarded = req.headers["x-forwarded-for"];
  const raw = (Array.isArray(real) ? real[0] : real) ||
    (Array.isArray(forwarded) ? forwarded[0] : String(forwarded || "").split(",")[0]);
  const ip = String(raw || "").trim().replace(/^\[|\]$/g, "");
  if (!ip || ip.length > 100 || !/^[0-9a-fA-F:.%a-zA-Z0-9_-]+$/.test(ip)) {
    throw Object.assign(new Error("接続元IPを確認できません。Vercelのx-real-ip設定を確認してください"), { status: 503 });
  }
  return ip;
}
function hashIp(ip) {
  if (!IP_HASH_SECRET) throw Object.assign(new Error("IP_HASH_SECRET が未設定です"), { status: 503 });
  return sha256(IP_HASH_SECRET + ":" + String(ip).trim().toLowerCase());
}
async function sendPostHogSecurityEvent(event, ip, props = {}) {
  if (!POSTHOG_PROJECT_KEY || typeof fetch !== "function") return;
  try {
    await fetch(POSTHOG_API_HOST + "/capture/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: POSTHOG_PROJECT_KEY,
        event,
        distinct_id: "chanpro-server-security",
        properties: {
          $ip: ip,
          $process_person_profile: false,
          event_source: "chanpro-vercel-secure",
          ...props
        }
      }),
      signal: AbortSignal.timeout(2500)
    });
  } catch (e) {
    // Analytics outage must not disable authentication or rate limiting.
    console.warn("PostHog security event could not be sent:", e?.message || e);
  }
}
async function checkIpBan(db, ipHash, ip, action) {
  const { data, error } = await db.from("banned_ip_addresses")
    .select("reason,expires_at").eq("ip_hash", ipHash).maybeSingle();
  if (error) throw error;
  if (data && (!data.expires_at || new Date(data.expires_at).getTime() > Date.now())) {
    await sendPostHogSecurityEvent("chanpro_ip_banned_request", ip, { ip_hash: ipHash, action, reason: data.reason || "IP BAN" });
    throw Object.assign(new Error(data.reason || "このIPアドレスからのアクセスは禁止されています"), { status: 403 });
  }
}

async function enforceIpRateLimit(db, ipHash) {
  const { data, error } = await db.rpc("guard_ip_request", {
    p_ip_hash: ipHash,
    p_limit: IP_RATE_LIMIT,
    p_window_seconds: IP_RATE_WINDOW_SECONDS,
    p_block_seconds: IP_BLOCK_SECONDS
  });
  if (error) {
    console.error("IP rate-limit RPC failed:", error.message || error);
    throw Object.assign(new Error("IP制限の確認に失敗しました。SupabaseのセキュリティSQLを適用してください"), { status: 503 });
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (row?.blocked) {
    throw Object.assign(new Error(`アクセスが集中したため、このIPからのAPIアクセスを一時停止しています。約${Math.max(1, Math.ceil(Number(row.retry_after_seconds || 3600) / 60))}分後に再試行してください`), { status: 429, retryAfter: Number(row.retry_after_seconds || 3600), ipBlocked: true });
  }
}

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.end(JSON.stringify(body));
}
function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function signSession(user) {
  if (!SESSION_SECRET) throw Object.assign(new Error("SESSION_SECRET が未設定です"), { status: 503 });
  const payload = Buffer.from(JSON.stringify({
    sub: String(user.id), username: String(user.username || ""),
    exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
    iss: "chanpro-gather"
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return payload + "." + signature;
}
function readSession(req) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || !SESSION_SECRET) throw Object.assign(new Error("ログイン状態が切れました。再ログインしてください"), { status: 401 });
  const parts = token.split(".");
  if (parts.length !== 2) throw Object.assign(new Error("セッションが無効です"), { status: 401 });
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(parts[0]).digest("base64url");
  if (!safeEqual(expected, parts[1])) throw Object.assign(new Error("セッションが無効です"), { status: 401 });
  let data;
  try { data = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); } catch (_) {
    throw Object.assign(new Error("セッションが無効です"), { status: 401 });
  }
  if (data.iss !== "chanpro-gather" || !data.sub || Number(data.exp) <= Math.floor(Date.now() / 1000)) {
    throw Object.assign(new Error("セッションの有効期限が切れました。再ログインしてください"), { status: 401 });
  }
  return data;
}
async function authenticateSession(db, req) {
  const session = readSession(req);
  const { data: user, error } = await db.from("users")
    .select("id,username,password_hash,role,verified,ban_until,icon_url,cover_url,profile,settings,program_urls,program_views,program_likes,profile_music,points,stamp_list,login_streak,last_login_date")
    .eq("id", session.sub).maybeSingle();
  if (error) throw error;
  if (!user) throw Object.assign(new Error("ユーザーが見つかりません。再ログインしてください"), { status: 401 });
  if (user.ban_until && new Date(user.ban_until).getTime() > Date.now()) {
    throw Object.assign(new Error("このアカウントはBANされています"), { status: 403 });
  }
  delete user.password_hash;
  return { user };
}
function client(req) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Vercel環境変数が設定されていません");
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
}
function credentials(body) {
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!username || !password) throw Object.assign(new Error("ユーザー名とパスワードを入力してください"), { status: 400 });
  if (username.length > 100 || password.length > 1024) throw Object.assign(new Error("入力が長すぎます"), { status: 400 });
  return { username, password };
}
async function authenticate(db, body, { allowBanned = false } = {}) {
  const { username, password } = credentials(body);
  const { data: user, error } = await db.from("users")
    .select("id,username,password_hash,role,verified,ban_until,icon_url,cover_url,profile,settings,program_urls,program_views,program_likes,profile_music,points,stamp_list,login_streak,last_login_date")
    .eq("username", username).maybeSingle();
  if (error) throw error;
  if (!user || !safeEqual(user.password_hash, sha256(password))) {
    throw Object.assign(new Error("ユーザー名またはパスワードが違います"), { status: 401 });
  }
  if (!allowBanned && user.ban_until && new Date(user.ban_until).getTime() > Date.now()) {
    throw Object.assign(new Error("このアカウントはBANされています"), { status: 403 });
  }
  return { user, password };
}
async function checkDeviceBan(db, deviceHash) {
  if (!deviceHash) return;
  const { data, error } = await db.from("banned_devices").select("id,reason").eq("device_hash", deviceHash).maybeSingle();
  if (error) throw error;
  if (data) throw Object.assign(new Error(data.reason || "この端末は使用できません"), { status: 403 });
}
const ownUserFields = [
  "icon_url", "cover_url", "profile", "program_urls", "profile_music"
];
const settingFields = [
  "home_chat_enabled", "manual_chat_join", "default_chat_room",
  "chat_sound_enabled", "chat_theme", "notification_volume"
];

module.exports = async (req, res) => {
  // User requested unrestricted CORS. This permits browser requests from any origin,
  // including file:// (Origin: null). Authentication/authorization must still be enforced below.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, apikey, x-client-info");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  try {
    const ip = getClientIp(req);
    const ipHash = hashIp(ip);
    const db = client(req);
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const action = String(body.action || "");
    // Explicit IP BAN and flood protection are checked server-side before any action.
    await checkIpBan(db, ipHash, ip, action);
    try {
      await enforceIpRateLimit(db, ipHash);
    } catch (limitError) {
      if (limitError.ipBlocked) await sendPostHogSecurityEvent("chanpro_ip_blocked", ip, { ip_hash: ipHash, action });
      throw limitError;
    }
    if (action === "check-ip") {
      return json(res, 200, { ok: true, ipCheck: "passed" });
    }
    if (action === "login" || action === "register") {
      const { username, password } = credentials(body);
      const deviceHash = String(body.deviceHash || "").trim();
      if (action === "register" && !/^[a-f0-9]{32,128}$/i.test(deviceHash)) {
        throw Object.assign(new Error("端末情報を確認できません。通常のブラウザで再試行してください"), { status: 400 });
      }
      await sendPostHogSecurityEvent(action === "register" ? "chanpro_registration_attempt" : "chanpro_login_attempt", ip, {
        ip_hash: ipHash, action, username, device_hash: deviceHash || undefined
      });
      await checkDeviceBan(db, deviceHash);
      if (action === "register") {
        if (username.length < 2 || password.length < 8) throw Object.assign(new Error("ユーザー名は2文字以上、パスワードは8文字以上にしてください"), { status: 400 });
        const { data, error } = await db.rpc("register_account_limited", {
          p_username: username,
          p_password_hash: sha256(password),
          p_device_hash: deviceHash,
          p_device_info: body.deviceInfo || {}
        });
        if (error) {
          if (/DEVICE_ACCOUNT_LIMIT/.test(error.message || "")) {
            throw Object.assign(new Error("この端末で作成できる新規アカウントは5個までです"), { status: 429 });
          }
          if (error.code === "23505") throw Object.assign(new Error("そのユーザー名は既に使用されています"), { status: 409 });
          throw error;
        }
        const user = data && typeof data === "object" ? data : null;
        if (!user?.id) throw new Error("新規アカウント作成の応答が不正です");
        delete user.password_hash;
        const { error: deviceError } = await db.from("user_devices").upsert({
          user_id: user.id, device_hash: deviceHash,
          device_info: body.deviceInfo || {}, last_login_at: new Date().toISOString()
        }, { onConflict: "user_id,device_hash" });
        if (deviceError) console.warn("user_devices の記録に失敗:", deviceError.message);
        await sendPostHogSecurityEvent("chanpro_registration_created", ip, {
          ip_hash: ipHash, user_id: String(user.id), username: String(user.username || ""), device_hash: deviceHash
        });
        return json(res, 200, { ok: true, user, token: signSession(user), isAdmin: false });
      }
      const { user } = await authenticate(db, body);
      if (deviceHash) {
        const { error } = await db.from("user_devices").upsert({
          user_id: user.id, device_hash: deviceHash,
          device_info: body.deviceInfo || {}, last_login_at: new Date().toISOString()
        }, { onConflict: "user_id,device_hash" });
        if (error) throw error;
      }
      delete user.password_hash;
      await sendPostHogSecurityEvent("chanpro_login_success", ip, {
        ip_hash: ipHash, user_id: String(user.id), username: String(user.username || ""), device_hash: deviceHash || undefined
      });
      return json(res, 200, { ok: true, user, token: signSession(user), isAdmin: ["admin", "developer"].includes(user.role) });
    }

    const { user } = await authenticateSession(db, req);
    const admin = ["admin", "developer"].includes(user.role);
    const payload = body.payload || {};
    switch (action) {
      case "post-create": {
        const content = String(payload.content || "");
        const imageUrl = payload.image_url == null ? null : String(payload.image_url);
        const quotePostId = payload.quote_post_id == null ? null : String(payload.quote_post_id);
        if (!content.trim() && !imageUrl && !quotePostId && !payload.poll) throw Object.assign(new Error("投稿内容を入力してください"), { status: 400 });
        if (content.length > 100000) throw Object.assign(new Error("投稿内容が長すぎます"), { status: 400 });
        if (imageUrl && imageUrl.length > 10000) throw Object.assign(new Error("画像URLが長すぎます"), { status: 400 });
        const isLimited = !!payload.is_limited && !!user.verified;
        const row = { user_id: user.id, content, image_url: imageUrl, is_limited: isLimited, quote_post_id: quotePostId, poll: payload.poll || null, views: 0 };
        const { data, error } = await db.from("posts").insert(row).select("*").single();
        if (error) throw error;
        return json(res, 200, { ok: true, post: data });
      }
      case "reply-create": {
        const postId = String(payload.post_id || "");
        const content = String(payload.content || "").trim();
        const parentReplyId = payload.parent_reply_id == null ? null : String(payload.parent_reply_id);
        if (!postId || !content) throw Object.assign(new Error("返信内容を入力してください"), { status: 400 });
        if (content.length > 20000) throw Object.assign(new Error("返信内容が長すぎます"), { status: 400 });
        const { data: post, error: postError } = await db.from("posts").select("id,user_id,is_limited").eq("id", postId).maybeSingle();
        if (postError) throw postError;
        if (!post) throw Object.assign(new Error("返信先の投稿が見つかりません"), { status: 404 });
        if (post.is_limited && post.user_id !== user.id && !admin) throw Object.assign(new Error("この限定投稿には返信できません"), { status: 403 });
        if (parentReplyId) {
          const { data: parent, error: parentError } = await db.from("replies").select("id,post_id").eq("id", parentReplyId).maybeSingle();
          if (parentError) throw parentError;
          if (!parent || String(parent.post_id) !== postId) throw Object.assign(new Error("返信先が見つかりません"), { status: 400 });
        }
        const row = { post_id: postId, user_id: user.id, content, parent_reply_id: parentReplyId };
        const { data, error } = await db.from("replies").insert(row).select("id,post_id,user_id,content,parent_reply_id,created_at").single();
        if (error) throw error;
        return json(res, 200, { ok: true, reply: data });
      }
      case "dm-list": {
        let q = db.from("messages").select("id,sender_id,receiver_id,content,created_at");
        q = payload.withUserId
          ? q.or(`and(sender_id.eq.${user.id},receiver_id.eq.${payload.withUserId}),and(sender_id.eq.${payload.withUserId},receiver_id.eq.${user.id})`).order("created_at", { ascending: true })
          : q.or(`sender_id.eq.${user.id},receiver_id.eq.${user.id}`).order("created_at", { ascending: false });
        const { data, error } = await q.limit(1000);
        if (error) throw error;
        return json(res, 200, { ok: true, messages: data || [] });
      }
      case "dm-send": {
        const recipientId = String(payload.recipientId || "");
        const content = String(payload.content || "").trim();
        if (!recipientId || !content || content.length > 10000) throw Object.assign(new Error("DMの内容を確認してください"), { status: 400 });
        const { data, error } = await db.from("messages").insert({ sender_id: user.id, receiver_id: recipientId, content }).select("id,sender_id,receiver_id,content,created_at").single();
        if (error) throw error;
        return json(res, 200, { ok: true, message: data });
      }
      case "user-update": {
        const patch = {};
        for (const key of ownUserFields) if (Object.prototype.hasOwnProperty.call(payload, key)) patch[key] = payload[key];
        if (Object.prototype.hasOwnProperty.call(payload, "settings")) {
          const settings = {};
          for (const key of settingFields) if (Object.prototype.hasOwnProperty.call(payload.settings || {}, key)) settings[key] = payload.settings[key];
          patch.settings = { ...(user.settings || {}), ...settings };
        }
        if (Object.prototype.hasOwnProperty.call(payload, "newUsername")) {
          const name = String(payload.newUsername || "").trim();
          if (name.length < 2 || name.length > 100) throw Object.assign(new Error("ユーザー名は2〜100文字にしてください"), { status: 400 });
          patch.username = name;
        }
        if (Object.prototype.hasOwnProperty.call(payload, "newPassword")) {
          const password = String(payload.newPassword || "");
          if (password.length < 8) throw Object.assign(new Error("パスワードは8文字以上にしてください"), { status: 400 });
          patch.password_hash = sha256(password);
        }
        if (!Object.keys(patch).length) throw Object.assign(new Error("変更内容がありません"), { status: 400 });
        const { data, error } = await db.from("users").update(patch).eq("id", user.id)
          .select("id,username,icon_url,cover_url,profile,role,verified,settings,program_urls,program_views,program_likes,profile_music,points,stamp_list,login_streak,last_login_date").single();
        if (error) throw error;
        return json(res, 200, { ok: true, user: data, message: "アカウント情報を更新しました" });
      }
      case "user-settings": {
        const settings = {};
        for (const key of settingFields) if (Object.prototype.hasOwnProperty.call(payload.settings || {}, key)) settings[key] = payload.settings[key];
        const { data, error } = await db.from("users").update({ settings: { ...(user.settings || {}), ...settings } }).eq("id", user.id).select("settings").single();
        if (error) throw error;
        return json(res, 200, { ok: true, settings: data.settings });
      }
      case "post-delete": {
        const { data: post, error: readError } = await db.from("posts").select("id,user_id").eq("id", payload.postId).maybeSingle();
        if (readError) throw readError;
        if (!post) throw Object.assign(new Error("投稿が見つかりません"), { status: 404 });
        if (post.user_id !== user.id && !admin) throw Object.assign(new Error("削除権限がありません"), { status: 403 });
        const { error } = await db.from("posts").delete().eq("id", post.id);
        if (error) throw error;
        return json(res, 200, { ok: true });
      }
      case "post-view": {
        const { data: post, error } = await db.from("posts").select("id,user_id,views").eq("id", payload.postId).maybeSingle();
        if (error) throw error;
        if (!post) throw Object.assign(new Error("投稿が見つかりません"), { status: 404 });
        if (post.user_id === user.id) return json(res, 200, { ok: true, views: Number(post.views || 0) });
        const views = Number(post.views || 0) + 1;
        const { error: updateError } = await db.from("posts").update({ views }).eq("id", post.id);
        if (updateError) throw updateError;
        return json(res, 200, { ok: true, views });
      }
      case "post-pin": {
        const { data: post, error } = await db.from("posts").select("id,user_id").eq("id", payload.postId).maybeSingle();
        if (error) throw error;
        if (!post) throw Object.assign(new Error("投稿が見つかりません"), { status: 404 });
        if (post.user_id !== user.id && !admin) throw Object.assign(new Error("権限がありません"), { status: 403 });
        if (payload.pinned) {
          const { error: clearError } = await db.from("posts").update({ is_pinned: false }).eq("user_id", post.user_id).eq("is_pinned", true);
          if (clearError) throw clearError;
        }
        const { error: updateError } = await db.from("posts").update({ is_pinned: !!payload.pinned }).eq("id", post.id);
        if (updateError) throw updateError;
        return json(res, 200, { ok: true, pinned: !!payload.pinned });
      }
      case "account-delete": {
        const { error } = await db.from("users").delete().eq("id", user.id);
        if (error) throw error;
        return json(res, 200, { ok: true });
      }
      case "stamp-purchase": {
        const amount = Number(payload.amount);
        const stampUrl = String(payload.stampUrl || "");
        if (!Number.isInteger(amount) || amount < 1 || amount > 100000 || Number(user.points || 0) < amount || !stampUrl) {
          throw Object.assign(new Error("スタンプ購入内容が不正です"), { status: 400 });
        }
        const stamps = Array.isArray(user.stamp_list) ? user.stamp_list : [];
        const { error } = await db.from("users").update({
          points: Number(user.points || 0) - amount, stamp_list: [...stamps, stampUrl]
        }).eq("id", user.id);
        if (error) throw error;
        return json(res, 200, { ok: true, points: Number(user.points || 0) - amount, stamp_list: [...stamps, stampUrl] });
      }
      case "transfer-points": {
        const targetUserId = String(payload.targetUserId || "");
        const amount = Number(payload.amount);
        if (!targetUserId || targetUserId === user.id || !Number.isInteger(amount) || amount < 1 || amount > 1000 || Number(user.points || 0) < amount) {
          throw Object.assign(new Error("ポイント送信内容が不正です"), { status: 400 });
        }
        const { data: target, error: targetError } = await db.from("users").select("id,points").eq("id", targetUserId).maybeSingle();
        if (targetError) throw targetError;
        if (!target) throw Object.assign(new Error("送信先が見つかりません"), { status: 404 });
        const { error: debitError } = await db.from("users").update({ points: Number(user.points || 0) - amount }).eq("id", user.id);
        if (debitError) throw debitError;
        const { error: creditError } = await db.from("users").update({ points: Number(target.points || 0) + amount }).eq("id", target.id);
        if (creditError) {
          await db.from("users").update({ points: Number(user.points || 0) }).eq("id", user.id);
          throw creditError;
        }
        return json(res, 200, { ok: true, points: Number(user.points || 0) - amount });
      }
      case "chat-points": {
        const amount = Number(payload.amount);
        if (!Number.isInteger(amount) || Math.abs(amount) > 5000) throw Object.assign(new Error("ポイント数が不正です"), { status: 400 });
        const points = Math.max(0, Number(user.points || 0) + amount);
        const { error } = await db.from("users").update({ points }).eq("id", user.id);
        if (error) throw error;
        return json(res, 200, { ok: true, points });
      }
      case "user-login-streak": {
        const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
        const last = String(user.last_login_date || "").slice(0, 10);
        if (last === today) return json(res, 200, { ok: true, awarded: false, streak: Number(user.login_streak || 0), points: Number(user.points || 0), bonus: 0 });
        const streak = last ? Number(user.login_streak || 0) + 1 : 1;
        const bonus = 5 + (streak % 7 === 0 ? 10 : 0);
        const points = Number(user.points || 0) + bonus;
        const { error } = await db.from("users").update({ login_streak: streak, last_login_date: today, points }).eq("id", user.id);
        if (error) throw error;
        return json(res, 200, { ok: true, awarded: true, streak, points, bonus });
      }
      case "weekly-points": {
        const now = new Date();
        const utc = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
        utc.setUTCDate(utc.getUTCDate() + 4 - (utc.getUTCDay() || 7));
        const year = utc.getUTCFullYear();
        const jan1 = new Date(Date.UTC(year, 0, 1));
        const week = `${year}-W${String(Math.ceil((((utc - jan1) / 86400000) + 1) / 7)).padStart(2, "0")}`;
        const lastWeek = String(user.last_post_week || "");
        const awarded = lastWeek !== week;
        const streak = awarded ? Number(user.consecutive_post_weeks || 0) + 1 : Number(user.consecutive_post_weeks || 0);
        const bonus = awarded ? 30 * streak : 0;
        const points = Number(user.points || 0) + bonus;
        const { error } = await db.from("users").update({ points, consecutive_post_weeks: streak, last_post_week: week }).eq("id", user.id);
        if (error) throw error;
        return json(res, 200, { ok: true, awarded, points, streak, week });
      }
      case "image-register": {
        const imageUrl = String(payload.imageUrl || "");
        if (!imageUrl || imageUrl.length > 5000) throw Object.assign(new Error("画像URLが不正です"), { status: 400 });
        const { error } = await db.from("chat_image_assets").insert({ user_id: user.id, image_url: imageUrl, delete_url: payload.deleteUrl || null });
        if (error) throw error;
        return json(res, 200, { ok: true });
      }
      case "report": {
        const message = String(payload.message || "").trim();
        if (!message || message.length > 5000) throw Object.assign(new Error("報告内容を入力してください"), { status: 400 });
        const { error } = await db.from("reports").insert({ user_id: user.id, message });
        if (error) throw error;
        return json(res, 200, { ok: true, message: "報告を送信しました" });
      }
      case "ban": {
        if (!admin) throw Object.assign(new Error("BAN権限がありません"), { status: 403 });
        const targetId = String(payload.targetUserId || "");
        const minutes = Math.max(1, Math.min(525600, Number(payload.banMinutes) || 5));
        const { data: target, error: targetError } = await db.from("users").select("id,ban_count,points").eq("id", targetId).maybeSingle();
        if (targetError) throw targetError;
        if (!target) throw Object.assign(new Error("対象ユーザーが見つかりません"), { status: 404 });
        const banUntil = new Date(Date.now() + minutes * 60000).toISOString();
        const { error } = await db.from("users").update({
          ban_count: Number(target.ban_count || 0) + 1,
          ban_until: banUntil,
          points: Math.max(0, Number(target.points || 0) - 100)
        }).eq("id", targetId);
        if (error) throw error;
        return json(res, 200, { ok: true, banUntil });
      }
      case "admin-user-update": {
        if (!admin) throw Object.assign(new Error("管理者権限が必要です"), { status: 403 });
        const targetId = String(payload.targetUserId || "");
        const patch = {};
        for (const key of ["role", "verified", "ban_until", "ban_count", "points"]) if (Object.prototype.hasOwnProperty.call(payload, key)) patch[key] = payload[key];
        if (!targetId || !Object.keys(patch).length) throw Object.assign(new Error("変更内容を確認してください"), { status: 400 });
        const { error } = await db.from("users").update(patch).eq("id", targetId);
        if (error) throw error;
        return json(res, 200, { ok: true });
      }
      case "ip-ban": {
        if (!admin) throw Object.assign(new Error("管理者権限が必要です"), { status: 403 });
        const rawIp = String(payload.ipAddress || "").trim();
        if (!rawIp || rawIp.length > 100 || !/^[0-9a-fA-F:.%a-zA-Z0-9_-]+$/.test(rawIp)) {
          throw Object.assign(new Error("IPアドレスの形式が不正です"), { status: 400 });
        }
        const minutes = Math.max(1, Math.min(525600, Number(payload.minutes) || 60));
        const { error } = await db.from("banned_ip_addresses").upsert({
          ip_hash: hashIp(rawIp), reason: String(payload.reason || "管理者によるIP BAN").slice(0, 300),
          expires_at: new Date(Date.now() + minutes * 60000).toISOString(), created_by: user.id
        }, { onConflict: "ip_hash" });
        if (error) throw error;
        return json(res, 200, { ok: true, expiresAt: new Date(Date.now() + minutes * 60000).toISOString() });
      }
      case "ip-unban": {
        if (!admin) throw Object.assign(new Error("管理者権限が必要です"), { status: 403 });
        const rawIp = String(payload.ipAddress || "").trim();
        if (!rawIp || rawIp.length > 100 || !/^[0-9a-fA-F:.%a-zA-Z0-9_-]+$/.test(rawIp)) {
          throw Object.assign(new Error("IPアドレスの形式が不正です"), { status: 400 });
        }
        const { error } = await db.from("banned_ip_addresses").delete().eq("ip_hash", hashIp(rawIp));
        if (error) throw error;
        return json(res, 200, { ok: true });
      }
      default:
        return json(res, 400, { error: "未対応のAPI操作です", action });
    }
  } catch (error) {
    console.error("secure API error:", error.message || error);
    if (error.retryAfter) res.setHeader("Retry-After", String(error.retryAfter));
    return json(res, error.status || 500, { error: error.message || "サーバー処理に失敗しました", retryAfter: error.retryAfter || undefined });
  }
};
