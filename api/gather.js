import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const db = () => {
  if (!supabaseUrl || !serviceKey) throw new Error("Vercel環境変数 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です");
  return createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
};
const hashPassword = (p) => crypto.createHash("sha256").update(String(p), "utf8").digest("hex");
const admin = (u) => ["admin", "developer"].includes(u?.role);
const publicUser = (u) => {
  const { password_hash, ...safe } = u;
  return safe;
};
const fail = (res, status, error) => res.status(status).json({ ok: false, error });

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") return fail(res, 405, "POSTのみ対応しています");
  const body = req.body || {};
  const action = String(body.action || "");
  try {
    const supabase = db();
    if (action === "device-check") {
      if (!body.deviceHash || !/^[a-f0-9]{64}$/i.test(String(body.deviceHash))) return fail(res, 400, "端末情報が不正です");
      const { data, error } = await supabase.from("banned_devices").select("id,reason").eq("device_hash", body.deviceHash).limit(1);
      if (error && error.code !== "PGRST116") throw error;
      if (data?.length) return res.status(200).json({ ok: true, banned: true, reason: data[0].reason || "この端末は使用できません" });
      const { data: chatBans, error: banErr } = await supabase.from("chat_device_bans").select("id,ban_until").eq("target_device_hash", body.deviceHash).gt("ban_until", new Date().toISOString()).limit(1);
      if (banErr && !["42P01","42703"].includes(banErr.code)) throw banErr;
      return res.status(200).json({ ok: true, banned: !!chatBans?.length, reason: chatBans?.length ? "この端末はBANされています" : null });
    }
    if (action === "login" || action === "register") {
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      const deviceHash = String(body.deviceHash || "");
      if (!username || !password) return fail(res, 400, "ユーザー名とパスワードを入力してください");
      if (action === "register" && (username.length < 2 || password.length < 8)) return fail(res, 400, "ユーザー名は2文字以上、パスワードは8文字以上にしてください");
      if (!deviceHash || !/^[a-f0-9]{64}$/i.test(deviceHash)) return fail(res, 403, "端末情報を確認できません");
      const { data: bannedDevices, error: deviceErr } = await supabase.from("banned_devices").select("id,reason").eq("device_hash", deviceHash).limit(1);
      if (deviceErr && !["PGRST116"].includes(deviceErr.code)) throw deviceErr;
      if (bannedDevices?.length) return fail(res, 403, bannedDevices[0].reason || "この端末は使用できません");
      if (action === "register") {
        const { data: existing, error: existsErr } = await supabase.from("users").select("id").eq("username", username).maybeSingle();
        if (existsErr) throw existsErr;
        if (existing) return fail(res, 409, "そのユーザー名はすでに使用されています");
        const { data: created, error } = await supabase.from("users").insert({
          username, password_hash: hashPassword(password), ban_count: 0, ban_until: null,
          icon_url: "", profile: "", role: "user", points: 0, stamp_list: []
        }).select("*").single();
        if (error) throw error;
        await recordDevice(supabase, created.id, deviceHash, body.deviceInfo);
        return res.status(200).json({ ok: true, user: publicUser(created), passwordHash: created.password_hash, isAdmin: false });
      }
      const { data: user, error } = await supabase.from("users").select("*").eq("username", username).eq("password_hash", hashPassword(password)).maybeSingle();
      if (error) throw error;
      if (!user) return fail(res, 401, "ユーザー名またはパスワードが違います");
      if (user.ban_until && new Date(user.ban_until).getTime() > Date.now()) return fail(res, 403, "このアカウントはBANされています");
      const { data: chatBans, error: banErr } = await supabase.from("chat_device_bans").select("id,ban_until").eq("target_device_hash", deviceHash).gt("ban_until", new Date().toISOString()).limit(1);
      if (banErr && !["42P01","42703"].includes(banErr.code)) throw banErr;
      if (chatBans?.length) return fail(res, 403, "この端末はBANされています");
      await recordDevice(supabase, user.id, deviceHash, body.deviceInfo);
      return res.status(200).json({ ok: true, user: publicUser(user), passwordHash: user.password_hash, isAdmin: admin(user) });
    }
    // Every secure action below verifies the username+password again.
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const payload = body.payload || {};
    if (!username || !password) return fail(res, 401, "ユーザー名とパスワードが必要です");
    const { data: user, error: authErr } = await supabase.from("users").select("*").eq("username", username).eq("password_hash", hashPassword(password)).maybeSingle();
    if (authErr) throw authErr;
    if (!user) return fail(res, 401, "認証に失敗しました");
    if (user.ban_until && new Date(user.ban_until).getTime() > Date.now() && !admin(user)) return fail(res, 403, "このアカウントはBANされています");
    const isAdmin = admin(user);
    const uid = user.id;
    const err = (e) => { if (e) throw e; };

    if (action === "dm-list") {
      let q = supabase.from("messages").select("id,sender_id,receiver_id,content,created_at");
      q = payload.withUserId
        ? q.or(`and(sender_id.eq.${uid},receiver_id.eq.${payload.withUserId}),and(sender_id.eq.${payload.withUserId},receiver_id.eq.${uid})`).order("created_at", { ascending: true })
        : q.or(`sender_id.eq.${uid},receiver_id.eq.${uid}`).order("created_at", { ascending: false });
      const { data, error } = await q.limit(200); err(error);
      return res.status(200).json({ ok: true, messages: data || [] });
    }
    if (action === "dm-send") {
      const recipientId = String(payload.recipientId || "");
      const content = String(payload.content || "").trim();
      if (!recipientId || !content || content.length > 10000) return fail(res, 400, "宛先または本文が不正です");
      const { data, error } = await supabase.from("messages").insert({ sender_id: uid, receiver_id: recipientId, content }).select("id,sender_id,receiver_id,content,created_at").single();
      err(error); return res.status(200).json({ ok: true, message: data });
    }
    if (action === "user-update" || action === "user-settings") {
      const updates = {};
      if (action === "user-update") {
        if (payload.newUsername !== undefined) updates.username = String(payload.newUsername).trim();
        if (payload.newPassword !== undefined) {
          if (String(payload.newPassword).length < 8) return fail(res, 400, "パスワードは8文字以上にしてください");
          updates.password_hash = hashPassword(payload.newPassword);
        }
        for (const k of ["icon_url","cover_url","profile","program_urls","profile_music"]) if (payload[k] !== undefined) updates[k] = payload[k];
      }
      if (payload.settings !== undefined) {
        const allowed = ["home_chat_enabled","manual_chat_join","default_chat_room","chat_sound_enabled","chat_theme","notification_volume","post_notification_sound_enabled","home_chat_width"];
        const safeSettings = {};
        for (const k of allowed) if (Object.hasOwn(payload.settings || {}, k)) safeSettings[k] = payload.settings[k];
        updates.settings = { ...(user.settings || {}), ...safeSettings };
      }
      if (!Object.keys(updates).length) return fail(res, 400, "変更内容がありません");
      // verified, role, ban fields, points, and password_hash cannot be changed via profile updates.
      const { data, error } = await supabase.from("users").update(updates).eq("id", uid).select("*").single(); err(error);
      return res.status(200).json({ ok: true, user: publicUser(data), settings: data.settings, message: "アカウント情報を更新しました" });
    }
    if (action === "post-delete") {
      const { data: p, error } = await supabase.from("posts").select("id,user_id").eq("id", payload.postId).maybeSingle(); err(error);
      if (!p) return fail(res, 404, "投稿が見つかりません");
      if (p.user_id !== uid && !isAdmin) return fail(res, 403, "削除権限がありません");
      const { error: delErr } = await supabase.from("posts").delete().eq("id", p.id); err(delErr);
      return res.status(200).json({ ok: true });
    }
    if (action === "post-pin") {
      const { data: p, error } = await supabase.from("posts").select("id,user_id").eq("id", payload.postId).maybeSingle(); err(error);
      if (!p) return fail(res, 404, "投稿が見つかりません");
      if (p.user_id !== uid) return fail(res, 403, "自分の投稿だけ固定できます");
      if (payload.pinned) { const { error: e } = await supabase.from("posts").update({ is_pinned: false }).eq("user_id", uid).eq("is_pinned", true); err(e); }
      const { error: e } = await supabase.from("posts").update({ is_pinned: !!payload.pinned }).eq("id", p.id).eq("user_id", uid); err(e);
      return res.status(200).json({ ok: true, pinned: !!payload.pinned });
    }
    if (action === "post-view") {
      const { data: p, error } = await supabase.from("posts").select("id,user_id,views").eq("id", payload.postId).maybeSingle(); err(error);
      if (!p) return fail(res, 404, "投稿が見つかりません");
      if (p.user_id === uid) return res.status(200).json({ ok: true, views: Number(p.views || 0) });
      const views = Number(p.views || 0) + 1;
      const { error: e } = await supabase.from("posts").update({ views }).eq("id", p.id); err(e);
      return res.status(200).json({ ok: true, views });
    }
    if (action === "admin-user-update") {
      if (!isAdmin) return fail(res, 403, "管理者権限が必要です");
      const target = String(payload.targetUserId || "");
      if (!target) return fail(res, 400, "対象ユーザーが必要です");
      if (payload.deleteAccount) { const { error } = await supabase.from("users").delete().eq("id", target); err(error); return res.status(200).json({ ok: true }); }
      const updates = {};
      if (payload.role !== undefined) updates.role = payload.role;
      if (payload.verified !== undefined) updates.verified = !!payload.verified;
      if (payload.banUntil !== undefined) updates.ban_until = payload.banUntil;
      const { data, error } = await supabase.from("users").update(updates).eq("id", target).select("id,username,role,verified,ban_until").maybeSingle(); err(error);
      return res.status(200).json({ ok: true, user: data });
    }
    if (action === "account-delete") {
      const { error } = await supabase.from("users").delete().eq("id", uid); err(error);
      return res.status(200).json({ ok: true });
    }
    if (action === "chat-points") {
      const amount = Number(payload.amount);
      if (!Number.isInteger(amount) || !amount || Math.abs(amount) > 5000) return fail(res, 400, "ポイント数が不正です");
      const points = Math.max(0, Number(user.points || 0) + amount);
      const { error } = await supabase.from("users").update({ points }).eq("id", uid); err(error);
      return res.status(200).json({ ok: true, points });
    }
    if (action === "stamp-purchase") {
      const amount = Number(payload.amount);
      const stamps = Array.isArray(user.stamp_list) ? user.stamp_list : [];
      if (!Number.isInteger(amount) || amount < 1 || Number(user.points || 0) < amount || !payload.stampUrl) return fail(res, 400, "購入情報またはポイントが不正です");
      const points = Number(user.points || 0) - amount, stamp_list = [...stamps, String(payload.stampUrl)];
      const { error } = await supabase.from("users").update({ points, stamp_list }).eq("id", uid); err(error);
      return res.status(200).json({ ok: true, points, stamp_list });
    }
    if (action === "transfer-points") {
      const amount = Number(payload.amount), target = String(payload.targetUserId || "");
      if (!Number.isInteger(amount) || amount < 1 || amount > 1000 || amount > Number(user.points || 0) || !target || target === uid) return fail(res, 400, "ポイント送信内容が不正です");
      const { data: recipient, error } = await supabase.from("users").select("id,points").eq("id", target).single(); err(error);
      const { error: debitErr } = await supabase.from("users").update({ points: Number(user.points || 0) - amount }).eq("id", uid); err(debitErr);
      const { error: creditErr } = await supabase.from("users").update({ points: Number(recipient.points || 0) + amount }).eq("id", target); err(creditErr);
      return res.status(200).json({ ok: true, points: Number(user.points || 0) - amount });
    }
    if (action === "user-login-streak") {
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
      if (String(user.last_login_date || "").slice(0,10) === today) return res.status(200).json({ ok: true, awarded: false, streak: Number(user.login_streak || 0), points: Number(user.points || 0) });
      const last = String(user.last_login_date || "").slice(0,10);
      const yesterday = new Date(Date.now() - 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
      const streak = last === yesterday ? Number(user.login_streak || 0) + 1 : 1;
      const bonus = Math.min(50, 5 + streak);
      const points = Number(user.points || 0) + bonus;
      const { error } = await supabase.from("users").update({ last_login_date: today, login_streak: streak, points }).eq("id", uid); err(error);
      return res.status(200).json({ ok: true, awarded: true, streak, bonus, points });
    }
    if (action === "ban") {
      if (!isAdmin) return fail(res, 403, "BAN権限がありません");
      const target = String(payload.targetUserId || ""), minutes = Math.max(1, Number(payload.banMinutes) || 5);
      if (!target) return fail(res, 400, "対象ユーザーが必要です");
      const until = new Date(Date.now() + minutes * 60000).toISOString();
      const { data: victim, error } = await supabase.from("users").select("ban_count,points").eq("id", target).single(); err(error);
      const { error: updateErr } = await supabase.from("users").update({ ban_count: Number(victim.ban_count || 0) + 1, ban_until: until, points: Math.max(0, Number(victim.points || 0) - 100) }).eq("id", target); err(updateErr);
      return res.status(200).json({ ok: true, banUntil: until });
    }
    return fail(res, 400, "未対応のサーバー処理です: " + action);
  } catch (e) {
    console.error("gather API error:", action, e?.message || e);
    return fail(res, 500, e?.message || "サーバー内部エラー");
  }
}
async function recordDevice(supabase, userId, deviceHash, deviceInfo) {
  try {
    await supabase.from("user_devices").upsert({
      user_id: userId, device_hash: deviceHash,
      device_info: deviceInfo || {}, last_login_at: new Date().toISOString()
    }, { onConflict: "user_id,device_hash" });
  } catch (e) { console.warn("device record skipped", e?.message); }
}
