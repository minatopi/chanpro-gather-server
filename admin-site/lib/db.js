import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

export function db() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase環境変数が未設定です");
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}
// Gather API の hashIp() と同一の計算
export function hashIp(ip) {
  const secret = process.env.IP_HASH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!secret) throw new Error("IP_HASH_SECRET が未設定です");
  return crypto.createHash("sha256").update(secret + ":" + String(ip).trim().toLowerCase(), "utf8").digest("hex");
}
export const validIp = (ip) => !!ip && ip.length <= 100 && /^[0-9a-fA-F:.%a-zA-Z0-9_-]+$/.test(ip);
