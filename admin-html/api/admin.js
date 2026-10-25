// 管理サイトのバックエンド。秘密キーはここ(サーバー)だけで使い、HTMLには一切出しません。
const { createClient } = require("@supabase/supabase-js");
const crypto = require("node:crypto");
const E = process.env;

const COOKIE = "admin_session";
const TTL = 8 * 60 * 60;
const sha = (v) => crypto.createHash("sha256").update(String(v), "utf8").digest();
const sessionSecret = () => E.ADMIN_SESSION_SECRET || E.ADMIN_PASSWORD || "";

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// ---- セッション ----
function signSession() {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + TTL, n: crypto.randomUUID() })).toString("base64url");
  return payload + "." + crypto.createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}
function verifySession(token) {
  if (!token || !sessionSecret()) return false;
  const [payload, sig] = String(token).split(".");
  if (!payload || !sig) return false;
  const exp = crypto.createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(exp);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString()).exp > Date.now() / 1000; } catch { return false; }
}
function getCookie(req, name) {
  const m = String(req.headers.cookie || "").split(";").map((s) => s.trim()).find((s) => s.startsWith(name + "="));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : "";
}
const cookieStr = (v, age) => `${COOKIE}=${encodeURIComponent(v)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${age}`;

// ---- 外部サービス ----
function db() {
  if (!E.SUPABASE_URL || !E.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です");
  return createClient(E.SUPABASE_URL, E.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}
function hashIp(ip) {
  const secret = E.IP_HASH_SECRET || E.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!secret) throw new Error("IP_HASH_SECRET が未設定です");
  return crypto.createHash("sha256").update(secret + ":" + String(ip).trim().toLowerCase(), "utf8").digest("hex");
}
const validIp = (ip) => !!ip && ip.length <= 100 && /^[0-9a-fA-F:.%a-zA-Z0-9_-]+$/.test(ip);

const AX = "https://api.axiom.co/v1/datasets";
const axDataset = () => (E.AXIOM_DATASET || "chanpro").replace(/[^\w-]/g, "");
async function axiomIngest(events) {
  if (!E.AXIOM_TOKEN) return;
  try {
    await fetch(`${AX}/${axDataset()}/ingest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${E.AXIOM_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(events.map((e) => ({ _time: new Date().toISOString(), source: "admin-site", ...e }))),
      signal: AbortSignal.timeout(2500)
    });
  } catch (e) { console.warn("axiom ingest failed", e?.message); }
}
async function axiomQuery(apl) {
  if (!E.AXIOM_TOKEN) throw new Error("AXIOM_TOKEN が未設定です");
  const r = await fetch(`${AX}/_apl?format=legacy`, {
    method: "POST",
    headers: { Authorization: `Bearer ${E.AXIOM_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ apl })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Axiom error ${r.status}`);
  if (Array.isArray(j.matches)) return j.matches.map((m) => ({ _time: m._time, ...(m.data || {}) }));
  const t = j.tables?.[0];
  if (!t) return [];
  const names = t.fields.map((f) => f.name);
  const n = t.columns?.[0]?.length || 0;
  return Array.from({ length: n }, (_, i) => Object.fromEntries(names.map((k, c) => [k, t.columns[c][i]])));
}
async function hogql(query, values) {
  if (!E.POSTHOG_PERSONAL_API_KEY || !E.POSTHOG_PROJECT_ID) throw new Error("POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID が未設定です");
  const host = (E.POSTHOG_APP_HOST || "https://us.posthog.com").replace(/\/$/, "");
  const r = await fetch(`${host}/api/projects/${E.POSTHOG_PROJECT_ID}/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${E.POSTHOG_PERSONAL_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query, values } })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || `PostHog error ${r.status}`);
  const cols = j.columns || [];
  return (j.results || []).map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

// ---- ログイン試行制限(簡易・インスタンス単位) ----
const fails = new Map();

