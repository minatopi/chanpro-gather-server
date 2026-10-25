"use client";
import { useCallback, useEffect, useState } from "react";

async function api(path, method = "GET", body) {
  const r = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { location.href = "/login"; throw new Error("unauthorized"); }
  if (!r.ok) throw new Error(j.error || "エラー");
  return j;
}
const fmt = (t) => (t ? new Date(t).toLocaleString("ja-JP") : "");

function Table({ rows, cols }) {
  if (!rows?.length) return <p className="muted">データなし</p>;
  return (
    <div style={{ overflowX: "auto" }}><table>
      <thead><tr>{cols.map((c) => <th key={c.k}>{c.l}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c.k}>{c.f ? c.f(r) : String(r[c.k] ?? "")}</td>)}</tr>)}</tbody>
    </table></div>
  );
}

function Settings() {
  const [s, setS] = useState({}); const [msg, setMsg] = useState("");
  const load = useCallback(() => api("/api/admin/settings").then((j) => setS(j.settings)).catch((e) => setMsg(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const put = (key, value) => api("/api/admin/settings", "PUT", { key, value }).then(load).catch((e) => setMsg(e.message));
  const Toggle = ({ k, label, msgKey }) => (
    <div className="card">
      <div className="row">
        <b>{label}</b>
        <span className={s[k] === false ? "err" : "ok"}>{s[k] === false ? "停止中" : "稼働中"}</span>
        <button className={s[k] === false ? "on" : "danger"} onClick={() => put(k, s[k] === false)}>{s[k] === false ? "再開する" : "停止する"}</button>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <input style={{ flex: 1 }} defaultValue={s[msgKey] || ""} key={s[msgKey]} onBlur={(e) => e.target.value !== (s[msgKey] || "") && put(msgKey, e.target.value)} placeholder="停止中に表示するメッセージ" />
      </div>
    </div>
  );
  return <>
    <Toggle k="login_enabled" label="ログイン" msgKey="login_disabled_message" />
    <Toggle k="register_enabled" label="新規アカウント作成" msgKey="register_disabled_message" />
    <p className="muted">※ログイン停止中も admin / developer はログインできます(Gather API側パッチの仕様)。</p>
    {msg && <p className="err">{msg}</p>}
  </>;
}

function Users() {
  const [q, setQ] = useState(""); const [users, setUsers] = useState([]); const [msg, setMsg] = useState("");
  const [sel, setSel] = useState(null); const [ph, setPh] = useState(null);
  const load = useCallback(() => api(`/api/admin/users?q=${encodeURIComponent(q)}`).then((j) => setUsers(j.users)).catch((e) => setMsg(e.message)), [q]);
  useEffect(() => { load(); }, []); // eslint-disable-line
  const patch = (id, p) => api("/api/admin/users", "PATCH", { id, ...p }).then(load).catch((e) => setMsg(e.message));
  const openPh = (u) => { setSel(u); setPh(null); api(`/api/admin/posthog?userId=${u.id}&username=${encodeURIComponent(u.username)}&days=7`).then(setPh).catch((e) => setPh({ error: e.message })); };
  return <>
    <div className="row"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ユーザー名で検索" onKeyDown={(e) => e.key === "Enter" && load()} /><button onClick={load}>検索</button></div>
    {msg && <p className="err">{msg}</p>}
    <Table rows={users} cols={[
      { k: "username", l: "ユーザー" },
      { k: "role", l: "権限", f: (u) => <select value={u.role} onChange={(e) => patch(u.id, { role: e.target.value })}>{["user", "admin", "developer"].map((r) => <option key={r}>{r}</option>)}</select> },
      { k: "verified", l: "公式バッジ", f: (u) => <button className={u.verified ? "on" : ""} onClick={() => patch(u.id, { verified: !u.verified })}>{u.verified ? "✓ 付与中" : "なし"}</button> },
      { k: "ban_until", l: "BAN", f: (u) => u.ban_until && new Date(u.ban_until) > new Date() ? <>{fmt(u.ban_until)} <button onClick={() => patch(u.id, { banMinutes: 0 })}>解除</button></> : <button className="danger" onClick={() => { const m = prompt("BAN時間(分)", "60"); if (m) patch(u.id, { banMinutes: Number(m) }); }}>BAN</button> },
      { k: "points", l: "pt" },
      { k: "x", l: "アクセス", f: (u) => <button onClick={() => openPh(u)}>PostHog</button> },
    ]} />
    {sel && <div className="card">
      <b>{sel.username} のアクセス先(7日)</b> <button onClick={() => setSel(null)}>閉じる</button>
      {!ph ? <p className="muted">読み込み中…</p> : ph.error ? <p className="err">{ph.error}</p> : <>
        <h2>よく見たページ</h2><Table rows={ph.top} cols={[{ k: "path", l: "パス" }, { k: "views", l: "回数" }, { k: "last_seen", l: "最終", f: (r) => fmt(r.last_seen) }]} />
        <h2>最近の履歴</h2><Table rows={ph.recent} cols={[{ k: "timestamp", l: "時刻", f: (r) => fmt(r.timestamp) }, { k: "event", l: "種別" }, { k: "url", l: "URL" }, { k: "ip", l: "IP" }]} />
      </>}
    </div>}
  </>;
}

function IpBans() {
  const [bans, setBans] = useState([]); const [ip, setIp] = useState(""); const [min, setMin] = useState(60); const [reason, setReason] = useState(""); const [msg, setMsg] = useState("");
  const load = useCallback(() => api("/api/admin/ip-bans").then((j) => setBans(j.bans)).catch((e) => setMsg(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const ban = () => api("/api/admin/ip-bans", "POST", { ip, minutes: Number(min), reason }).then(() => { setIp(""); load(); }).catch((e) => setMsg(e.message));
  return <>
    <div className="row">
      <input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="IPアドレス" />
      <input type="number" value={min} onChange={(e) => setMin(e.target.value)} style={{ width: 100 }} /> 分
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="理由" />
      <button className="danger" onClick={ban}>IP BAN</button>
    </div>
    {msg && <p className="err">{msg}</p>}
    <p className="muted">IPはハッシュ化して保存されるため、一覧はハッシュの先頭のみ表示されます。</p>
    <Table rows={bans} cols={[
      { k: "ip_hash", l: "IPハッシュ", f: (b) => b.ip_hash.slice(0, 16) + "…" }, { k: "reason", l: "理由" },
      { k: "expires_at", l: "期限", f: (b) => fmt(b.expires_at) },
      { k: "x", l: "", f: (b) => <button onClick={() => api("/api/admin/ip-bans", "DELETE", { ip_hash: b.ip_hash }).then(load)}>解除</button> },
    ]} />
  </>;
}

function Reports() {
  const [rows, setRows] = useState([]); const [st, setSt] = useState("open"); const [msg, setMsg] = useState("");
  const load = useCallback(() => api(`/api/admin/reports?status=${st}`).then((j) => setRows(j.reports)).catch((e) => setMsg(e.message)), [st]);
  useEffect(() => { load(); }, [load]);
  const set = (id, status) => api("/api/admin/reports", "PATCH", { id, status }).then(load);
  return <>
    <div className="row">{["open", "resolved", "dismissed"].map((s) => <button key={s} className={st === s ? "on" : ""} onClick={() => setSt(s)}>{s}</button>)}</div>
    {msg && <p className="err">{msg}</p>}
    <Table rows={rows} cols={[
      { k: "created_at", l: "日時", f: (r) => fmt(r.created_at) }, { k: "username", l: "報告者" }, { k: "content", l: "内容" },
      { k: "x", l: "", f: (r) => <div className="row"><button onClick={() => set(r.id, "resolved")}>対応済</button><button onClick={() => set(r.id, "dismissed")}>却下</button><button onClick={() => set(r.id, "open")}>未対応</button></div> },
    ]} />
  </>;
}

function Logs() {
  const [kind, setKind] = useState("login"); const [hours, setHours] = useState(24); const [username, setUsername] = useState("");
  const [rows, setRows] = useState([]); const [msg, setMsg] = useState("");
  const load = useCallback(() => { setMsg(""); api(`/api/admin/axiom?kind=${kind}&hours=${hours}&username=${encodeURIComponent(username)}`).then((j) => setRows(j.rows)).catch((e) => setMsg(e.message)); }, [kind, hours, username]);
  useEffect(() => { load(); }, [kind]); // eslint-disable-line
  return <>
    <div className="row">
      {[["login", "ログイン"], ["access", "アクセス"], ["ip", "IP制限"]].map(([k, l]) => <button key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>{l}</button>)}
      <select value={hours} onChange={(e) => setHours(e.target.value)}>{[1, 24, 72, 168, 720].map((h) => <option key={h} value={h}>直近{h}時間</option>)}</select>
      <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="ユーザー名で絞り込み" />
      <button onClick={load}>更新</button>
    </div>
    {msg && <p className="err">{msg}</p>}
    <Table rows={rows} cols={[
      { k: "_time", l: "時刻", f: (r) => fmt(r._time) }, { k: "type", l: "種別" }, { k: "username", l: "ユーザー" },
      { k: "ip", l: "IP" }, { k: "action", l: "操作" }, { k: "page", l: "ページ" }, { k: "reason", l: "理由" },
    ]} />
  </>;
}

const TABS = [["settings", "停止設定", Settings], ["users", "ユーザー", Users], ["ip", "IP BAN", IpBans], ["reports", "報告", Reports], ["logs", "ログ(Axiom)", Logs]];
export default function AdminClient() {
  const [tab, setTab] = useState("settings");
  const Cur = TABS.find((t) => t[0] === tab)[2];
  return (
    <main>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Chanpro 管理サイト</h1>
        <button onClick={() => api("/api/admin/logout", "POST").then(() => (location.href = "/login"))}>ログアウト</button>
      </div>
      <div className="tabs">{TABS.map(([k, l]) => <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>)}</div>
      <Cur />
    </main>
  );
}
