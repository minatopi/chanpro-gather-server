import { NextResponse } from "next/server";
import { guard, fail } from "@/lib/api";
import { planUserBan, executeUserBan, unbanUser } from "@/lib/userban";

// body: { username, minutes(0=無期限), reason, withIp, withDevice, cascade, dryRun }
export const POST = guard(async (req) => {
  const b = await req.json();
  const username = String(b.username || "").trim();
  if (!username || username.length > 100) return fail("ユーザー名を入力してください");
  const plan = await planUserBan({ username, withIp: b.withIp !== false, withDevice: b.withDevice !== false, cascade: b.cascade !== false, ipSource: ["both", "posthog", "axiom"].includes(b.ipSource) ? b.ipSource : "both" });
  if (b.dryRun) return NextResponse.json({ plan: { ...plan, devices: plan.devices.map((d) => d.slice(0, 8) + "…") } });
  const minutes = Number(b.minutes);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 525600) return fail("BAN時間が不正です");
  return NextResponse.json({ ok: true, result: await executeUserBan(plan, { minutes, reason: b.reason }) });
});

// body: { username }  ユーザー名BANで作成した行をまとめて解除
export const DELETE = guard(async (req) => {
  const { username } = await req.json();
  if (!username) return fail("ユーザー名を入力してください");
  return NextResponse.json({ ok: true, result: await unbanUser(String(username).trim()) });
});