const USER_FIELDS = "id,username,role,verified,ban_until,ban_count,points";
const BOOL_KEYS = ["login_enabled", "register_enabled"];
const TEXT_KEYS = ["login_disabled_message", "register_disabled_message"];
const REPORT_STATUS = ["open", "resolved", "dismissed"];
const LOG_TYPES = {
  login: ["login_success", "login_failed", "register_created", "login_blocked", "register_blocked"],
  access: ["access"],
  ip: ["ip_banned_request", "ip_rate_limited", "admin_ip_ban", "admin_ip_unban"]
};

module.exports = async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  // 他サイトからのリクエストを拒否(同一オリジンのみ)
  const origin = req.headers.origin;
  if (origin) { try { if (new URL(origin).host !== req.headers.host) return send(res, 403, { error: "forbidden origin" }); } catch { return send(res, 403, { error: "forbidden origin" }); } }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const action = String(body.action || "");
    const ip = String(req.headers["x-real-ip"] || req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();

    if (action === "login") {
      const f = fails.get(ip) || { n: 0, until: 0 };
      if (f.until > Date.now()) throw bad("しばらく待ってから再試行してください", 429);
      const pw = E.ADMIN_PASSWORD || "";
      const ok = !!pw && crypto.timingSafeEqual(sha(body.password || ""), sha(pw));
      if (!ok) {
        f.n += 1; if (f.n >= 5) { f.until = Date.now() + 15 * 60000; f.n = 0; }
        fails.set(ip, f);
        await new Promise((r) => setTimeout(r, 600));
        await axiomIngest([{ type: "admin_login_failed", ip }]);
        throw bad("パスワードが違います", 401);
      }
      fails.delete(ip);
      await axiomIngest([{ type: "admin_login_success", ip }]);
      return send(res, 200, { ok: true }, { "Set-Cookie": cookieStr(signSession(), TTL) });
    }
    if (action === "logout") return send(res, 200, { ok: true }, { "Set-Cookie": cookieStr("", 0) });

    if (!verifySession(getCookie(req, COOKIE))) throw bad("unauthorized", 401);
    if (action === "me") return send(res, 200, { ok: true });

    const sb = db();
    switch (action) {
      case "settings-get": {
        const { data, error } = await sb.from("app_settings").select("key,value");
        if (error) throw error;
        return send(res, 200, { settings: Object.fromEntries((data || []).map((r) => [r.key, r.value])) });
      }
      case "settings-set": {
        const { key, value } = body;
        if (![...BOOL_KEYS, ...TEXT_KEYS].includes(key)) throw bad("未対応のキーです");
        if (BOOL_KEYS.includes(key) && typeof value !== "boolean") throw bad("値が不正です");
        if (TEXT_KEYS.includes(key) && (typeof value !== "string" || value.length > 200)) throw bad("値が不正です");
        const { error } = await sb.from("app_settings").upsert({ key, value, updated_at: new Date().toISOString() });
        if (error) throw error;
        await axiomIngest([{ type: "admin_setting_changed", key, value }]);
        return send(res, 200, { ok: true });
      }
      case "users-list": {
        const q = String(body.q || "").trim().replace(/[%,()]/g, "");
        let query = sb.from("users").select(USER_FIELDS).limit(50);
        if (q) query = query.ilike("username", `%${q}%`);
        const { data, error } = await query;
        if (error) throw error;
        return send(res, 200, { users: data });
      }
      case "user-update": {
        if (!body.id) throw bad("idがありません");
        const patch = {};
        if ("role" in body) {
          if (!["user", "admin", "developer"].includes(body.role)) throw bad("ロールが不正です");
          patch.role = body.role;
        }
        if ("verified" in body) {
          if (typeof body.verified !== "boolean") throw bad("verifiedが不正です");
          patch.verified = body.verified;
        }
        if ("banMinutes" in body) {
          const m = Number(body.banMinutes);
          if (!Number.isFinite(m) || m < 0 || m > 525600) throw bad("BAN時間が不正です");
          patch.ban_until = m === 0 ? null : new Date(Date.now() + m * 60000).toISOString();
        }
        if (!Object.keys(patch).length) throw bad("変更内容がありません");
        const { data, error } = await sb.from("users").update(patch).eq("id", body.id).select(USER_FIELDS).single();
        if (error) throw error;
        await axiomIngest([{ type: "admin_user_update", target_user_id: body.id, patch }]);
        return send(res, 200, { user: data });
      }
      case "ip-bans-list": {
        const { data, error } = await sb.from("banned_ip_addresses").select("ip_hash,reason,expires_at").order("expires_at", { ascending: false }).limit(200);
        if (error) throw error;
        return send(res, 200, { bans: data });
      }
      case "ip-ban": {
        const target = String(body.ip || "").trim();
        if (!validIp(target)) throw bad("IPアドレスの形式が不正です");
        const minutes = Math.max(1, Math.min(525600, Number(body.minutes) || 60));
        const reason = String(body.reason || "管理者によるIP BAN").slice(0, 300);
        const ip_hash = hashIp(target);
        const { error } = await sb.from("banned_ip_addresses").upsert(
          { ip_hash, reason, expires_at: new Date(Date.now() + minutes * 60000).toISOString() }, { onConflict: "ip_hash" });
        if (error) throw error;
        await axiomIngest([{ type: "admin_ip_ban", ip: target, ip_hash, minutes, reason }]);
        return send(res, 200, { ok: true });
      }
      case "ip-unban": {
        const ip_hash = body.ip_hash || (validIp(String(body.ip || "").trim()) ? hashIp(body.ip) : "");
        if (!ip_hash) throw bad("対象が不正です");
        const { error } = await sb.from("banned_ip_addresses").delete().eq("ip_hash", ip_hash);
        if (error) throw error;
        await axiomIngest([{ type: "admin_ip_unban", ip_hash }]);
        return send(res, 200, { ok: true });
      }
      case "reports-list": {
        let q = sb.from("gather_reports").select("id,user_id,username,content,status,created_at").order("created_at", { ascending: false }).limit(200);
        if (REPORT_STATUS.includes(body.status)) q = q.eq("status", body.status);
        const { data, error } = await q;
        if (error) throw error;
        return send(res, 200, { reports: data });
      }
      case "report-update": {
        if (!body.id || !REPORT_STATUS.includes(body.status)) throw bad("入力が不正です");
        const { error } = await sb.from("gather_reports").update({ status: body.status }).eq("id", body.id);
        if (error) throw error;
        return send(res, 200, { ok: true });
      }
      case "logs": {
        const kind = LOG_TYPES[body.kind] ? body.kind : "login";
        const hours = Math.max(1, Math.min(720, parseInt(body.hours, 10) || 24));
        const username = String(body.username || "").trim().slice(0, 100);
        const types = LOG_TYPES[kind].map((t) => JSON.stringify(t)).join(", ");
        let apl = `['${axDataset()}'] | where _time > ago(${hours}h) | where type in (${types})`;
        if (username) apl += ` | where username == ${JSON.stringify(username)}`;
        apl += " | sort by _time desc | take 300";
        return send(res, 200, { rows: await axiomQuery(apl) });
      }
      case "posthog": {
        const userId = String(body.userId || "").trim();
        const username = String(body.username || "").trim();
        if (!userId && !username) throw bad("userId か username が必要です");
        const days = Math.max(1, Math.min(90, parseInt(body.days, 10) || 7));
        const values = { uid: userId || "__none__", uname: username || "__none__" };
        const who = `(distinct_id = {uid} OR properties.user_id = {uid} OR properties.username = {uname})`;
        const recent = await hogql(
          `SELECT timestamp, event, properties.$current_url AS url, properties.$pathname AS path, properties.$ip AS ip
           FROM events WHERE timestamp > now() - INTERVAL ${days} DAY AND ${who}
           AND event IN ('$pageview','$pageleave') ORDER BY timestamp DESC LIMIT 200`, values);
        const top = await hogql(
          `SELECT properties.$pathname AS path, count() AS views, max(timestamp) AS last_seen
           FROM events WHERE timestamp > now() - INTERVAL ${days} DAY AND ${who} AND event = '$pageview'
           GROUP BY path ORDER BY views DESC LIMIT 30`, values);
        return send(res, 200, { recent, top });
      }
      default:
        throw bad("未対応の操作です");
    }
  } catch (e) {
    if (e?.status !== 401) console.error("admin api error:", e?.message || e);
    return send(res, e?.status || 500, { error: e?.message || "サーバーエラー" });
  }
};
