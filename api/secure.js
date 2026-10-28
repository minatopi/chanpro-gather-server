const { createClient } = require("@supabase/supabase-js");
const crypto = require("node:crypto");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const IP_HASH_SECRET =
  process.env.IP_HASH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const POSTHOG_PROJECT_KEY = process.env.POSTHOG_PROJECT_KEY || "";
const SESSION_SECRET =
  process.env.SESSION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const POSTHOG_API_HOST = (
  process.env.POSTHOG_API_HOST || "https://us.i.posthog.com"
).replace(/\/$/, "");
const IP_RATE_LIMIT = Math.max(20, Number(process.env.IP_RATE_LIMIT || 120));
const IP_RATE_WINDOW_SECONDS = Math.max(
  60,
  Number(process.env.IP_RATE_WINDOW_SECONDS || 300)
);
const IP_BLOCK_SECONDS = Math.max(
  60,
  Number(process.env.IP_BLOCK_SECONDS || 3600)
);
const SERVER_COUNT_HASHTAGS = false;
const STICKERS_URL =
  process.env.STICKERS_URL ||
  "https://minatopi.github.io/chanpro-chat-edit/stickers.json";
const AXIOM_TOKEN = process.env.AXIOM_TOKEN || "";
const AXIOM_DATASET = process.env.AXIOM_DATASET || "chanpro";
async function axiomLog(type, ip, props = {}) {
  if (!AXIOM_TOKEN) return;
  try {
    await fetch(`https://api.axiom.co/v1/datasets/${AXIOM_DATASET}/ingest`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AXIOM_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        {
          _time: new Date().toISOString(),
          source: "gather-api",
          type,
          ip,
          ...props,
        },
      ]),
      signal: AbortSignal.timeout(2500),
    });
  } catch (e) {
    console.warn("Axiom log failed:", e?.message || e);
  }
}
async function isEnabled(db, key) {
  const { data } = await db
    .from("app_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  return !(data && data.value === false);
}
async function settingMessage(db, key, fallback) {
  const { data } = await db
    .from("app_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  return (typeof data?.value === "string" && data.value) || fallback;
}
function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
function getClientIp(req) {
  const real = req.headers["x-real-ip"];
  const forwarded = req.headers["x-forwarded-for"];
  const raw =
    (Array.isArray(real) ? real[0] : real) ||
    (Array.isArray(forwarded)
      ? forwarded[0]
      : String(forwarded || "").split(",")[0]);
  const ip = String(raw || "")
    .trim()
    .replace(/^\[|\]$/g, "");
  if (!ip || ip.length > 100 || !/^[0-9a-fA-F:.%a-zA-Z0-9_-]+$/.test(ip)) {
    throw fail(
      "接続元IPを確認できません。Vercelのx-real-ip設定を確認してください",
      503
    );
  }
  return ip;
}
function normalizeIp(ip) {
  let value = String(ip || "")
    .trim()
    .toLowerCase();
  if (value.startsWith("::ffff:")) value = value.slice(7);
  return value;
}
function hashIp(ip) {
  if (!IP_HASH_SECRET) throw fail("IP_HASH_SECRET が未設定です", 503);
  return sha256(IP_HASH_SECRET + ":" + normalizeIp(ip));
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
          ...props,
        },
      }),
      signal: AbortSignal.timeout(2500),
    });
  } catch (e) {
    console.warn("PostHog security event could not be sent:", e?.message || e);
  }
}
async function checkIpBan(db, ipHash, ip, action) {
  const { data, error } = await db
    .from("banned_ip_addresses")
    .select("reason,expires_at")
    .eq("ip_hash", ipHash)
    .maybeSingle();
  if (error) throw error;
  if (
    data &&
    (!data.expires_at || new Date(data.expires_at).getTime() > Date.now())
  ) {
    await sendPostHogSecurityEvent("chanpro_ip_banned_request", ip, {
      ip_hash: ipHash,
      action,
      reason: data.reason || "IP BAN",
    });
    await axiomLog("ip_banned_request", ip, {
      ip_hash: ipHash,
      action,
      reason: data.reason || "IP BAN",
    });
    throw fail(
      data.reason || "このIPアドレスからのアクセスは禁止されています",
      403
    );
  }
}
async function enforceIpRateLimit(db, ipHash) {
  const { data, error } = await db.rpc("guard_ip_request", {
    p_ip_hash: ipHash,
    p_limit: IP_RATE_LIMIT,
    p_window_seconds: IP_RATE_WINDOW_SECONDS,
    p_block_seconds: IP_BLOCK_SECONDS,
  });
  if (error) {
    console.error("IP rate-limit RPC failed:", error.message || error);
    throw fail(
      "IP制限の確認に失敗しました。SupabaseのセキュリティSQLを適用してください",
      503
    );
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (row?.blocked) {
    throw Object.assign(
      new Error(
        `アクセスが集中したため、このIPからのAPIアクセスを一時停止しています。約${Math.max(
          1,
          Math.ceil(Number(row.retry_after_seconds || 3600) / 60)
        )}分後に再試行してください`
      ),
      {
        status: 429,
        retryAfter: Number(row.retry_after_seconds || 3600),
        ipBlocked: true,
      }
    );
  }
}
function json(res, status, body) {
  res
    .status(status)
    .setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.end(JSON.stringify(body));
}
function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(String(value), "utf8")
    .digest("hex");
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function signSession(user) {
  if (!SESSION_SECRET) throw fail("SESSION_SECRET が未設定です", 503);
  const payload = Buffer.from(
    JSON.stringify({
      sub: String(user.id),
      username: String(user.username || ""),
      exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
      iss: "chanpro-gather",
    })
  ).toString("base64url");
  const signature = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payload)
    .digest("base64url");
  return payload + "." + signature;
}
function readSession(req) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || !SESSION_SECRET)
    throw fail("ログイン状態が切れました。再ログインしてください", 401);
  const parts = token.split(".");
  if (parts.length !== 2) throw fail("セッションが無効です", 401);
  const expected = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(parts[0])
    .digest("base64url");
  if (!safeEqual(expected, parts[1])) throw fail("セッションが無効です", 401);
  let data;
  try {
    data = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch (_) {
    throw fail("セッションが無効です", 401);
  }
  if (
    data.iss !== "chanpro-gather" ||
    !data.sub ||
    Number(data.exp) <= Math.floor(Date.now() / 1000)
  ) {
    throw fail("セッションの有効期限が切れました。再ログインしてください", 401);
  }
  return data;
}
const USER_COLUMNS =
  "id,username,password_hash,role,verified,ban_until,ban_count,icon_url,cover_url,profile,settings,program_urls,program_views,program_likes,profile_music,points,stamp_list,login_streak,last_login_date,consecutive_post_weeks,last_post_week";
