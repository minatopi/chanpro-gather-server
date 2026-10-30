import { NextResponse } from "next/server";
import { guard, fail } from "@/lib/api";
import { axiomIngestStrict } from "@/lib/axiom";
import { loadStatus, STATUSES } from "@/lib/status";

export const GET = guard(async () => NextResponse.json(await loadStatus(90)));

// body: { feature, status, message }  例: { feature:"いいね", status:"停止", message:"DB障害のため" }
export const POST = guard(async (req) => {
  const b = await req.json();
  const feature = String(b.feature || "").trim();
  const status = String(b.status || "");
  const message = String(b.message || "").trim().slice(0, 300);
  if (!feature || feature.length > 50) return fail("機能名を入力してください(50文字まで)");
  if (!STATUSES.includes(status)) return fail("ステータスが不正です");
  await axiomIngestStrict([{ type: "feature_status", feature, status, message }]);
  return NextResponse.json({ ok: true });
});
