import { NextResponse } from "next/server";
import { guard } from "@/lib/api";
import { db } from "@/lib/db";
import { axiomQuery } from "@/lib/axiom";
import { loadStatus } from "@/lib/status";

const safeCount = async (q) => {
  try { const { count, error } = await q; if (error) throw error; return count || 0; } catch { return null; }
};

export const GET = guard(async () => {
  const sb = db(); const now = new Date().toISOString();
  const head = { count: "exact", head: true };
  const [users, verified, banned, openReports, openUserReports, ipBans] = await Promise.all([
    safeCount(sb.from("users").select("id", head)),
    safeCount(sb.from("users").select("id", head).eq("verified", true)),
    safeCount(sb.from("users").select("id", head).gt("ban_until", now)),
    safeCount(sb.from("gather_reports").select("id", head).eq("status", "open")),
    safeCount(sb.from("reports").select("id", head).neq("status", "resolved")),
    safeCount(sb.from("banned_ip_addresses").select("ip_hash", head).or(`expires_at.is.null,expires_at.gt.${now}`)),
  ]);
  const { data: st } = await sb.from("app_settings").select("key,value");
  const settings = Object.fromEntries((st || []).map((r) => [r.key, r.value]));

  let activity = null, activityError = "";
  try {
    const ds = (process.env.AXIOM_DATASET || "chanpro").replace(/[^\w-]/g, "");
    activity = await axiomQuery(`['${ds}'] | where _time > ago(24h) | summarize n=count() by type | order by n desc | take 12`);
  } catch (e) { activityError = e.message; }

  let featureStatus = null;
  try { featureStatus = (await loadStatus(30)).current; } catch { /* Axiom未設定でも表示は続行 */ }

  return NextResponse.json({ users, verified, banned, openReports, openUserReports, ipBans, settings, activity, activityError, featureStatus });
});
