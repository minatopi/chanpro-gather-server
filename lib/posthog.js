export async function hogql(query, values = {}) {
  const { POSTHOG_PERSONAL_API_KEY: key, POSTHOG_PROJECT_ID: pid } = process.env;
  const host = (process.env.POSTHOG_APP_HOST || "https://us.posthog.com").replace(/\/$/, "");
  if (!key || !pid) throw new Error("POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID が未設定です");
  const r = await fetch(`${host}/api/projects/${pid}/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query, values } }),
    cache: "no-store",
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || `PostHog error ${r.status}`);
  const cols = j.columns || [];
  return (j.results || []).map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}
