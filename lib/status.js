import { axiomQuery } from "./axiom";

export const FEATURES = ["いいね", "リポスト", "ブックマーク", "投稿", "返信", "DM", "フォロー", "通知", "チャット", "ポイント・スタンプ", "画像アップロード", "アンケート", "ログイン", "新規アカウント作成"];
export const STATUSES = ["停止", "復旧", "不具合", "調査中", "メンテナンス"];

export async function loadStatus(days = 90) {
  const ds = (process.env.AXIOM_DATASET || "chanpro").replace(/[^\w-]/g, "");
  const events = await axiomQuery(`['${ds}'] | where _time > ago(${Math.max(1, Math.min(365, days))}d) | where type == "feature_status" | sort by _time desc | take 300`);
  const seen = new Set(), current = [];
  for (const e of events) { if (e.feature && !seen.has(e.feature)) { seen.add(e.feature); current.push(e); } } // 新しい順なので最初が最新
  return { events, current };
}
