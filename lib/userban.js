import { db, validIp, hashIp } from "./db";
import { axiomQuery, axiomIngest } from "./axiom";
import { hogql } from "./posthog";

const PERM_UNTIL = "2099-12-31T00:00:00.000Z";
const PROTECTED = ["admin", "developer"];
const devKey = (d) => "device:" + String(d).trim().toLowerCase();

// 実行前にBAN対象を洗い出す(dryRunで画面に表示するため)
export async function planUserBan({ username, withIp = true, withDevice = true, cascade = true, ipSource = "both", days = 30 }) {
  const sb = db();
  const warnings = [];
  const { data: target, error } = await sb.from("users").select("id,username,role").eq("username", username).maybeSingle();
  if (error) throw error;
  if (!target) throw Object.assign(new Error("ユーザーが見つかりません"), { status: 404 });
  if (PROTECTED.includes(target.role)) throw Object.assign(new Error("admin / developer はこの画面ではBANできません"), { status: 403 });

  const devices = new Set();
  const seen = new Set([target.id]);
  const queue = [target.id];
  const useDevices = withDevice || cascade;
  while (useDevices && queue.length && seen.size <= 50) {
    const uid = queue.shift();
    const { data: devs, error: e1 } = await sb.from("user_devices").select("device_hash").eq("user_id", uid).limit(200);
    if (e1) throw e1;
    for (const d of devs || []) {
      const h = String(d.device_hash).toLowerCase();
      devices.add(h);
      if (!cascade) continue;
      const { data: others, error: e2 } = await sb.from("user_devices").select("user_id").eq("device_hash", d.device_hash).limit(200);
      if (e2) throw e2;
      for (const o of others || []) if (!seen.has(o.user_id)) { seen.add(o.user_id); queue.push(o.user_id); }
    }
  }
  if (seen.size > 50) warnings.push("関連アカウントが多いため、50件までで打ち切りました");

  const { data: users, error: e3 } = await sb.from("users").select("id,username,role").in("id", [...seen]);
  if (e3) throw e3;
  const accounts = [], skipped = [];
  for (const u of users || []) (PROTECTED.includes(u.role) ? skipped : accounts).push({ id: u.id, username: u.username, role: u.role });
  if (skipped.length) warnings.push(`admin / developer のアカウントはBANしません: ${skipped.map((s) => s.username).join(", ")}`);

  // ---- IP収集: PostHog の Person(distinct_id = Supabase ID)と Axiom のログ ----
  const info = new Map();
  const add = (ip, src, extra = {}) => {
    ip = String(ip || "").trim();
    if (!ip || ip === "unknown" || !validIp(ip)) return;
    const e = info.get(ip) || { ip, sources: [], country: "", city: "", last_seen: null, n: 0 };
    if (!e.sources.includes(src)) e.sources.push(src);
    if (extra.country && !e.country) e.country = extra.country;
    if (extra.city && !e.city) e.city = extra.city;
    if (extra.last_seen && (!e.last_seen || new Date(extra.last_seen) > new Date(e.last_seen))) e.last_seen = extra.last_seen;
    e.n += Number(extra.n || 0);
    info.set(ip, e);
  };
  if (withIp) {
    const d = Math.max(1, Math.min(90, days));
    if (ipSource === "both" || ipSource === "posthog") {
      try {
        const list = accounts.map((a) => a.id).filter((id) => /^[A-Za-z0-9_-]{1,64}$/.test(id)).map((id) => `'${id}'`).join(",");
        if (list) {
          const rows = await hogql(`SELECT properties.$ip AS ip, count() AS n, max(timestamp) AS last_seen, any(properties.$geoip_country_name) AS country, any(properties.$geoip_city_name) AS city FROM events WHERE timestamp > now() - INTERVAL ${d} DAY AND (distinct_id IN (${list}) OR properties.user_id IN (${list})) AND isNotNull(properties.$ip) GROUP BY ip ORDER BY last_seen DESC LIMIT 60`);
          for (const r of rows) add(r.ip, "PostHog", r);
          if (!rows.length) warnings.push("PostHogのPersonにIPの記録がありません(フロントで posthog.identify(user.id) が必要です)");
        }
      } catch (e) { warnings.push("PostHogからIPを取得できませんでした: " + e.message); }
    }
    if (ipSource === "both" || ipSource === "axiom") {
      try {
        const ds = (process.env.AXIOM_DATASET || "chanpro").replace(/[^\w-]/g, "");
        const names = accounts.map((a) => JSON.stringify(a.username)).join(", ");
        const rows = await axiomQuery(`['${ds}'] | where _time > ago(${d}d) | where type in ("login_success","register_created","access") | where username in (${names}) | summarize n=count() by ip | order by n desc | take 50`);
        for (const r of rows) add(r.ip, "Axiom", r);
      } catch (e) { warnings.push("AxiomからIPを取得できませんでした: " + e.message); }
    }
    if (!info.size && !warnings.length) warnings.push("IPの記録が見つかりませんでした");
  }
  const ipDetails = [...info.values()].sort((a, b) => (b.sources.length - a.sources.length) || (new Date(b.last_seen || 0) - new Date(a.last_seen || 0))).slice(0, 80);
  const ips = ipDetails.map((x) => x.ip);
  return { target, accounts, skipped, devices: [...devices], ips, ipDetails, warnings };
}

