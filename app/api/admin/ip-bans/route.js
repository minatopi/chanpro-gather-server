import { NextResponse } from "next/server";
import { guard, fail } from "@/lib/api";
import { db, hashIp, validIp } from "@/lib/db";
import { axiomIngest } from "@/lib/axiom";

export const GET = guard(async () => {
  const { data, error } = await db().from("banned_ip_addresses").select("ip_hash,reason,expires_at,kind,username").order("expires_at", { ascending: false }).limit(200);
  if (error) throw error;
  return NextResponse.json({ bans: data });
});

export const POST = guard(async (req) => {
  const b = await req.json();
  const ip = String(b.ip || "").trim();
  if (!validIp(ip)) return fail("IPアドレスの形式が不正です");
  const minutes = Math.max(1, Math.min(525600, Number(b.minutes) || 60));
  const reason = String(b.reason || "管理者によるIP BAN").slice(0, 300);
  const ip_hash = hashIp(ip);
  const { error } = await db().from("banned_ip_addresses").upsert(
    { ip_hash, reason, expires_at: new Date(Date.now() + minutes * 60000).toISOString() },
    { onConflict: "ip_hash" });
  if (error) throw error;
  await axiomIngest([{ type: "admin_ip_ban", ip, ip_hash, minutes, reason }]);
  return NextResponse.json({ ok: true });
});

// body: { ip } または { ip_hash }
export const DELETE = guard(async (req) => {
  const b = await req.json();
  const ip_hash = b.ip_hash || (validIp(String(b.ip || "").trim()) ? hashIp(b.ip) : "");
  if (!ip_hash) return fail("対象が不正です");
  const { error } = await db().from("banned_ip_addresses").delete().eq("ip_hash", ip_hash);
  if (error) throw error;
  await axiomIngest([{ type: "admin_ip_unban", ip_hash }]);
  return NextResponse.json({ ok: true });
});
