import { NextResponse } from "next/server";
import { guard, fail } from "@/lib/api";
import { db } from "@/lib/db";
import { axiomIngest } from "@/lib/axiom";

const BOOL = ["login_enabled", "register_enabled"];
const TEXT = ["login_disabled_message", "register_disabled_message"];

export const GET = guard(async () => {
  const { data, error } = await db().from("app_settings").select("key,value");
  if (error) throw error;
  return NextResponse.json({ settings: Object.fromEntries((data || []).map((r) => [r.key, r.value])) });
});

export const PUT = guard(async (req) => {
  const { key, value } = await req.json();
  if (![...BOOL, ...TEXT].includes(key)) return fail("未対応のキーです");
  if (BOOL.includes(key) && typeof value !== "boolean") return fail("値が不正です");
  if (TEXT.includes(key) && (typeof value !== "string" || value.length > 200)) return fail("値が不正です");
  const { error } = await db().from("app_settings").upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw error;
  const FEATURE = { login_enabled: "ログイン", register_enabled: "新規アカウント作成" };
  const events = [{ type: "admin_setting_changed", key, value }];
  if (FEATURE[key]) events.push({ type: "feature_status", feature: FEATURE[key], status: value ? "復旧" : "停止", message: value ? "管理サイトから再開" : "管理サイトから停止" });
  await axiomIngest(events);
  return NextResponse.json({ ok: true });
});
