import { NextResponse } from "next/server";
import { guard, fail } from "@/lib/api";
import { db } from "@/lib/db";

const STATUSES = ["open", "resolved", "dismissed"];

export const GET = guard(async (req) => {
  const status = new URL(req.url).searchParams.get("status");
  let q = db().from("gather_reports").select("id,user_id,username,content,status,created_at").order("created_at", { ascending: false }).limit(200);
  if (STATUSES.includes(status)) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw error;
  return NextResponse.json({ reports: data });
});

export const PATCH = guard(async (req) => {
  const { id, status } = await req.json();
  if (!id || !STATUSES.includes(status)) return fail("入力が不正です");
  const { error } = await db().from("gather_reports").update({ status }).eq("id", id);
  if (error) throw error;
  return NextResponse.json({ ok: true });
});
