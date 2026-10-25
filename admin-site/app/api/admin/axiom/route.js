import { NextResponse } from "next/server";
import { guard } from "@/lib/api";
import { axiomQuery } from "@/lib/axiom";

// kind: login / access / ip
const TYPES = {
  login: ["login_success", "login_failed", "register_created", "login_blocked", "register_blocked"],
  access: ["access"],
  ip: ["ip_banned_request", "ip_rate_limited", "admin_ip_ban", "admin_ip_unban"],
};

export const GET = guard(async (req) => {
  const sp = new URL(req.url).searchParams;
  const kind = TYPES[sp.get("kind")] ? sp.get("kind") : "login";
  const hours = Math.max(1, Math.min(24 * 30, parseInt(sp.get("hours"), 10) || 24));
  const username = (sp.get("username") || "").trim().slice(0, 100);
  const ds = (process.env.AXIOM_DATASET || "chanpro").replace(/[^\w-]/g, "");
  const types = TYPES[kind].map((t) => JSON.stringify(t)).join(", ");
  let apl = `['${ds}'] | where _time > ago(${hours}h) | where type in (${types})`;
  if (username) apl += ` | where username == ${JSON.stringify(username)}`; // JSON文字列でエスケープ
  apl += " | sort by _time desc | take 300";
  return NextResponse.json({ rows: await axiomQuery(apl) });
});