export async function executeUserBan(plan, { minutes, reason }) {
  const sb = db();
  const permanent = Number(minutes) === 0;
  const expires_at = permanent ? null : new Date(Date.now() + Math.max(1, Math.min(525600, Number(minutes) || 60)) * 60000).toISOString();
  const banUntil = permanent ? PERM_UNTIL : expires_at;
  const why = String(reason || "管理者によるBAN").slice(0, 250);

  if (plan.accounts.length) {
    const { error } = await sb.from("users").update({ ban_until: banUntil }).in("id", plan.accounts.map((a) => a.id));
    if (error) throw error;
  }
  const base = { expires_at, user_id: plan.target.id, username: plan.target.username };
  const rows = [
    ...plan.ips.map((ip) => ({ ...base, ip_hash: hashIp(ip), kind: "ip", reason: `${why} (user:${plan.target.username})` })),
    ...plan.devices.map((d) => ({ ...base, ip_hash: devKey(d), kind: "device", reason: `${why} (device of ${plan.target.username})` })),
  ];
  if (rows.length) {
    const { error } = await sb.from("banned_ip_addresses").upsert(rows, { onConflict: "ip_hash" });
    if (error) throw error;
  }
  await axiomIngest([{ type: "admin_user_ban", username: plan.target.username, accounts: plan.accounts.map((a) => a.username), ips: plan.ips, device_count: plan.devices.length, permanent, minutes, reason: why }]);
  return { accounts: plan.accounts.length, ips: plan.ips.length, devices: plan.devices.length, permanent };
}

export async function unbanUser(username) {
  const sb = db();
  const { data: rows, error } = await sb.from("banned_ip_addresses").select("ip_hash,kind").eq("username", username);
  if (error) throw error;
  const devices = (rows || []).filter((r) => r.kind === "device").map((r) => r.ip_hash.replace(/^device:/, ""));
  const ids = new Set();
  const { data: t } = await sb.from("users").select("id").eq("username", username).maybeSingle();
  if (t) ids.add(t.id);
  if (devices.length) {
    const { data: ud } = await sb.from("user_devices").select("user_id").in("device_hash", devices);
    for (const r of ud || []) ids.add(r.user_id);
  }
  if (rows?.length) {
    const { error: de } = await sb.from("banned_ip_addresses").delete().eq("username", username);
    if (de) throw de;
  }
  let accounts = 0;
  if (ids.size) {
    const { data: up, error: ue } = await sb.from("users").update({ ban_until: null }).in("id", [...ids]).gt("ban_until", new Date().toISOString()).select("id");
    if (ue) throw ue;
    accounts = up?.length || 0;
  }
  await axiomIngest([{ type: "admin_user_unban", username, removed_rows: rows?.length || 0, accounts }]);
  return { removed: rows?.length || 0, accounts };
}
