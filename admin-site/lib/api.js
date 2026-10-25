import { NextResponse } from "next/server";
import { isAdmin } from "./auth";

export const fail = (msg, status = 400) => NextResponse.json({ error: msg }, { status });
// 全管理APIをこれで包む: 未ログインは401、例外は500
export function guard(handler) {
  return async (req) => {
    if (!(await isAdmin())) return fail("unauthorized", 401);
    try { return await handler(req); }
    catch (e) { console.error(e); return fail(e?.message || "server error", e?.status || 500); }
  };
}
