import { NextResponse } from "next/server";
import { checkPassword, signSession, COOKIE, SESSION_TTL } from "@/lib/auth";
import { axiomIngest } from "@/lib/axiom";

const fails = new Map(); // 簡易ブルートフォース対策(インスタンス単位)
export async function POST(req) {
  const ip = (req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
  const f = fails.get(ip) || { n: 0, until: 0 };
  if (f.until > Date.now()) return NextResponse.json({ error: "しばらく待ってから再試行してください" }, { status: 429 });
  const { password } = await req.json().catch(() => ({}));
  if (!checkPassword(password || "")) {
    f.n += 1; if (f.n >= 5) { f.until = Date.now() + 15 * 60000; f.n = 0; }
    fails.set(ip, f);
    await new Promise((r) => setTimeout(r, 600));
    await axiomIngest([{ type: "admin_login_failed", ip }]);
    return NextResponse.json({ error: "パスワードが違います" }, { status: 401 });
  }
  fails.delete(ip);
  await axiomIngest([{ type: "admin_login_success", ip }]);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, signSession(), { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: SESSION_TTL });
  return res;
}
