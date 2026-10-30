import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

export function db() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase環境変数が未設定です");
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}
// Gather API の normalizeIp() / hashIp() と同一の計算(::ffff: を除去して小文字化)
export function normalizeIp(ip) {
  let v = String(ip || "").trim().toLowerCase();
  if (v.startsWith("::ffff:")) v = v.slice(7);
  return v;
}
export function hashIp(ip) {
  const secret = process.env.IP_HASH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!secret) throw new Error("IP_HASH_SECRET が未設定です");
  return crypto.createHash("sha256").update(secret + ":" + normalizeIp(ip), "utf8").digest("hex");
}
export const validIp = (ip) => !!ip && ip.length <= 100 && /^[0-9a-fA-F:.%a-zA-Z0-9_-]+$/.test(ip);
