import { NextResponse } from "next/server";
import { guard, fail } from "@/lib/api";
import { hogql } from "@/lib/posthog";

const parse = (v) => { if (v && typeof v === "string") { try { return JSON.parse(v); } catch { return {}; } } return v || {}; };

// ?userId=<Supabase ID = PostHogのdistinct_id>&username=...&days=30
export const GET = guard(async (req) => {
  const sp = new URL(req.url).searchParams;
  const userId = (sp.get("userId") || "").trim();
  if (!userId) return fail("userId が必要です");
  const days = Math.max(1, Math.min(365, parseInt(sp.get("days"), 10) || 30));
  const values = { uid: userId };
  const ts = `timestamp > now() - INTERVAL ${days} DAY`;
  // mine: フロントから identify された本人のイベント / who: サーバー側セキュリティイベント(user_id付き)も含む
  const mine = `distinct_id = {uid}`;
  const who = `(distinct_id = {uid} OR properties.user_id = {uid})`;

  const jobs = {
    person: async () => {
      let rows = await hogql(`SELECT id, created_at, properties FROM persons WHERE id IN (SELECT person_id FROM person_distinct_ids WHERE distinct_id = {uid}) LIMIT 1`, values).catch(() => []);
      if (!rows.length) rows = await hogql(`SELECT person.id AS id, person.created_at AS created_at, person.properties AS properties FROM events WHERE ${mine} ORDER BY timestamp DESC LIMIT 1`, values);
      return rows[0] ? { id: rows[0].id, created_at: rows[0].created_at, properties: parse(rows[0].properties) } : null;
    },
    stats: async () => (await hogql(`SELECT min(timestamp) AS first_seen, max(timestamp) AS last_seen, count() AS events, uniq(properties.$session_id) AS sessions FROM events WHERE ${ts} AND ${mine}`, values))[0] || null,
    ips: () => hogql(`SELECT properties.$ip AS ip, count() AS n, max(timestamp) AS last_seen, any(properties.$geoip_country_name) AS country, any(properties.$geoip_city_name) AS city FROM events WHERE ${ts} AND ${who} AND isNotNull(properties.$ip) GROUP BY ip ORDER BY last_seen DESC LIMIT 15`, values),
    devices: () => hogql(`SELECT properties.$browser AS browser, properties.$os AS os, properties.$device_type AS device, count() AS n, max(timestamp) AS last_seen FROM events WHERE ${ts} AND ${mine} AND event = '$pageview' GROUP BY browser, os, device ORDER BY last_seen DESC LIMIT 8`, values),
    top: () => hogql(`SELECT properties.$pathname AS path, count() AS views, max(timestamp) AS last_seen FROM events WHERE ${ts} AND ${who} AND event = '$pageview' GROUP BY path ORDER BY views DESC LIMIT 20`, values),
    recent: () => hogql(`SELECT timestamp, event, properties.$current_url AS url, properties.$pathname AS path, properties.$ip AS ip FROM events WHERE ${ts} AND ${who} AND event IN ('$pageview','$pageleave') ORDER BY timestamp DESC LIMIT 60`, values),
  };
  const keys = Object.keys(jobs);
  const res = await Promise.allSettled(keys.map((k) => jobs[k]()));
  const out = {}, errors = [];
  res.forEach((r, i) => { if (r.status === "fulfilled") out[keys[i]] = r.value; else errors.push(`${keys[i]}: ${r.reason?.message || r.reason}`); });
  if (errors.length === keys.length) throw new Error(errors[0]);

  const host = (process.env.POSTHOG_APP_HOST || "https://us.posthog.com").replace(/\/$/, "");
  const personUrl = out.person?.id ? `${host}/project/${process.env.POSTHOG_PROJECT_ID}/person/${encodeURIComponent(userId)}` : null;
  return NextResponse.json({ ...out, personUrl, errors, days });
});
