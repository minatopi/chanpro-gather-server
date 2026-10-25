import { NextResponse } from "next/server";
import { guard, fail } from "@/lib/api";
import { db } from "@/lib/db";
import { axiomIngest } from "@/lib/axiom";

const FIELDS = "id,username,role,verified,ban_until,ban_count,points";

export const GET = guard(async (req) => {
  const q = (new URL(req.url).searchParams.get("q") || "").trim().replace(/[%,()]/g, "");
  let query = db().from("users").select(FIELDS).limit(50);
  if (q) query = query.ilike("username", `%${q}%`);
  const { data, error } = await query;
  if (error) throw error;
  return NextResponse.json({ users: data });
});

// body: { id, role?, verified?, banMinutes? }  banMinutes=0 でBAN解除
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
    if (!Number.isFinite(m) || m < 0 || m > 525600) return fail("BAN時間が不正です");
    patch.ban_until = m === 0 ? null : new Date(Date.now() + m * 60000).toISOString();
  }
  if (!Object.keys(patch).length) return fail("変更内容がありません");
  const { data, error } = await db().from("users").update(patch).eq("id", b.id).select(FIELDS).single();
  if (error) throw error;
  await axiomIngest([{ type: "admin_user_update", target_user_id: b.id, patch }]);
  return NextResponse.json({ user: data });
});
