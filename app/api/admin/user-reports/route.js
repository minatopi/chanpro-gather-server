import { NextResponse } from "next/server";
import { guard, fail } from "@/lib/api";
import { db } from "@/lib/db";

export const GET = guard(async (req) => {
  const status = new URL(req.url).searchParams.get("status");
  let q = db().from("reports").select("*").order("created_at", { ascending: false }).limit(200);
  q = status === "resolved" ? q.eq("status", "resolved") : q.neq("status", "resolved");
  const { data, error } = await q;
  if (error) throw error;
  const ids = [...new Set((data || []).flatMap((r) => [r.reporter_id, r.target_user_id]).filter(Boolean))];
  let names = {};
  if (ids.length) {
    const { data: us } = await db().from("users").select("id,username").in("id", ids);
    names = Object.fromEntries((us || []).map((u) => [u.id, u.username]));
  }
  return NextResponse.json({ reports: (data || []).map((r) => ({ ...r, reporter_name: names[r.reporter_id] || "", target_name: names[r.target_user_id] || "" })) });
});

export const PATCH = guard(async (req) => {
  const { id } = await req.json();
  if (!id) return fail("idがありません");
  const { error } = await db().from("reports").update({ status: "resolved" }).eq("id", id);
  if (error) throw error;
  return NextResponse.json({ ok: true });
});
