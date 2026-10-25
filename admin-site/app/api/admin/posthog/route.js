import { NextResponse } from "next/server";
import { guard, fail } from "@/lib/api";
import { hogql } from "@/lib/posthog";

// ?userId=...&username=...&days=7
export const GET = guard(async (req) => {
  const sp = new URL(req.url).searchParams;
  const userId = (sp.get("userId") || "").trim();
  const username = (sp.get("username") || "").trim();
  if (!userId && !username) return fail("userId か username が必要です");
  const days = Math.max(1, Math.min(90, parseInt(sp.get("days"), 10) || 7));
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
  return NextResponse.json({ recent, top });
});
