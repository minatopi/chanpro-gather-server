const API = "https://api.axiom.co/v1/datasets";
const ds = () => process.env.AXIOM_DATASET || "chanpro";

export async function axiomIngest(events) {
  if (!process.env.AXIOM_TOKEN) return;
  try {
    await fetch(`${API}/${ds()}/ingest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.AXIOM_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(events.map((e) => ({ _time: new Date().toISOString(), source: "admin-site", ...e }))),
      signal: AbortSignal.timeout(2500),
    });
  } catch (e) { console.warn("axiom ingest failed", e?.message); }
}

export async function axiomQuery(apl) {
  if (!process.env.AXIOM_TOKEN) throw new Error("AXIOM_TOKEN が未設定です");
  const r = await fetch(`${API}/_apl?format=legacy`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.AXIOM_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ apl }),
    cache: "no-store",
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    let m = j.message || `Axiom error ${r.status}`;
    if (/does not have access/i.test(m)) m += "(AxiomのAPIトークンに、対象データセットの Query 権限(read)を付けてください)";
    throw new Error(m);
  }
  if (Array.isArray(j.matches)) return j.matches.map((m) => ({ _time: m._time, ...(m.data || {}) }));
  // tabular形式で返ってきた場合の保険
  const t = j.tables?.[0];
  if (!t) return [];
  const names = t.fields.map((f) => f.name);
  const n = t.columns?.[0]?.length || 0;
  return Array.from({ length: n }, (_, i) => Object.fromEntries(names.map((k, c) => [k, t.columns[c][i]])));
}

// 管理画面から明示的に記録する用(失敗したらエラーを返す)
export async function axiomIngestStrict(events) {
  if (!process.env.AXIOM_TOKEN) throw new Error("AXIOM_TOKEN が未設定です");
  const r = await fetch(`${API}/${ds()}/ingest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.AXIOM_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(events.map((e) => ({ _time: new Date().toISOString(), source: "admin-site", ...e }))),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    let m = j.message || `Axiom error ${r.status}`;
    if (/access|forbidden|unauthor/i.test(m)) m += "(AxiomのAPIトークンに Ingest 権限を付けてください)";
    throw new Error(m);
  }
}
