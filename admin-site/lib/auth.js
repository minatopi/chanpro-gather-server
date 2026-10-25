import crypto from "node:crypto";
import { cookies } from "next/headers";

export const COOKIE = "admin_session";
const TTL = 8 * 60 * 60; // 8時間
const secret = () => process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || "";
const sha = (v) => crypto.createHash("sha256").update(String(v)).digest();

export function checkPassword(input) {
  const pw = process.env.ADMIN_PASSWORD || "";
  if (!pw) return false;
  return crypto.timingSafeEqual(sha(input), sha(pw)); // 長さを揃えて比較
}
export function signSession() {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + TTL, n: crypto.randomUUID() })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
export function verifySession(token) {
  if (!token || !secret()) return false;
  const [payload, sig] = String(token).split(".");
  if (!payload || !sig) return false;
  const expected = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString()).exp > Date.now() / 1000; } catch { return false; }
}
export async function isAdmin() {
  return verifySession((await cookies()).get(COOKIE)?.value);
}
export const SESSION_TTL = TTL;
