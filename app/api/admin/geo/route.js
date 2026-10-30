import { NextResponse } from "next/server";
import { guard } from "@/lib/api";
import { db } from "@/lib/db";
import { hogql } from "@/lib/posthog";

// PostHog の GeoIP(IPからの推定位置)をユーザーごとに集計
export const GET = guard(async (req) => {
  const days = Math.max(1, Math.min(365, parseInt(new URL(req.url).searchParams.get("days"), 10) || 30));
  const raw = await hogql(
    `SELECT if(distinct_id = 'chanpro-server-security', toString(properties.user_id), distinct_id) AS uid,
            properties.$geoip_country_code AS cc, properties.$geoip_country_name AS country,
            properties.$geoip_subdivision_1_name AS region, properties.$geoip_city_name AS city,
            round(toFloat(properties.$geoip_latitude), 2) AS lat, round(toFloat(properties.$geoip_longitude), 2) AS lon,
            count() AS n, max(timestamp) AS last_seen
     FROM events
     WHERE timestamp > now() - INTERVAL ${days} DAY AND isNotNull(properties.$geoip_latitude)
       AND event IN ('$pageview','chanpro_login_success','chanpro_registration_created')
     GROUP BY uid, cc, country, region, city, lat, lon ORDER BY n DESC LIMIT 3000`);
  const rows = raw.filter((r) => r.uid && r.uid !== "chanpro-server-security" && Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lon)));

  const ids = [...new Set(rows.map((r) => r.uid))];
  const names = {};
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await db().from("users").select("id,username").in("id", ids.slice(i, i + 100));
    for (const u of data || []) names[u.id] = u.username;
  }
  return NextResponse.json({
    days,
    rows: rows.map((r) => ({ uid: r.uid, username: names[r.uid] || "", cc: r.cc || "", country: r.country || "", region: r.region || "", city: r.city || "", lat: Number(r.lat), lon: Number(r.lon), n: Number(r.n), last_seen: r.last_seen })),
  });
});