async function authenticateSession(db, req) {
  const session = readSession(req);
  const { data: user, error } = await db
    .from("users")
    .select(USER_COLUMNS)
    .eq("id", session.sub)
    .maybeSingle();
  if (error) throw error;
  if (!user)
    throw fail("ユーザーが見つかりません。再ログインしてください", 401);
  if (user.ban_until && new Date(user.ban_until).getTime() > Date.now()) {
    throw fail("このアカウントはBANされています", 403);
  }
  delete user.password_hash;
  return { user };
}
function client(req) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)
    throw new Error("Vercel環境変数が設定されていません");
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
function credentials(body) {
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!username || !password)
    throw fail("ユーザー名とパスワードを入力してください", 400);
  if (username.length > 100 || password.length > 1024)
    throw fail("入力が長すぎます", 400);
  return { username, password };
}
async function authenticate(db, body, { allowBanned = false } = {}) {
  const { username, password } = credentials(body);
  const { data: user, error } = await db
    .from("users")
    .select(USER_COLUMNS)
    .eq("username", username)
    .maybeSingle();
  if (error) throw error;
  if (!user || !safeEqual(user.password_hash, sha256(password))) {
    throw fail("ユーザー名またはパスワードが違います", 401);
  }
  if (
    !allowBanned &&
    user.ban_until &&
    new Date(user.ban_until).getTime() > Date.now()
  ) {
    throw fail("このアカウントはBANされています", 403);
  }
  return { user, password };
}
const ownUserFields = [
  "icon_url",
  "cover_url",
  "profile",
  "program_urls",
  "profile_music",
];
const settingFields = [
  "home_chat_enabled",
  "manual_chat_join",
  "default_chat_room",
  "chat_sound_enabled",
  "chat_theme",
  "notification_volume",
  "home_chat_width",
  "post_notification_sound_enabled",
];
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
function requireId(value, message = "IDが不正です") {
  const s = String(value == null ? "" : value);
  if (!SAFE_ID.test(s)) throw fail(message, 400);
  return s;
}
function canAccessPost(post, user, admin) {
  return (
    !post.is_limited ||
    admin ||
    !!user.verified ||
    String(post.user_id) === String(user.id)
  );
}
async function loadAccessiblePost(
  db,
  postId,
  user,
  admin,
  message = "この投稿は操作できません"
) {
  const id = requireId(postId, "投稿IDがありません");
  const { data: post, error } = await db
    .from("posts")
    .select("id,user_id,is_limited,poll")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!post) throw fail("投稿が見つかりません", 404);
  if (!canAccessPost(post, user, admin)) throw fail(message, 403);
  return post;
}
function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
async function trimNotifications(db, userId) {
  try {
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    await db
      .from("notifications")
      .delete()
      .eq("user_id", userId)
      .lt("created_at", cutoff);
    const { data } = await db
      .from("notifications")
      .select("id")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .range(100, 599);
    if (data?.length)
      await db
        .from("notifications")
        .delete()
        .in(
          "id",
          data.map((r) => r.id)
        );
  } catch (e) {
    console.warn("notification trim failed:", e?.message || e);
  }
}
async function addNotifications(
  db,
  rows,
  { dedupe = false, allowSelf = false } = {}
) {
  try {
    rows = (rows || []).filter(
      (r) =>
        r &&
        r.user_id &&
        (allowSelf || String(r.user_id) !== String(r.actor_id))
    );
    if (!rows.length) return;
    if (dedupe) {
      const kept = [];
      for (const r of rows) {
        let q = db
          .from("notifications")
          .select("id")
          .eq("user_id", r.user_id)
          .eq("actor_id", r.actor_id)
          .eq("type", r.type)
          .limit(1);
        q = r.post_id ? q.eq("post_id", r.post_id) : q.is("post_id", null);
        const { data } = await q;
        if (!data?.length) kept.push(r);
      }
      rows = kept;
      if (!rows.length) return;
    }
    const insertResults = await Promise.all(
      chunk(rows, 500).map((part) => db.from("notifications").insert(part))
    );
    for (const result of insertResults) {
      if (result.error)
        console.warn("notification insert failed:", result.error.message);
    } /* 通知の古いデータ整理は投稿API内で行わない。フォロワー数に比例して数十回のDB通信が発生し、Vercelの10秒制限に達するため。整理は通知を読む操作など別の機会に行う。 */
  } catch (e) {
    console.warn("addNotifications failed:", e?.message || e);
  }
}
function normalizePoll(poll) {
  if (poll == null) return null;
  if (typeof poll !== "object" || Array.isArray(poll))
    throw fail("アンケートの形式が不正です", 400);
  const question = String(poll.question || "")
    .trim()
    .slice(0, 200);
  const options = (Array.isArray(poll.options) ? poll.options : [])
    .map((o) =>
      String(o || "")
        .trim()
        .slice(0, 100)
    )
    .filter(Boolean);
  if (!question) throw fail("アンケートの質問を入力してください", 400);
  if (options.length < 2 || options.length > 4)
    throw fail("選択肢は2〜4個にしてください", 400);
  if (new Set(options).size !== options.length)
    throw fail("選択肢は重複させないでください", 400);
  return { question, options };
}
async function countHashtags(db, content) {
  if (!SERVER_COUNT_HASHTAGS) return;
  try {
    const text = String(content || "").replace(
      /```html\s*\n[\s\S]*?\n```/gi,
      ""
    );
    const tags = [
      ...new Set(
        (text.match(/#[\p{L}\p{N}_]+/gu) || []).map((t) =>
          t.slice(1).toLowerCase()
        )
      ),
    ].slice(0, 10);
    for (const tag of tags) {
      const { data } = await db
        .from("hashtags")
        .select("usage_count")
        .eq("tag", tag)
        .maybeSingle();
      await db
        .from("hashtags")
        .upsert(
          {
            tag,
            usage_count: Number(data?.usage_count || 0) + 1,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "tag" }
        );
    }
  } catch (e) {
    console.warn("hashtag count failed:", e?.message || e);
  }
}
let stickerCache = { at: 0, map: null };
async function getStickerPrice(stampUrl) {
  if (!stickerCache.map || Date.now() - stickerCache.at > 5 * 60000) {
    const res = await fetch(STICKERS_URL, {
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
    if (!res.ok) throw fail("スタンプ情報を取得できませんでした", 503);
    const list = await res.json();
    const map = new Map();
    for (const s of Array.isArray(list) ? list : [])
      if (s?.url) map.set(String(s.url), Number(s.price || 0));
    stickerCache = { at: Date.now(), map };
  }
  return stickerCache.map.has(stampUrl) ? stickerCache.map.get(stampUrl) : null;
}
async function updatePointsCas(db, userId, oldPoints, patch) {
  const { data, error } = await db
    .from("users")
    .update(patch)
    .eq("id", userId)
    .eq("points", Number(oldPoints || 0))
    .select("id");
  if (error) throw error;
  if (!data?.length)
    throw fail("ポイントが同時に更新されました。もう一度お試しください", 409);
}
function japanDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value])
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

function isoWeekKeyFromYmd(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

function currentJapanWeek() {
  const { year, month, day } = japanDateParts();
  const localMidnightAsUtc = Date.UTC(year, month - 1, day);
  const weekday = new Date(localMidnightAsUtc).getUTCDay() || 7;
  const mondayYmd = new Date(localMidnightAsUtc - (weekday - 1) * 86400000);
  const startUtc = new Date(mondayYmd.getTime() - 9 * 60 * 60 * 1000);
  const endUtc = new Date(startUtc.getTime() + 7 * 86400000);
  const previousYmd = new Date(mondayYmd.getTime() - 7 * 86400000);
  return {
    key: isoWeekKeyFromYmd(year, month, day),
    previousKey: isoWeekKeyFromYmd(
      previousYmd.getUTCFullYear(),
      previousYmd.getUTCMonth() + 1,
      previousYmd.getUTCDate()
    ),
    start: startUtc.toISOString(),
    end: endUtc.toISOString(),
  };
}

async function awardWeeklyPostBonus(db, userId) {
  const week = currentJapanWeek();

  // ボーナスは「今週に実際の投稿が保存されている場合」にだけ付与する。
  const { data: recentPost, error: postError } = await db
    .from("posts")
    .select("id")
    .eq("user_id", userId)
    .gte("created_at", week.start)
    .lt("created_at", week.end)
    .limit(1)
    .maybeSingle();
  if (postError) throw postError;
  if (!recentPost) {
    return {
      awarded: false,
      points: null,
      streak: null,
      week: week.key,
      bonus: 0,
      reason: "no_post_this_week",
    };
  }

  // 最新値を取得し、複数の連続投稿リクエストが同時に来ても二重加算しない。
  const { data: currentUser, error: userError } = await db
    .from("users")
    .select("id,points,consecutive_post_weeks,last_post_week")
    .eq("id", userId)
    .maybeSingle();
  if (userError) throw userError;
  if (!currentUser) throw fail("ユーザーが見つかりません", 401);

  const lastWeek = String(currentUser.last_post_week || "");
  const currentPoints = Number(currentUser.points || 0);
  const currentStreak = Number(currentUser.consecutive_post_weeks || 0);

  if (lastWeek === week.key) {
    return {
      awarded: false,
      points: currentPoints,
      streak: currentStreak,
      week: week.key,
      bonus: 0,
      reason: "already_awarded",
    };
  }

  const streak = lastWeek === week.previousKey ? currentStreak + 1 : 1;
  const bonus = 30 * streak;
  let update = db
    .from("users")
    .update({
      points: currentPoints + bonus,
      consecutive_post_weeks: streak,
      last_post_week: week.key,
    })
    .eq("id", userId)
    .eq("points", currentPoints);

  update = lastWeek
    ? update.eq("last_post_week", lastWeek)
    : update.is("last_post_week", null);

  const { data: updated, error: updateError } = await update.select("id");
  if (updateError) throw updateError;

  if (!updated || updated.length === 0) {
    // 競合した場合、既に同じ週の加算が完了していれば正常な重複呼び出しとして扱う。
    const { data: latest, error: latestError } = await db
      .from("users")
      .select("points,consecutive_post_weeks,last_post_week")
      .eq("id", userId)
      .maybeSingle();
    if (latestError) throw latestError;
    if (latest && String(latest.last_post_week || "") === week.key) {
      return {
        awarded: false,
        points: Number(latest.points || 0),
        streak: Number(latest.consecutive_post_weeks || 0),
        week: week.key,
        bonus: 0,
        reason: "already_awarded",
      };
    }
    throw fail(
      "連続投稿ボーナスを更新できませんでした。再試行してください",
      409
    );
  }

  await addNotifications(
    db,
    [
      {
        user_id: userId,
        actor_id: userId,
        type: "post_streak",
        message: `連続投稿${streak}週達成！${bonus}ポイント獲得`,
      },
    ],
    { allowSelf: true }
  );

  return {
    awarded: true,
    points: currentPoints + bonus,
    streak,
    week: week.key,
    bonus,
    reason: "awarded",
  };
}
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, apikey, x-client-info"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  try {
    const ip = getClientIp(req);
    const ipHash = hashIp(ip);
    const db = client(req);
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : req.body || {};
    const action = String(body.action || "");
    await checkIpBan(db, ipHash, ip, action);
    try {
      await enforceIpRateLimit(db, ipHash);
    } catch (limitError) {
      if (limitError.ipBlocked) {
        await sendPostHogSecurityEvent("chanpro_ip_blocked", ip, {
          ip_hash: ipHash,
          action,
        });
        await axiomLog("ip_rate_limited", ip, { ip_hash: ipHash, action });
      }
      throw limitError;
    }
    if (action === "check-ip") {
      return json(res, 200, { ok: true, ipCheck: "passed" });
    }
    if (action === "login" || action === "register") {
      const { username, password } = credentials(body);
      const deviceHash = String(body.deviceHash || "").trim();
      if (action === "register" && !/^[a-f0-9]{32,128}$/i.test(deviceHash)) {
        throw fail(
          "端末情報を確認できません。通常のブラウザで再試行してください",
          400
        );
      }
      await sendPostHogSecurityEvent(
        action === "register"
          ? "chanpro_registration_attempt"
          : "chanpro_login_attempt",
        ip,
        {
          ip_hash: ipHash,
          action,
          username,
          device_hash: deviceHash || undefined,
        }
      );
      if (action === "register") {
        if (!(await isEnabled(db, "register_enabled"))) {
          await axiomLog("register_blocked", ip, { ip_hash: ipHash, username });
          throw fail(
            await settingMessage(
              db,
              "register_disabled_message",
              "現在新規作成を停止しています"
            ),
            503
          );
        }
        if (username.length < 2 || password.length < 8)
          throw fail(
            "ユーザー名は2文字以上、パスワードは8文字以上にしてください",
            400
          );
        const { data, error } = await db.rpc("register_account_limited", {
          p_username: username,
          p_password_hash: sha256(password),
          p_device_hash: deviceHash,
          p_device_info: body.deviceInfo || {},
        });
        if (error) {
          if (/DEVICE_ACCOUNT_LIMIT/.test(error.message || "")) {
            throw fail("この端末で作成できる新規アカウントは5個までです", 429);
          }
          if (error.code === "23505")
            throw fail("そのユーザー名は既に使用されています", 409);
          throw error;
        }
        const user = data && typeof data === "object" ? data : null;
        if (!user?.id) throw new Error("新規アカウント作成の応答が不正です");
        delete user.password_hash;
        const { error: deviceError } = await db
          .from("user_devices")
          .upsert(
            {
              user_id: user.id,
              device_hash: deviceHash,
              device_info: body.deviceInfo || {},
              last_login_at: new Date().toISOString(),
            },
            { onConflict: "user_id,device_hash" }
          );
        if (deviceError)
          console.warn("user_devices の記録に失敗:", deviceError.message);
        await sendPostHogSecurityEvent("chanpro_registration_created", ip, {
          ip_hash: ipHash,
          user_id: String(user.id),
          username: String(user.username || ""),
          device_hash: deviceHash,
        });
        await axiomLog("register_created", ip, {
          ip_hash: ipHash,
          user_id: String(user.id),
          username: String(user.username || ""),
        });
        return json(res, 200, {
          ok: true,
          user,
          token: signSession(user),
          isAdmin: false,
        });
      }
      let user;
      try {
        ({ user } = await authenticate(db, body));
      } catch (e) {
        await axiomLog("login_failed", ip, {
          ip_hash: ipHash,
          username,
          status: e.status || 500,
        });
        throw e;
      }
      if (
        !["admin", "developer"].includes(user.role) &&
        !(await isEnabled(db, "login_enabled"))
      ) {
        await axiomLog("login_blocked", ip, {
          ip_hash: ipHash,
          username,
          user_id: String(user.id),
        });
        throw fail(
          await settingMessage(
            db,
            "login_disabled_message",
            "現在ログインを停止しています"
          ),
          503
        );
      }
      if (deviceHash) {
        const { error } = await db
          .from("user_devices")
          .upsert(
            {
              user_id: user.id,
              device_hash: deviceHash,
              device_info: body.deviceInfo || {},
              last_login_at: new Date().toISOString(),
            },
            { onConflict: "user_id,device_hash" }
          );
        if (error) throw error;
      }
      delete user.password_hash;
      await sendPostHogSecurityEvent("chanpro_login_success", ip, {
        ip_hash: ipHash,
        user_id: String(user.id),
        username: String(user.username || ""),
        device_hash: deviceHash || undefined,
      });
      await axiomLog("login_success", ip, {
        ip_hash: ipHash,
        user_id: String(user.id),
        username: String(user.username || ""),
        device_hash: deviceHash || undefined,
      });
      return json(res, 200, {
        ok: true,
        user,
        token: signSession(user),
        isAdmin: ["admin", "developer"].includes(user.role),
      });
    }
    const { user } = await authenticateSession(db, req);
    const admin = ["admin", "developer"].includes(user.role);
    const payload = body.payload || {};
    void axiomLog("access", ip, {
      ip_hash: ipHash,
      action,
      page: String(body.page || req.headers.referer || "").slice(0, 300),
      user_id: String(user.id),
      username: String(user.username || ""),
    }).catch(() => {});
    switch (action) {
      case "limited-post-list": {
        if (!user.verified && !admin)
          return json(res, 200, { ok: true, posts: [] });
        const { data, error } = await db
          .from("posts")
          .select(
            "id,user_id,content,image_url,image_mqtt,is_limited,is_pinned,quote_post_id,poll,views,created_at"
          )
          .eq("is_limited", true)
          .order("created_at", { ascending: false })
          .limit(50);
        if (error) throw error;
        return json(res, 200, { ok: true, posts: data || [] });
      }
      case "post-read": {
        const postId = requireId(payload.postId, "投稿IDがありません");
        const { data: post, error } = await db
          .from("posts")
          .select(
            "id,user_id,content,image_url,image_mqtt,is_limited,is_pinned,quote_post_id,poll,views,created_at"
          )
          .eq("id", postId)
          .maybeSingle();
        if (error) throw error;
        if (!post) throw fail("投稿が見つかりません", 404);
        if (post.is_limited && !user.verified && !admin)
          throw fail("この限定投稿は認証済みユーザーのみ閲覧できます", 403);
        return json(res, 200, { ok: true, post });
      }
      case "reply-list": {
        const postId = requireId(payload.postId, "投稿IDがありません");
        const { data: post, error: postError } = await db
          .from("posts")
          .select("id,user_id,is_limited")
          .eq("id", postId)
          .maybeSingle();
        if (postError) throw postError;
        if (!post) throw fail("投稿が見つかりません", 404);
        if (post.is_limited && !user.verified && !admin)
          throw fail("この限定投稿の返信は閲覧できません", 403);
        const { data, error } = await db
          .from("replies")
          .select("id,post_id,user_id,content,parent_reply_id,created_at")
          .eq("post_id", postId)
          .order("created_at", { ascending: true })
          .limit(1000);
        if (error) throw error;
        return json(res, 200, { ok: true, replies: data || [] });
      }
      case "post-create": {
        const content = String(payload.content || "");
        const imageUrl =
          payload.image_url == null ? null : String(payload.image_url);
        const quotePostId =
          payload.quote_post_id == null
            ? null
            : requireId(payload.quote_post_id, "引用元の投稿IDが不正です");
        const poll = normalizePoll(payload.poll);
        if (!content.trim() && !imageUrl && !quotePostId && !poll)
          throw fail("投稿内容を入力してください", 400);
        if (content.length > 100000) throw fail("投稿内容が長すぎます", 400);
        if (imageUrl && imageUrl.length > 10000)
          throw fail("画像URLが長すぎます", 400);
        if (quotePostId)
          await loadAccessiblePost(
            db,
            quotePostId,
            user,
            admin,
            "この投稿は引用できません"
          );
        const isLimited = !!payload.is_limited && !!user.verified;
        const row = {
          user_id: user.id,
          content,
          image_url: imageUrl,
          is_limited: isLimited,
          quote_post_id: quotePostId,
          poll,
          views: 0,
        };
        // 投稿の保存を最優先にし、投稿行が作成された後の処理で投稿結果を失敗扱いにしない。
        const { data, error } = await db
          .from("posts")
          .insert(row)
          .select("*")
          .single();
        if (error) throw error;
        // フォロワー通知と週次ボーナスを並行実行し、順番待ちを減らす。
        const notificationTask = (async () => {
          try {
            const { data: follows, error: followError } = await db
              .from("follows")
              .select("follower_id")
              .eq("following_id", user.id);
            if (followError) throw followError;
            let followerIds = [
              ...new Set(
                (follows || [])
                  .map((f) => f.follower_id)
                  .filter((id) => id && String(id) !== String(user.id))
              ),
            ];
            if (isLimited && followerIds.length) {
              const verifiedChunks = await Promise.all(
                chunk(followerIds, 200).map((part) =>
                  db
                    .from("users")
                    .select("id")
                    .in("id", part)
                    .eq("verified", true)
                )
              );
              followerIds = verifiedChunks.flatMap((result) => {
                if (result.error) throw result.error;
                return (result.data || []).map((v) => v.id);
              });
            }
            await addNotifications(
              db,
              followerIds.map((uid) => ({
                user_id: uid,
                actor_id: user.id,
                type: "post",
                post_id: data.id,
              }))
            );
          } catch (e) {
            console.warn("post notify failed:", e?.message || e);
          }
        })();
        let postBonus = { awarded: false, bonus: 0, reason: "not_processed" };
        const bonusTask = (async () => {
          try {
            postBonus = await awardWeeklyPostBonus(db, user.id);
          } catch (e) {
            console.warn("weekly post bonus failed:", e?.message || e);
            postBonus = { awarded: false, bonus: 0, reason: "error" };
          }
        })();
        await Promise.all([notificationTask, bonusTask]);
        return json(res, 200, {
          ok: true,
          post: data,
          notifiedFollowers: true,
          postBonus,
        });
      }
      case "reply-create": {
        const postId = requireId(payload.post_id, "返信先の投稿IDがありません");
        const content = String(payload.content || "").trim();
        const parentReplyId =
          payload.parent_reply_id == null
            ? null
            : requireId(payload.parent_reply_id, "返信先が不正です");
        if (!content) throw fail("返信内容を入力してください", 400);
        if (content.length > 20000) throw fail("返信内容が長すぎます", 400);
        const { data: post, error: postError } = await db
          .from("posts")
          .select("id,user_id,is_limited")
          .eq("id", postId)
          .maybeSingle();
        if (postError) throw postError;
        if (!post) throw fail("返信先の投稿が見つかりません", 404);
        if (post.is_limited && post.user_id !== user.id && !admin)
          throw fail("この限定投稿には返信できません", 403);
        let parentAuthor = null;
        if (parentReplyId) {
          const { data: parent, error: parentError } = await db
            .from("replies")
            .select("id,post_id,user_id")
            .eq("id", parentReplyId)
            .maybeSingle();
          if (parentError) throw parentError;
          if (!parent || String(parent.post_id) !== postId)
            throw fail("返信先が見つかりません", 400);
          parentAuthor = parent.user_id;
        }
        const row = {
          post_id: postId,
          user_id: user.id,
          content,
          parent_reply_id: parentReplyId,
        };
        const { data, error } = await db
          .from("replies")
          .insert(row)
          .select("id,post_id,user_id,content,parent_reply_id,created_at")
          .single();
        if (error) throw error;
        const targets = [...new Set([parentAuthor || post.user_id])];
        await addNotifications(
          db,
          targets.map((uid) => ({
            user_id: uid,
            actor_id: user.id,
            type: "reply",
            post_id: postId,
          }))
        );
        return json(res, 200, { ok: true, reply: data });
      }
      case "reply-delete": {
        const replyId = requireId(payload.replyId, "返信IDがありません");
        const { data: reply, error: readError } = await db
          .from("replies")
          .select("id,user_id,post_id")
          .eq("id", replyId)
          .maybeSingle();
        if (readError) throw readError;
        if (!reply) throw fail("返信が見つかりません", 404);
        const { data: parentPost, error: parentError } = await db
          .from("posts")
          .select("id,user_id,is_limited")
          .eq("id", reply.post_id)
          .maybeSingle();
        if (parentError) throw parentError;
        if (reply.user_id !== user.id && !admin)
          throw fail("この返信を削除する権限がありません", 403);
        if (parentPost?.is_limited && !user.verified && !admin)
          throw fail("この限定投稿の返信を削除できません", 403);
        const { error } = await db.from("replies").delete().eq("id", replyId);
        if (error) throw error;
        return json(res, 200, { ok: true, postId: reply.post_id });
      }
      case "post-delete": {
        const postId = requireId(payload.postId, "投稿IDがありません");
        const { data: post, error: readError } = await db
          .from("posts")
          .select("id,user_id")
          .eq("id", postId)
          .maybeSingle();
        if (readError) throw readError;
        if (!post) throw fail("投稿が見つかりません", 404);
        if (post.user_id !== user.id && !admin)
          throw fail("削除権限がありません", 403);
        const { error } = await db.from("posts").delete().eq("id", post.id);
        if (error) throw error;
        return json(res, 200, { ok: true });
      }
      case "post-view": {
        const postId = requireId(payload.postId, "投稿IDがありません");
        const { data: post, error } = await db
          .from("posts")
          .select("id,user_id,views")
          .eq("id", postId)
          .maybeSingle();
        if (error) throw error;
        if (!post) throw fail("投稿が見つかりません", 404);
        if (post.user_id === user.id)
          return json(res, 200, { ok: true, views: Number(post.views || 0) });
        const views = Number(post.views || 0) + 1;
        const { error: updateError } = await db
          .from("posts")
          .update({ views })
          .eq("id", post.id);
        if (updateError) throw updateError;
        return json(res, 200, { ok: true, views });
      }
      case "post-pin": {
        const postId = requireId(payload.postId, "投稿IDがありません");
        const { data: post, error } = await db
          .from("posts")
          .select("id,user_id")
          .eq("id", postId)
          .maybeSingle();
        if (error) throw error;
        if (!post) throw fail("投稿が見つかりません", 404);
        if (post.user_id !== user.id && !admin)
          throw fail("権限がありません", 403);
        if (payload.pinned) {
          const { error: clearError } = await db
            .from("posts")
            .update({ is_pinned: false })
            .eq("user_id", post.user_id)
            .eq("is_pinned", true);
          if (clearError) throw clearError;
        }
        const { error: updateError } = await db
          .from("posts")
          .update({ is_pinned: !!payload.pinned })
          .eq("id", post.id);
        if (updateError) throw updateError;
        return json(res, 200, { ok: true, pinned: !!payload.pinned });
      }
      case "post-like-toggle": {
        const post = await loadAccessiblePost(
          db,
          payload.postId,
          user,
          admin,
          "この限定投稿にはいいねできません"
        );
        const { data: existing, error: findError } = await db
          .from("likes")
          .select("id")
          .eq("post_id", post.id)
          .eq("user_id", user.id)
          .maybeSingle();
        if (findError) throw findError;
        let liked;
        if (existing) {
          const { error } = await db
            .from("likes")
            .delete()
            .eq("id", existing.id)
            .eq("user_id", user.id);
          if (error) throw error;
          liked = false;
        } else {
          const { error } = await db
            .from("likes")
            .insert({ post_id: post.id, user_id: user.id });
          if (error && error.code !== "23505") throw error;
          liked = true;
          await addNotifications(
            db,
            [
              {
                user_id: post.user_id,
                actor_id: user.id,
                type: "like",
                post_id: post.id,
              },
            ],
            { dedupe: true }
          );
        }
        const { count, error: countError } = await db
          .from("likes")
          .select("id", { count: "exact", head: true })
          .eq("post_id", post.id);
        if (countError) throw countError;
        return json(res, 200, { ok: true, liked, count: Number(count || 0) });
      }
      case "repost-toggle": {
        const post = await loadAccessiblePost(
          db,
          payload.postId,
          user,
          admin,
          "この限定投稿はリポストできません"
        );
        const { data: existing, error: findError } = await db
          .from("reposts")
          .select("id")
          .eq("post_id", post.id)
          .eq("user_id", user.id)
          .maybeSingle();
        if (findError) throw findError;
        let reposted;
        if (existing) {
          const { error } = await db
            .from("reposts")
            .delete()
            .eq("id", existing.id)
            .eq("user_id", user.id);
          if (error) throw error;
          reposted = false;
        } else {
          const { error } = await db
            .from("reposts")
            .insert({ post_id: post.id, user_id: user.id });
          if (error && error.code !== "23505") throw error;
          reposted = true;
          await addNotifications(
            db,
            [
              {
                user_id: post.user_id,
                actor_id: user.id,
                type: "repost",
                post_id: post.id,
              },
            ],
            { dedupe: true }
          );
        }
        const { count, error: countError } = await db
          .from("reposts")
          .select("id", { count: "exact", head: true })
          .eq("post_id", post.id);
        if (countError) throw countError;
        return json(res, 200, {
          ok: true,
          reposted,
          count: Number(count || 0),
        });
      }
      case "bookmark-toggle": {
        const post = await loadAccessiblePost(
          db,
          payload.postId,
          user,
          admin,
          "この限定投稿はブックマークできません"
        );
        const { data: existing, error: findError } = await db
          .from("bookmarks")
          .select("id")
          .eq("post_id", post.id)
          .eq("user_id", user.id)
          .maybeSingle();
        if (findError) throw findError;
        let bookmarked;
        if (existing) {
          const { error } = await db
            .from("bookmarks")
            .delete()
            .eq("id", existing.id)
            .eq("user_id", user.id);
          if (error) throw error;
          bookmarked = false;
        } else {
          const { error } = await db
            .from("bookmarks")
            .insert({ post_id: post.id, user_id: user.id });
          if (error && error.code !== "23505") throw error;
          bookmarked = true;
        }
        return json(res, 200, { ok: true, bookmarked });
      }
      case "poll-vote": {
        const post = await loadAccessiblePost(
          db,
          payload.postId,
          user,
          admin,
          "この限定投稿のアンケートには投票できません"
        );
        const options =
          post.poll && Array.isArray(post.poll.options)
            ? post.poll.options
            : null;
        if (!options) throw fail("この投稿にはアンケートがありません", 400);
        const optionIndex = Number(payload.optionIndex);
        if (
          !Number.isInteger(optionIndex) ||
          optionIndex < 0 ||
          optionIndex >= options.length
        )
          throw fail("選択肢が不正です", 400);
        const { data: existing, error: findError } = await db
          .from("poll_votes")
          .select("id")
          .eq("post_id", post.id)
          .eq("user_id", user.id)
          .maybeSingle();
        if (findError) throw findError;
        if (existing) throw fail("すでに投票しています", 409);
        const { error } = await db
          .from("poll_votes")
          .insert({
            post_id: post.id,
            user_id: user.id,
            option_index: optionIndex,
          });
        if (error) {
          if (error.code === "23505") throw fail("すでに投票しています", 409);
          throw error;
        }
        await addNotifications(db, [
          {
            user_id: post.user_id,
            actor_id: user.id,
            type: "poll_voted",
            post_id: post.id,
            message: `${
              user.username || "ユーザー"
            }さんがあなたのアンケートに投票しました`,
          },
        ]);
        return json(res, 200, { ok: true, optionIndex });
      }
      case "follow-toggle": {
        const targetId = requireId(
          payload.targetUserId,
          "対象ユーザーが不正です"
        );
        if (targetId === String(user.id))
          throw fail("自分はフォローできません", 400);
        const { data: target, error: targetError } = await db
          .from("users")
          .select("id")
          .eq("id", targetId)
          .maybeSingle();
        if (targetError) throw targetError;
        if (!target) throw fail("ユーザーが見つかりません", 404);
        const { data: existing, error: findError } = await db
          .from("follows")
          .select("id")
          .eq("follower_id", user.id)
          .eq("following_id", targetId)
          .maybeSingle();
        if (findError) throw findError;
        let following;
        if (existing) {
          const { error } = await db
            .from("follows")
            .delete()
            .eq("id", existing.id)
            .eq("follower_id", user.id);
          if (error) throw error;
          following = false;
        } else {
          const { error } = await db
            .from("follows")
            .insert({ follower_id: user.id, following_id: targetId });
          if (error && error.code !== "23505") throw error;
          following = true;
          await addNotifications(
            db,
            [{ user_id: target.id, actor_id: user.id, type: "follow" }],
            { dedupe: true }
          );
        }
        return json(res, 200, { ok: true, following });
      }
      case "notifications-read": {
        const { error } = await db
          .from("notifications")
          .update({ is_read: true })
          .eq("user_id", user.id)
          .eq("is_read", false);
        if (error) throw error;
        await trimNotifications(db, user.id);
        return json(res, 200, { ok: true });
      }
      case "report-create": {
        const targetId = requireId(payload.targetUserId, "通報対象が不正です");
        const postId =
          payload.postId == null || payload.postId === ""
            ? null
            : requireId(payload.postId, "投稿IDが不正です");
        const reason = String(payload.reason || "").trim();
        if (!reason) throw fail("通報理由を入力してください", 400);
        if (reason.length > 2000) throw fail("通報理由が長すぎます", 400);
        if (targetId === String(user.id))
          throw fail("自分自身は通報できません", 400);
        const since = new Date(Date.now() - 5 * 60000).toISOString();
        let dup = db
          .from("reports")
          .select("id")
          .eq("reporter_id", user.id)
          .eq("target_user_id", targetId)
          .gte("created_at", since)
          .limit(1);
        dup = postId ? dup.eq("post_id", postId) : dup.is("post_id", null);
        const { data: recent } = await dup;
        if (recent?.length)
          throw fail("同じ内容を短時間に繰り返し通報することはできません", 429);
        const { error } = await db
          .from("reports")
          .insert({
            reporter_id: user.id,
            target_user_id: targetId,
            post_id: postId,
            reason,
          });
        if (error) throw error;
        return json(res, 200, { ok: true, message: "通報しました" });
      }
      case "report-resolve": {
        if (!admin) throw fail("管理者権限が必要です", 403);
        const reportId = requireId(payload.reportId, "通報IDが不正です");
        const { error } = await db
          .from("reports")
          .update({ status: "resolved" })
          .eq("id", reportId);
        if (error) throw error;
        return json(res, 200, { ok: true });
      }
      case "report": {
        const message = String(payload.message || "").trim();
        if (!message || message.length > 5000)
          throw fail("報告内容を入力してください", 400);
        const { error } = await db
          .from("gather_reports")
          .insert({
            user_id: user.id,
            username: user.username,
            content: message,
          });
        if (error) throw error;
        return json(res, 200, { ok: true, message: "報告を送信しました" });
      }
      case "dm-list": {
        let q = db
          .from("messages")
          .select("id,sender_id,receiver_id,content,created_at");
        if (payload.withUserId) {
          const other = requireId(payload.withUserId, "相手のIDが不正です");
          q = q
            .or(
              `and(sender_id.eq.${user.id},receiver_id.eq.${other}),and(sender_id.eq.${other},receiver_id.eq.${user.id})`
            )
            .order("created_at", { ascending: true });
        } else {
          q = q
            .or(`sender_id.eq.${user.id},receiver_id.eq.${user.id}`)
            .order("created_at", { ascending: false });
        }
        const { data, error } = await q.limit(1000);
        if (error) throw error;
        return json(res, 200, { ok: true, messages: data || [] });
      }
      case "dm-send": {
        const recipientId = requireId(payload.recipientId, "宛先が不正です");
        const content = String(payload.content || "").trim();
        if (!content || content.length > 10000)
          throw fail("DMの内容を確認してください", 400);
        if (recipientId === String(user.id))
          throw fail("自分にはDMを送れません", 400);
        const { data: recipient, error: recipientError } = await db
          .from("users")
          .select("id")
          .eq("id", recipientId)
          .maybeSingle();
        if (recipientError) throw recipientError;
        if (!recipient) throw fail("送信先が見つかりません", 404);
        const { data, error } = await db
          .from("messages")
          .insert({ sender_id: user.id, receiver_id: recipientId, content })
          .select("id,sender_id,receiver_id,content,created_at")
          .single();
        if (error) throw error;
        let notified = false;
        try {
          const since = new Date(Date.now() - 15 * 60000).toISOString();
          const { data: recent } = await db
            .from("notifications")
            .select("id")
            .eq("user_id", recipientId)
            .eq("actor_id", user.id)
            .eq("type", "message")
            .gte("created_at", since)
            .limit(1);
          if (!recent?.length) {
            await addNotifications(db, [
              {
                user_id: recipientId,
                actor_id: user.id,
                type: "message",
                message_id: data.id,
              },
            ]);
            notified = true;
          }
        } catch (e) {
          console.warn("dm notify failed:", e?.message || e);
        }
        return json(res, 200, { ok: true, message: data, notified });
      }
      case "user-update": {
        const patch = {};
        for (const key of ownUserFields)
          if (Object.prototype.hasOwnProperty.call(payload, key))
            patch[key] = payload[key];
        if (Object.prototype.hasOwnProperty.call(payload, "settings")) {
          const settings = {};
          for (const key of settingFields)
            if (
              Object.prototype.hasOwnProperty.call(payload.settings || {}, key)
            )
              settings[key] = payload.settings[key];
          patch.settings = { ...(user.settings || {}), ...settings };
        }
        if (Object.prototype.hasOwnProperty.call(payload, "newUsername")) {
          const name = String(payload.newUsername || "").trim();
          if (name.length < 2 || name.length > 100)
            throw fail("ユーザー名は2〜100文字にしてください", 400);
          patch.username = name;
        }
        if (Object.prototype.hasOwnProperty.call(payload, "newPassword")) {
          const password = String(payload.newPassword || "");
          if (password.length < 8)
            throw fail("パスワードは8文字以上にしてください", 400);
          patch.password_hash = sha256(password);
        }
        if (!Object.keys(patch).length) throw fail("変更内容がありません", 400);
        const { data, error } = await db
          .from("users")
          .update(patch)
          .eq("id", user.id)
          .select(
            "id,username,icon_url,cover_url,profile,role,verified,settings,program_urls,program_views,program_likes,profile_music,points,stamp_list,login_streak,last_login_date"
          )
          .single();
        if (error) {
          if (error.code === "23505")
            throw fail("そのユーザー名は既に使用されています", 409);
          throw error;
        }
        return json(res, 200, {
          ok: true,
          user: data,
          message: "アカウント情報を更新しました",
        });
      }
      case "user-settings": {
        const input =
          payload.settings &&
          typeof payload.settings === "object" &&
          !Array.isArray(payload.settings)
            ? payload.settings
            : {};
        const settings = {};
        for (const key of settingFields) {
          if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
          const value = input[key];
          if (
            [
              "home_chat_enabled",
              "manual_chat_join",
              "chat_sound_enabled",
              "post_notification_sound_enabled",
            ].includes(key)
          ) {
            if (typeof value !== "boolean")
              throw fail(`設定値が不正です: ${key}`, 400);
            settings[key] = value;
          } else if (key === "notification_volume") {
            const volume = Number(value);
            if (!Number.isFinite(volume) || volume < 0 || volume > 1)
              throw fail("通知音量は0〜1で指定してください", 400);
            settings[key] = volume;
          } else if (key === "home_chat_width") {
            const width = Number(value);
            if (!Number.isFinite(width) || width < 240 || width > 760)
              throw fail("チャット幅は240〜760pxで指定してください", 400);
            settings[key] = Math.round(width);
          } else if (key === "default_chat_room") {
            const room = String(value || "room").trim();
            if (!room || room.length > 100)
              throw fail("チャットルーム名が不正です", 400);
            settings[key] = room;
          } else if (key === "chat_theme") {
            const theme = String(value || "blue");
            if (!["blue", "green", "red", "dark"].includes(theme))
              throw fail("チャットテーマが不正です", 400);
            settings[key] = theme;
          }
        }
        if (!Object.keys(settings).length)
          throw fail("保存する設定がありません", 400);
        const { data, error } = await db
          .from("users")
          .update({ settings: { ...(user.settings || {}), ...settings } })
          .eq("id", user.id)
          .select("settings")
          .single();
        if (error) throw error;
        return json(res, 200, { ok: true, settings: data.settings });
      }
      case "account-delete": {
        const { error } = await db.from("users").delete().eq("id", user.id);
        if (error) throw error;
        return json(res, 200, { ok: true });
      }
      case "stamp-purchase": {
        const stampUrl = String(payload.stampUrl || "");
        if (!stampUrl || stampUrl.length > 2000)
          throw fail("スタンプ購入内容が不正です", 400);
        const stamps = Array.isArray(user.stamp_list) ? user.stamp_list : [];
        if (stamps.includes(stampUrl))
          throw fail("このスタンプは購入済みです", 409);
        const price = await getStickerPrice(stampUrl);
        if (price == null) throw fail("存在しないスタンプです", 404);
        if (!Number.isInteger(price) || price < 1)
          throw fail("このスタンプは購入不要です", 400);
        if (Number(user.points || 0) < price)
          throw fail("ポイントが足りません", 400);
        const newStamps = [...stamps, stampUrl];
        await updatePointsCas(db, user.id, user.points, {
          points: Number(user.points || 0) - price,
          stamp_list: newStamps,
        });
        return json(res, 200, {
          ok: true,
          points: Number(user.points || 0) - price,
          stamp_list: newStamps,
        });
      }
      case "transfer-points": {
        const targetUserId = requireId(
          payload.targetUserId,
          "送信先が不正です"
        );
        const amount = Number(payload.amount);
        if (
          targetUserId === String(user.id) ||
          !Number.isInteger(amount) ||
          amount < 1 ||
          amount > 1000 ||
          Number(user.points || 0) < amount
        ) {
          throw fail("ポイント送信内容が不正です", 400);
        }
        const { data: target, error: targetError } = await db
          .from("users")
          .select("id,points")
          .eq("id", targetUserId)
          .maybeSingle();
        if (targetError) throw targetError;
        if (!target) throw fail("送信先が見つかりません", 404);
        await updatePointsCas(db, user.id, user.points, {
          points: Number(user.points || 0) - amount,
        });
        try {
          await updatePointsCas(db, target.id, target.points, {
            points: Number(target.points || 0) + amount,
          });
        } catch (creditError) {
          await db
            .from("users")
            .update({ points: Number(user.points || 0) })
            .eq("id", user.id);
          throw creditError;
        }
        return json(res, 200, {
          ok: true,
          points: Number(user.points || 0) - amount,
        });
      }
      case "chat-points": {
        const amount = Number(payload.amount);
        if (!Number.isInteger(amount) || Math.abs(amount) > 5000)
          throw fail("ポイント数が不正です", 400);
        const points = Math.max(0, Number(user.points || 0) + amount);
        const { error } = await db
          .from("users")
          .update({ points })
          .eq("id", user.id);
        if (error) throw error;
        return json(res, 200, { ok: true, points });
      }
      case "user-login-streak": {
        const today = new Date().toLocaleDateString("en-CA", {
          timeZone: "Asia/Tokyo",
        });
        const last = String(user.last_login_date || "").slice(0, 10);
        if (last === today)
          return json(res, 200, {
            ok: true,
            awarded: false,
            streak: Number(user.login_streak || 0),
            points: Number(user.points || 0),
            bonus: 0,
          });
        const streak = last ? Number(user.login_streak || 0) + 1 : 1;
        const bonus = 5 + (streak % 7 === 0 ? 10 : 0);
        const points = Number(user.points || 0) + bonus;
        const { error } = await db
          .from("users")
          .update({ login_streak: streak, last_login_date: today, points })
          .eq("id", user.id);
        if (error) throw error;
        return json(res, 200, {
          ok: true,
          awarded: true,
          streak,
          points,
          bonus,
        });
      }
      case "weekly-points": {
        const result = await awardWeeklyPostBonus(db, user.id);
        return json(res, 200, { ok: true, ...result });
      }
      case "image-register": {
        const imageUrl = String(payload.imageUrl || "");
        if (!imageUrl || imageUrl.length > 5000)
          throw fail("画像URLが不正です", 400);
        const { error } = await db
          .from("chat_image_assets")
          .insert({
            user_id: user.id,
            image_url: imageUrl,
            delete_url: payload.deleteUrl
              ? String(payload.deleteUrl).slice(0, 5000)
              : null,
          });
        if (error) throw error;
        return json(res, 200, { ok: true });
      }
      case "chat-history-add": {
        const message = String(payload.message || "").trim();
        if (!message) throw fail("メッセージが空です", 400);
        if (message.length > 2000) throw fail("メッセージが長すぎます", 400);
        const msgId =
          payload.msgId == null || payload.msgId === ""
            ? null
            : requireId(payload.msgId, "メッセージIDが不正です");
        let replyTo = null;
        if (payload.replyTo && typeof payload.replyTo === "object") {
          replyTo = {
            msgId: payload.replyTo.msgId
              ? String(payload.replyTo.msgId).slice(0, 64)
              : null,
            name: String(payload.replyTo.name || "").slice(0, 100),
            snippet: String(payload.replyTo.snippet || "").slice(0, 200),
          };
        }
        const { error } = await db
          .from("room_chat_history")
          .insert({
            username: user.username,
            user_id: "id-" + user.id,
            message,
            msg_id: msgId,
            reply_to: replyTo,
          });
        if (error) throw error;
        return json(res, 200, { ok: true });
      }
      case "chat-history-delete": {
        const msgId = requireId(payload.msgId, "メッセージIDが不正です");
        let q = db.from("room_chat_history").delete().eq("msg_id", msgId);
        if (!admin) q = q.in("user_id", ["id-" + user.id, String(user.id)]);
        const { error } = await q;
        if (error) throw error;
        return json(res, 200, { ok: true });
      }
      case "developer-message-read": {
        const ids = (Array.isArray(payload.ids) ? payload.ids : [])
          .slice(0, 100)
          .map((v) => String(v))
          .filter((v) => /^[A-Za-z0-9_-]{1,64}$/.test(v));
        if (!ids.length) return json(res, 200, { ok: true });
        const { error } = await db
          .from("developer_messages")
          .update({ read: true })
          .in("id", ids)
          .eq("user_id", user.id);
        if (error) throw error;
        return json(res, 200, { ok: true });
      }
      case "developer-inbox-send": {
        const message = String(payload.message || "").trim();
        if (!message || message.length > 2000)
          throw fail("内容を入力してください(2000文字まで)", 400);
        const { error } = await db
          .from("developer_inbox")
          .insert({ user_id: user.id, username: user.username, message });
        if (error) throw error;
        return json(res, 200, { ok: true });
      }
      case "ban": {
        if (!admin) throw fail("BAN権限がありません", 403);
        const targetId = requireId(
          payload.targetUserId,
          "対象ユーザーが不正です"
        );
        const minutes = Math.max(
          1,
          Math.min(525600, Number(payload.banMinutes) || 5)
        );
        const { data: target, error: targetError } = await db
          .from("users")
          .select("id,role,ban_count,points")
          .eq("id", targetId)
          .maybeSingle();
        if (targetError) throw targetError;
        if (!target) throw fail("対象ユーザーが見つかりません", 404);
        if (target.role === "developer" && user.role !== "developer")
          throw fail("developerをBANできるのはdeveloperのみです", 403);
        const banUntil = new Date(Date.now() + minutes * 60000).toISOString();
        const { error } = await db
          .from("users")
          .update({
            ban_count: Number(target.ban_count || 0) + 1,
            ban_until: banUntil,
            points: Math.max(0, Number(target.points || 0) - 100),
          })
          .eq("id", targetId);
        if (error) throw error;
        return json(res, 200, { ok: true, banUntil });
      }
      case "admin-user-update": {
        if (!admin) throw fail("管理者権限が必要です", 403);
        const targetId = requireId(
          payload.targetUserId,
          "対象ユーザーが不正です"
        );
        const { data: target, error: targetError } = await db
          .from("users")
          .select("id,role")
          .eq("id", targetId)
          .maybeSingle();
        if (targetError) throw targetError;
        if (!target) throw fail("対象ユーザーが見つかりません", 404);
        if (target.role === "developer" && user.role !== "developer")
          throw fail("developerを変更できるのはdeveloperのみです", 403);
        if (payload.deleteAccount === true) {
          const { error } = await db.from("users").delete().eq("id", targetId);
          if (error) throw error;
          return json(res, 200, {
            ok: true,
            message: "ユーザーを削除しました",
          });
        }
        const patch = {};
        if (Object.prototype.hasOwnProperty.call(payload, "role")) {
          const role = String(payload.role);
          if (!["user", "admin", "developer"].includes(role))
            throw fail("ロールが不正です", 400);
          if (role === "developer" && user.role !== "developer")
            throw fail("developer権限の付与はdeveloperのみ可能です", 403);
          patch.role = role;
        }
        if (Object.prototype.hasOwnProperty.call(payload, "verified")) {
          if (typeof payload.verified !== "boolean")
            throw fail("認証状態が不正です", 400);
          patch.verified = payload.verified;
        }
        const banKey = Object.prototype.hasOwnProperty.call(payload, "banUntil")
          ? "banUntil"
          : Object.prototype.hasOwnProperty.call(payload, "ban_until")
          ? "ban_until"
          : null;
        if (banKey) {
          const v = payload[banKey];
          if (v === null) patch.ban_until = null;
          else {
            const d = new Date(v);
            if (Number.isNaN(d.getTime())) throw fail("BAN期限が不正です", 400);
            patch.ban_until = d.toISOString();
          }
        }
        for (const key of ["ban_count", "points"]) {
          if (Object.prototype.hasOwnProperty.call(payload, key)) {
            const n = Number(payload[key]);
            if (!Number.isFinite(n)) throw fail(`${key} が不正です`, 400);
            patch[key] = Math.trunc(n);
          }
        }
        if (Object.prototype.hasOwnProperty.call(payload, "newPassword")) {
          const password = String(payload.newPassword || "");
          if (password.length < 8)
            throw fail("パスワードは8文字以上にしてください", 400);
          patch.password_hash = sha256(password);
        }
        if (!Object.keys(patch).length)
          throw fail("変更内容を確認してください", 400);
        const { error } = await db
          .from("users")
          .update(patch)
          .eq("id", targetId);
        if (error) throw error;
        return json(res, 200, { ok: true });
      }
      case "ip-ban": {
        if (!admin) throw fail("管理者権限が必要です", 403);
        const rawIp = String(payload.ipAddress || "").trim();
        if (
          !rawIp ||
          rawIp.length > 100 ||
          !/^[0-9a-fA-F:.%a-zA-Z0-9_-]+$/.test(rawIp)
        ) {
          throw fail("IPアドレスの形式が不正です", 400);
        }
        const minutes = Math.max(
          1,
          Math.min(525600, Number(payload.minutes) || 60)
        );
        const { error } = await db
          .from("banned_ip_addresses")
          .upsert(
            {
              ip_hash: hashIp(rawIp),
              reason: String(payload.reason || "管理者によるIP BAN").slice(
                0,
                300
              ),
              expires_at: new Date(Date.now() + minutes * 60000).toISOString(),
              created_by: user.id,
            },
            { onConflict: "ip_hash" }
          );
        if (error) throw error;
        return json(res, 200, {
          ok: true,
          expiresAt: new Date(Date.now() + minutes * 60000).toISOString(),
        });
      }
      case "ip-unban": {
        if (!admin) throw fail("管理者権限が必要です", 403);
        const rawIp = String(payload.ipAddress || "").trim();
        if (
          !rawIp ||
          rawIp.length > 100 ||
          !/^[0-9a-fA-F:.%a-zA-Z0-9_-]+$/.test(rawIp)
        ) {
          throw fail("IPアドレスの形式が不正です", 400);
        }
        const { error } = await db
          .from("banned_ip_addresses")
          .delete()
          .eq("ip_hash", hashIp(rawIp));
        if (error) throw error;
        return json(res, 200, { ok: true });
      }
      default:
        return json(res, 400, { error: "未対応のAPI操作です", action });
    }
  } catch (error) {
    console.error("secure API error:", error.message || error);
    if (error.retryAfter)
      res.setHeader("Retry-After", String(error.retryAfter));
    return json(res, error.status || 500, {
      error: error.message || "サーバー処理に失敗しました",
      retryAfter: error.retryAfter || undefined,
    });
  }
};
