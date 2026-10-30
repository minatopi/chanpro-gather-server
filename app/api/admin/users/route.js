import { NextResponse } from "next/server";
import { guard, fail } from "@/lib/api";
import { db } from "@/lib/db";
import { axiomIngest } from "@/lib/axiom";

const FIELDS = "id,username,role,verified,ban_until,ban_count,points,icon_url";
const PERM_UNTIL = "2099-12-31T00:00:00.000Z";

export const GET = guard(async (req) => {
  const sp = new URL(req.url).searchParams;
  const q = (sp.get("q") || "").trim().replace(/[%,()]/g, "");
  const filter = sp.get("filter") || "all";
  let query = db().from("users").select(FIELDS).order("username", { ascending: true }).limit(60);
  if (q) query = query.ilike("username", `%${q}%`);
  if (filter === "banned") query = query.gt("ban_until", new Date().toISOString());
  if (filter === "verified") query = query.eq("verified", true);
  if (filter === "staff") query = query.in("role", ["admin", "developer"]);
  const { data, error } = await query;
  if (error) throw error;
  return NextResponse.json({ users: data });
});

// body: { id, role?, verified?, banMinutes? }  banMinutes: 0=解除 / -1=無期限 / 1以上=分
export const PATCH = guard(async (req) => {
  const b = await req.json();
  if (!b.id) return fail("idがありません");
  const patch = {};
  if ("role" in b) {
    if (!["user", "admin", "developer"].includes(b.role)) return fail("ロールが不正です");
    patch.role = b.role;
  }
  if ("verified" in b) {
    if (typeof b.verified !== "boolean") return fail("verifiedが不正です");
    patch.verified = b.verified;
  }
  if ("banMinutes" in b) {
    const m = Number(b.banMinutes);
    if (!Number.isFinite(m) || m < -1 || m > 525600) return fail("BAN時間が不正です");
    patch.ban_until = m === 0 ? null : m === -1 ? PERM_UNTIL : new Date(Date.now() + m * 60000).toISOString();
  }
  if (!Object.keys(patch).length) return fail("変更内容がありません");
  const { data, error } = await db().from("users").update(patch).eq("id", b.id).select(FIELDS).single();
  if (error) throw error;
  await axiomIngest([{ type: "admin_user_update", target_user_id: b.id, username: data.username, patch }]);
  return NextResponse.json({ user: data });
});
