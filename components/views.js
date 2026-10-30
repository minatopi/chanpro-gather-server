"use client";
import { useEffect, useState } from "react";
import { GeoPanel } from "./geomap";
import { api, fmt, fmtFull, ago, remaining, isBanned, typeInfo, STATUS_TONE, Icon, Badge, Avatar, Switch, Seg, Empty, Skeleton, ErrorBox, SearchBox, Drawer, useUI, useLoad, useDebounced } from "./ui";

/* =========================================================
   ダッシュボード
   ========================================================= */
function Stat({ icon, tone, label, value, onClick, hint }) {
  const colors = { blue: ["var(--blue-soft)", "var(--brand)"], green: ["var(--green-soft)", "var(--green)"], red: ["var(--red-soft)", "var(--red)"], amber: ["var(--amber-soft)", "var(--amber)"], violet: ["var(--violet-soft)", "var(--violet)"] }[tone];
  return (
    <div className={`card stat ${onClick ? "link" : ""}`} onClick={onClick}>
      <div className="label"><span className="ico" style={{ background: colors[0], color: colors[1] }}><Icon name={icon} size={16} /></span>{label}</div>
      <div className="num">{value ?? "-"}</div>
      {hint && <div className="sub">{hint}</div>}
    </div>
  );
}

export function Dashboard({ go }) {
  const { data: d, loading, error, reload } = useLoad(() => api("/api/admin/stats"));
  if (loading && !d) return <Skeleton rows={5} />;
  if (error) return <ErrorBox text={error} />;
  const s = d.settings || {};
  const max = Math.max(1, ...(d.activity || []).map((a) => Number(a.n) || 0));
  const unresolved = (d.openReports || 0) + (d.openUserReports || 0);
  return <>
    <div className="grid g4">
      <Stat icon="users" tone="blue" label="ユーザー数" value={d.users} hint={`公式バッジ ${d.verified ?? "-"}人`} onClick={() => go("users")} />
      <Stat icon="ban" tone="red" label="BAN中アカウント" value={d.banned} onClick={() => go("users", { filter: "banned" })} />
      <Stat icon="shield" tone="violet" label="有効なIP/端末BAN" value={d.ipBans} onClick={() => go("bans")} />
      <Stat icon="flag" tone="amber" label="未対応の報告・通報" value={unresolved} onClick={() => go("reports")} />
    </div>
    <div className="grid g2">
      {[["login_enabled", "ログイン"], ["register_enabled", "新規アカウント作成"]].map(([k, label]) => (
        <div key={k} className="card card-pad row" style={{ justifyContent: "space-between" }}>
          <div><div style={{ fontWeight: 700 }}>{label}</div><div className="sub">{s[k] === false ? "現在停止しています" : "通常どおり利用できます"}</div></div>
          <div className="row"><Badge tone={s[k] === false ? "red" : "green"} dot>{s[k] === false ? "停止中" : "稼働中"}</Badge><button className="btn sm" onClick={() => go("settings")}>変更</button></div>
        </div>
      ))}
    </div>
    <div className="card card-pad">
      <div className="card-head"><div><h2>機能の状況</h2><div className="sub">「機能ステータス」で記録した最新の状態</div></div><button className="btn sm" onClick={() => go("status")}>記録・履歴</button></div>
      {!d.featureStatus ? <div className="sub">Axiomを読み込めないため表示できません</div>
        : !d.featureStatus.length ? <div className="row"><Badge tone="green" dot>記録なし(すべて通常)</Badge></div>
        : <div className="row">{d.featureStatus.map((e) => <span key={e.feature} title={e.message || ""} className="row" style={{ gap: 6 }}><b>{e.feature}</b><Badge tone={STATUS_TONE[e.status] || "gray"} dot>{e.status}</Badge><span className="sub">{ago(e._time)}</span></span>)}</div>}
    </div>
    <div className="card card-pad">
      <div className="card-head"><div><h2>直近24時間のアクティビティ</h2><div className="sub">Axiomに保存されたログの集計</div></div><button className="btn sm" onClick={reload}><Icon name="refresh" size={14} />更新</button></div>
      {d.activityError ? <div className="notice warn"><Icon name="info" />Axiomを読み込めません: {d.activityError}</div>
        : !d.activity?.length ? <Empty icon="activity" text="まだログがありません" />
        : <div className="bars">{d.activity.map((a) => { const [label, tone] = typeInfo(a.type); return (
            <div key={a.type} className="bar-row"><span><Badge tone={tone}>{label}</Badge></span><div className="bar"><i style={{ width: `${(a.n / max) * 100}%` }} /></div><b style={{ textAlign: "right" }}>{a.n}</b></div>
          ); })}</div>}
    </div>
  </>;
}

/* =========================================================
   ユーザー
   ========================================================= */
const BAN_PRESETS = [["1時間", 60], ["1日", 1440], ["7日", 10080], ["30日", 43200], ["無期限", -1]];


function PostHogSection({ user, go }) {
  const [days, setDays] = useState(30);
  const { data: d, loading, error, reload } = useLoad(() => api(`/api/admin/posthog?userId=${user.id}&username=${encodeURIComponent(user.username)}&days=${days}`), [user.id, days]);
  const props = d?.person?.properties || {};
  const shown = Object.entries(props).filter(([k]) => !k.startsWith("$") || /^\$(geoip_|initial_)/.test(k));
  const rest = Object.entries(props).filter(([k]) => !shown.some(([a]) => a === k));
  const label = (k) => k.replace(/^\$/, "").replace(/_/g, " ");
  return (
    <section>
      <div className="sec-title">PostHog ユーザー情報</div>
      <div className="row" style={{ marginBottom: 12 }}>
        <Seg value={days} onChange={setDays} options={[[7, "7日"], [30, "30日"], [90, "90日"]]} />
        <button className="btn sm" onClick={reload}><Icon name="refresh" size={14} /></button>
        {d?.personUrl && <a className="btn sm" href={d.personUrl} target="_blank" rel="noreferrer">PostHogで開く</a>}
        <button className="btn sm ghost" onClick={() => go("logs", { username: user.username })}>Axiomのログ</button>
      </div>
      {loading && !d ? <Skeleton rows={3} /> : error ? <ErrorBox text={error} /> : <div className="stack">
        {d.errors?.length > 0 && <div className="notice warn"><Icon name="alert" /><span>一部取得できませんでした: {d.errors.join(" / ")}</span></div>}
        {!d.person && !d.stats?.events && <div className="notice info"><Icon name="info" />このIDのPersonがPostHogにありません。フロントで posthog.identify(user.id) を呼ぶと表示されます。</div>}
        {d.stats && <div className="row">
          <Badge tone="blue">イベント {Number(d.stats.events || 0).toLocaleString()}</Badge>
          <Badge tone="gray">セッション {Number(d.stats.sessions || 0).toLocaleString()}</Badge>
          {d.stats.last_seen && <Badge tone="green" dot>最終 {ago(d.stats.last_seen)}</Badge>}
          {d.person?.created_at && <Badge tone="gray">Person作成 {fmtFull(d.person.created_at)}</Badge>}
        </div>}
        {shown.length > 0 && <div><div className="sub" style={{ marginBottom: 6 }}>Personのプロパティ</div>
          <div className="table-wrap"><table><tbody>{shown.map(([k, v]) => <tr key={k}><td style={{ width: 150, color: "var(--muted)" }}>{label(k)}</td><td className="mono">{typeof v === "object" ? JSON.stringify(v) : String(v)}</td></tr>)}</tbody></table></div></div>}
        {rest.length > 0 && <details><summary className="sub" style={{ cursor: "pointer" }}>その他のプロパティ({rest.length})</summary><pre className="mono" style={{ whiteSpace: "pre-wrap", background: "var(--bg-soft)", padding: 10, borderRadius: 10 }}>{JSON.stringify(Object.fromEntries(rest), null, 2)}</pre></details>}
        {d.ips?.length > 0 && <div><div className="sub" style={{ marginBottom: 6 }}>アクセス元IP(新しい順)</div>
          <div className="table-wrap"><table><tbody>{d.ips.map((r) => <tr key={r.ip}><td className="mono">{r.ip}</td><td>{[r.country, r.city].filter(Boolean).join(" / ") || "-"}</td><td className="sub" style={{ textAlign: "right" }}>{ago(r.last_seen)} ・{r.n}回</td></tr>)}</tbody></table></div></div>}
        {d.devices?.length > 0 && <div><div className="sub" style={{ marginBottom: 6 }}>使用環境</div>
          {d.devices.map((r, i) => <div key={i} className="row" style={{ marginBottom: 4 }}><Badge tone="violet">{r.device || "不明"}</Badge><span>{[r.browser, r.os].filter(Boolean).join(" / ") || "-"}</span><span className="sub" style={{ marginLeft: "auto" }}>{ago(r.last_seen)} ・{r.n}回</span></div>)}</div>}
        {d.top?.length > 0 && <div><div className="sub" style={{ marginBottom: 6 }}>よく見たページ</div><div className="bars">{d.top.slice(0, 8).map((r) => <div key={r.path || "root"} className="bar-row" style={{ gridTemplateColumns: "1fr 44px" }}><span className="mono">{r.path || "/"}</span><b style={{ textAlign: "right" }}>{r.views}</b></div>)}</div></div>}
        {d.recent?.length > 0 && <details><summary className="sub" style={{ cursor: "pointer" }}>最近のアクセス履歴({d.recent.length}件)</summary>
          <div style={{ marginTop: 8 }}>{d.recent.map((r, i) => <div key={i} className="row sub" style={{ gap: 8, flexWrap: "nowrap" }}><span style={{ width: 92, flex: "none" }}>{fmt(r.timestamp)}</span><span className="mono grow">{r.path || r.url}</span><span className="mono">{r.ip || ""}</span></div>)}</div></details>}
      </div>}
    </section>
  );
}

function UserPanel({ user: initial, onClose, onChanged, go }) {
  const { toast, confirm } = useUI();
  const [u, setU] = useState(initial); const [busy, setBusy] = useState(false);
  const banned = isBanned(u);
  const patch = async (p, msg) => {
    setBusy(true);
    try { const j = await api("/api/admin/users", "PATCH", { id: u.id, ...p }); setU(j.user); onChanged(j.user); toast(msg || "更新しました"); }
    catch (e) { toast(e.message, "err"); } finally { setBusy(false); }
  };
  const ban = async (label, minutes) => {
    if (await confirm({ title: `${u.username} をBANしますか?`, body: `期間: ${label}\nこのアカウントのみBANします(IP・端末は「BAN管理」から)。`, danger: true, okText: "BANする" })) patch({ banMinutes: minutes }, "BANしました");
  };
  return (
    <Drawer onClose={onClose} header={<><Avatar name={u.username} src={u.icon_url} size={44} /><div style={{ minWidth: 0 }}><div style={{ fontWeight: 800, fontSize: 16 }}>{u.username}</div><div className="mono sub" style={{ cursor: "pointer" }} title="クリックでコピー" onClick={() => { navigator.clipboard?.writeText(u.id); toast("IDをコピーしました"); }}>{u.id}</div></div></>}>
      <section>
        <div className="sec-title">権限・バッジ</div>
        <div className="stack">
          <div className="field"><label>ロール</label>
            <select className="select" value={u.role} disabled={busy} onChange={(e) => patch({ role: e.target.value }, "ロールを変更しました")}>
              <option value="user">user(一般)</option><option value="admin">admin(管理者)</option><option value="developer">developer(開発者)</option>
            </select></div>
          <div className="check"><div><b>公式バッジ</b><span>認証済みマークを表示し、限定投稿を利用可能にします</span></div><Switch checked={!!u.verified} disabled={busy} onChange={(v) => patch({ verified: v }, v ? "公式バッジを付与しました" : "公式バッジを外しました")} /></div>
        </div>
      </section>
      <section>
        <div className="sec-title">アカウントBAN</div>
        {banned ? (
          <div className="stack">
            <div className="notice err"><Icon name="ban" />BAN中({remaining(u.ban_until).text} / {fmtFull(u.ban_until)}まで)</div>
            <button className="btn" disabled={busy} onClick={() => patch({ banMinutes: 0 }, "BANを解除しました")}>BANを解除する</button>
          </div>
        ) : (
          <div className="row">{BAN_PRESETS.map(([l, m]) => <button key={l} className="btn sm soft-danger" disabled={busy} onClick={() => ban(l, m)}>{l}</button>)}</div>
        )}
        <button className="btn primary" style={{ marginTop: 12, width: "100%" }} onClick={() => go("bans", { username: u.username })}><Icon name="shield" size={16} />IP・端末もまとめてBAN(芋づる式)へ</button>
      </section>
      <section>
        <div className="sec-title">ポイント・状態</div>
        <div className="row"><Badge tone="blue">{(u.points ?? 0).toLocaleString()} pt</Badge><Badge tone="gray">BAN {u.ban_count || 0}回</Badge></div>
      </section>
      <PostHogSection user={u} go={go} />
    </Drawer>
  );
}

export function Users({ go, params }) {
  const [text, setText] = useState(params?.q || ""); const q = useDebounced(text);
  const [filter, setFilter] = useState(params?.filter || "all"); const [sel, setSel] = useState(null);
  const { data, loading, error, reload } = useLoad(() => api(`/api/admin/users?q=${encodeURIComponent(q)}&filter=${filter}`), [q, filter]);
  const users = data?.users || [];
  return <>
    <div className="row">
      <SearchBox value={text} onChange={setText} placeholder="ユーザー名で検索" />
      <Seg value={filter} onChange={setFilter} options={[["all", "すべて"], ["verified", "公式"], ["staff", "管理者"], ["banned", "BAN中"]]} />
    </div>
    <ErrorBox text={error} />
    {loading && !data ? <Skeleton rows={6} /> : !users.length ? <div className="card"><Empty icon="users" text="該当するユーザーがいません" /></div> : (
      <div className="table-wrap"><table>
        <thead><tr><th>ユーザー</th><th>権限</th><th>状態</th><th style={{ textAlign: "right" }}>ポイント</th></tr></thead>
        <tbody>{users.map((u) => (
          <tr key={u.id} className="click" onClick={() => setSel(u)}>
            <td><div className="row" style={{ gap: 12, flexWrap: "nowrap" }}><Avatar name={u.username} src={u.icon_url} /><b>{u.username}</b>{u.verified && <span style={{ color: "var(--brand)", display: "inline-flex" }} title="公式バッジ"><Icon name="badge" size={16} /></span>}</div></td>
            <td><Badge tone={u.role === "developer" ? "violet" : u.role === "admin" ? "blue" : "gray"}>{u.role}</Badge></td>
            <td>{isBanned(u) ? <Badge tone="red" dot>BAN中 {remaining(u.ban_until).text}</Badge> : <Badge tone="green" dot>通常</Badge>}</td>
            <td style={{ textAlign: "right" }}>{(u.points ?? 0).toLocaleString()}</td>
          </tr>))}</tbody>
      </table></div>
    )}
    {sel && <UserPanel key={sel.id} user={sel} go={go} onClose={() => setSel(null)} onChanged={() => reload()} />}
  </>;
}

/* =========================================================
   BAN管理(IP / 端末 / ユーザー名)
   ========================================================= */
const DURATIONS = [["1時間", 60], ["1日", 1440], ["7日", 10080], ["30日", 43200], ["無期限", 0]];

function UserBanCard({ initialUsername, onDone }) {
  const { toast, confirm } = useUI();
  const [f, setF] = useState({ username: initialUsername || "", minutes: 1440, reason: "", withIp: true, withDevice: true, cascade: true, ipSource: "both" });
  const [plan, setPlan] = useState(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const set = (k, v) => { setF((p) => ({ ...p, [k]: v })); setPlan(null); setErr(""); };
  const call = async (dryRun) => { setBusy(true); setErr(""); try { return await api("/api/admin/user-ban", "POST", { ...f, minutes: Number(f.minutes), dryRun }); } finally { setBusy(false); } };
  const preview = () => call(true).then((j) => setPlan(j.plan)).catch((e) => setErr(e.message));
  const run = async () => {
    if (!(await confirm({ title: "BANを実行しますか?", danger: true, okText: "BANを実行", body: `アカウント ${plan.accounts.length}件 / IP ${plan.ips.length}件 / 端末 ${plan.devices.length}件 をBANします。` }))) return;
    try { const j = await call(false); toast(`BAN完了: アカウント${j.result.accounts}件 / IP ${j.result.ips}件 / 端末${j.result.devices}件`); setPlan(null); onDone(); } catch (e) { setErr(e.message); }
  };
  const unban = async () => {
    if (!(await confirm({ title: `${f.username} のBANを解除しますか?`, body: "このユーザー名で作成したIP・端末BANと、同じ端末のアカウントBANをまとめて解除します。", okText: "解除する" }))) return;
    try { const j = await api("/api/admin/user-ban", "DELETE", { username: f.username }); toast(`解除しました(BAN行${j.result.removed}件 / アカウント${j.result.accounts}件)`); setPlan(null); onDone(); } catch (e) { toast(e.message, "err"); }
  };
  const Opt = ({ k, title, desc }) => <div className="check"><div><b>{title}</b><span>{desc}</span></div><Switch checked={f[k]} onChange={(v) => set(k, v)} /></div>;
  return (
    <div className="card card-pad">
      <div className="card-head"><div><h2>ユーザー名でBAN</h2><div className="sub">アカウント・過去のIP・端末をまとめて停止し、同じ端末のアカウントも芋づる式にBANします</div></div></div>
      <div className="grid g3" style={{ marginBottom: 14 }}>
        <div className="field"><label>ユーザー名(完全一致)</label><input className="input" value={f.username} onChange={(e) => set("username", e.target.value)} placeholder="username" /></div>
        <div className="field"><label>期間</label><select className="select" value={f.minutes} onChange={(e) => set("minutes", e.target.value)}>{DURATIONS.map(([l, m]) => <option key={l} value={m}>{l}</option>)}</select></div>
        <div className="field"><label>理由(任意)</label><input className="input" value={f.reason} onChange={(e) => set("reason", e.target.value)} placeholder="スパム投稿 など" /></div>
      </div>
      <div className="stack">
        <Opt k="withIp" title="過去30日のIPもBAN" desc="PostHogのPerson(アクセス履歴)とAxiomのログからIPを集めます" />
        {f.withIp && <div className="row" style={{ paddingLeft: 4 }}><span className="sub">IPの取得元</span><Seg value={f.ipSource} onChange={(v) => set("ipSource", v)} options={[["both", "PostHog + Axiom"], ["posthog", "PostHogのPerson"], ["axiom", "Axiomのみ"]]} /></div>}
        <Opt k="withDevice" title="端末をBAN" desc="この端末からの新規作成・ログインを止めます" />
        <Opt k="cascade" title="同じ端末のアカウントも芋づる式にBAN" desc="共有端末の別アカウントも順にたどります(最大50件)" />
      </div>
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn primary" disabled={busy || !f.username.trim()} onClick={preview}>対象をプレビュー</button>
        <button className="btn soft-danger" disabled={!f.username.trim()} onClick={unban}>このユーザーのBANを解除</button>
      </div>
      <div style={{ marginTop: 12 }}><ErrorBox text={err} /></div>
      {plan && (
        <div className="stack" style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--line)" }}>
          <div><div className="sec-title">アカウント({plan.accounts.length})</div>{plan.accounts.map((a) => <span key={a.id} className="chip">{a.username}</span>)}</div>
          <div><div className="sec-title">IP({plan.ips.length})</div>{plan.ipDetails?.length ? plan.ipDetails.map((x) => <div key={x.ip} className="row" style={{ gap: 8, margin: "3px 0" }}><span className="chip" style={{ margin: 0 }}>{x.ip}</span><span className="sub">{[x.country, x.city].filter(Boolean).join(" / ")}</span>{x.sources.map((src) => <Badge key={src} tone={src === "PostHog" ? "violet" : "blue"}>{src}</Badge>)}{x.last_seen && <span className="sub">{ago(x.last_seen)}</span>}</div>) : <span className="sub">なし</span>}</div>
          <div><div className="sec-title">端末({plan.devices.length})</div>{plan.devices.length ? plan.devices.map((d) => <span key={d} className="chip">{d}</span>) : <span className="sub">なし</span>}</div>
          {plan.warnings.map((w, i) => <div key={i} className="notice warn"><Icon name="alert" />{w}</div>)}
          <div className="notice info"><Icon name="info" />共有Wi-Fiや携帯回線のIPをBANすると、無関係な人も巻き込みます。</div>
          <div><button className="btn danger" disabled={busy} onClick={run}>この内容でBANを実行</button></div>
        </div>
      )}
    </div>
  );
}

export function Bans({ params }) {
  const { toast, confirm } = useUI();
  const [kind, setKind] = useState("all"); const [text, setText] = useState("");
  const [ip, setIp] = useState(""); const [min, setMin] = useState(60); const [reason, setReason] = useState("");
  const { data, loading, error, reload } = useLoad(() => api("/api/admin/ip-bans"));
  const bans = (data?.bans || []).filter((b) => (kind === "all" || b.kind === kind || (kind === "ip" && !b.kind)) && (!text || `${b.username || ""} ${b.reason || ""} ${b.ip_hash}`.toLowerCase().includes(text.toLowerCase())));
  const ban = async () => {
    try { await api("/api/admin/ip-bans", "POST", { ip, minutes: Number(min), reason }); toast("IPをBANしました"); setIp(""); reload(); } catch (e) { toast(e.message, "err"); }
  };
  const del = async (b) => {
    if (!(await confirm({ title: "BANを解除しますか?", body: `${b.kind === "device" ? "端末" : "IP"}(${b.ip_hash.slice(0, 14)}…)のBANを解除します。`, okText: "解除する" }))) return;
    try { await api("/api/admin/ip-bans", "DELETE", { ip_hash: b.ip_hash }); toast("解除しました"); reload(); } catch (e) { toast(e.message, "err"); }
  };
  return <>
    <UserBanCard key={params?.username || "x"} initialUsername={params?.username} onDone={reload} />
    <div className="card card-pad">
      <div className="card-head"><div><h2>IPアドレスを直接BAN</h2><div className="sub">IPはハッシュ化して保存されます</div></div></div>
      <div className="row">
        <input className="input grow" value={ip} onChange={(e) => setIp(e.target.value)} placeholder="203.0.113.10" />
        <select className="select" style={{ width: 130 }} value={min} onChange={(e) => setMin(e.target.value)}>{[["1時間", 60], ["1日", 1440], ["7日", 10080], ["30日", 43200], ["1年", 525600]].map(([l, m]) => <option key={l} value={m}>{l}</option>)}</select>
        <input className="input grow" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="理由" />
        <button className="btn danger" disabled={!ip.trim()} onClick={ban}>BAN</button>
      </div>
    </div>
    <div className="row"><SearchBox value={text} onChange={setText} placeholder="ユーザー名・理由で絞り込み" /><Seg value={kind} onChange={setKind} options={[["all", "すべて"], ["ip", "IP"], ["device", "端末"]]} /></div>
    <ErrorBox text={error} />
    {loading && !data ? <Skeleton /> : !bans.length ? <div className="card"><Empty icon="shield" text="BANはありません" /></div> : (
      <div className="table-wrap"><table>
        <thead><tr><th>種別</th><th>対象</th><th>理由</th><th>期限</th><th /></tr></thead>
        <tbody>{bans.map((b) => { const r = remaining(b.expires_at); return (
          <tr key={b.ip_hash}>
            <td><Badge tone={b.kind === "device" ? "violet" : "blue"}>{b.kind === "device" ? "端末" : "IP"}</Badge></td>
            <td><div><b>{b.username || "(手動)"}</b></div><div className="mono sub">{b.ip_hash.slice(0, 18)}…</div></td>
            <td style={{ maxWidth: 280 }}>{b.reason}</td>
            <td><Badge tone={r.tone}>{r.text}</Badge></td>
            <td style={{ textAlign: "right" }}><button className="btn sm" onClick={() => del(b)}>解除</button></td>
          </tr>); })}</tbody>
      </table></div>
    )}
  </>;
}

/* =========================================================
   報告・通報
   ========================================================= */
function GatherReports() {
  const { toast } = useUI(); const [st, setSt] = useState("open");
  const { data, loading, error, reload } = useLoad(() => api(`/api/admin/reports?status=${st}`), [st]);
  const set = async (id, status) => { try { await api("/api/admin/reports", "PATCH", { id, status }); toast("更新しました"); reload(); } catch (e) { toast(e.message, "err"); } };
  const rows = data?.reports || [];
  return <>
    <Seg value={st} onChange={setSt} options={[["open", "未対応"], ["resolved", "対応済み"], ["dismissed", "却下"]]} />
    <ErrorBox text={error} />
    {loading && !data ? <Skeleton /> : !rows.length ? <div className="card"><Empty icon="inbox" text="報告はありません" /></div> : rows.map((r) => (
      <div key={r.id} className="card item">
        <div className="row"><Avatar name={r.username || "?"} size={30} /><b>{r.username || "(退会済み)"}</b><span className="sub" title={fmtFull(r.created_at)}>{ago(r.created_at)}</span>
          <span style={{ marginLeft: "auto" }}><Badge tone={r.status === "open" ? "amber" : r.status === "resolved" ? "green" : "gray"} dot>{r.status === "open" ? "未対応" : r.status === "resolved" ? "対応済み" : "却下"}</Badge></span></div>
        <div className="item-body">{r.content}</div>
        <div className="row">{r.status !== "resolved" && <button className="btn sm primary" onClick={() => set(r.id, "resolved")}>対応済みにする</button>}{r.status !== "dismissed" && <button className="btn sm" onClick={() => set(r.id, "dismissed")}>却下</button>}{r.status !== "open" && <button className="btn sm ghost" onClick={() => set(r.id, "open")}>未対応に戻す</button>}</div>
      </div>))}
  </>;
}
function UserReports({ go }) {
  const { toast } = useUI(); const [st, setSt] = useState("open");
  const { data, loading, error, reload } = useLoad(() => api(`/api/admin/user-reports?status=${st}`), [st]);
  const resolve = async (id) => { try { await api("/api/admin/user-reports", "PATCH", { id }); toast("対応済みにしました"); reload(); } catch (e) { toast(e.message, "err"); } };
  const rows = data?.reports || [];
  return <>
    <Seg value={st} onChange={setSt} options={[["open", "未対応"], ["resolved", "対応済み"]]} />
    <ErrorBox text={error} />
    {loading && !data ? <Skeleton /> : !rows.length ? <div className="card"><Empty icon="inbox" text="通報はありません" /></div> : rows.map((r) => (
      <div key={r.id} className="card item">
        <div className="row"><Badge tone="red">通報対象</Badge><b>{r.target_name || "(不明)"}</b><span className="sub">通報者: {r.reporter_name || "(不明)"}</span><span className="sub" style={{ marginLeft: "auto" }} title={fmtFull(r.created_at)}>{ago(r.created_at)}</span></div>
        <div className="item-body">{r.reason}</div>
        {r.post_id && <div className="sub">対象の投稿ID: <span className="mono">{r.post_id}</span></div>}
        <div className="row">{st === "open" && <button className="btn sm primary" onClick={() => resolve(r.id)}>対応済みにする</button>}{r.target_name && <button className="btn sm" onClick={() => go("users", { q: r.target_name })}>ユーザーを開く</button>}{r.target_name && <button className="btn sm soft-danger" onClick={() => go("bans", { username: r.target_name })}>BAN管理へ</button>}</div>
      </div>))}
  </>;
}
export function Reports({ go }) {
  const [tab, setTab] = useState("gather");
  return <><Seg value={tab} onChange={setTab} options={[["gather", "ユーザーからの報告"], ["user", "ユーザー・投稿の通報"]]} />{tab === "gather" ? <GatherReports /> : <UserReports go={go} />}</>;
}

/* =========================================================
   アクセスログ(Axiom)
   ========================================================= */
export function Logs({ params }) {
  const [kind, setKind] = useState(params?.kind || "login"); const [hours, setHours] = useState(24);
  const [text, setText] = useState(params?.username || ""); const username = useDebounced(text, 500);
  const [auto, setAuto] = useState(false);
  const { data, loading, error, reload } = useLoad(() => api(`/api/admin/axiom?kind=${kind}&hours=${hours}&username=${encodeURIComponent(username)}`), [kind, hours, username]);
  useEffect(() => { if (!auto) return; const t = setInterval(reload, 20000); return () => clearInterval(t); }, [auto, reload]);
  const rows = data?.rows || [];
  return <>
    <div className="row">
      <Seg value={kind} onChange={setKind} options={[["login", "ログイン"], ["access", "アクセス"], ["ip", "IP・端末制限"], ["status", "機能ステータス"]]} />
      <SearchBox value={text} onChange={setText} placeholder="ユーザー名で絞り込み" />
      <select className="select" style={{ width: 140 }} value={hours} onChange={(e) => setHours(e.target.value)}>{[[1, "直近1時間"], [24, "直近24時間"], [72, "直近3日"], [168, "直近7日"], [720, "直近30日"]].map(([h, l]) => <option key={h} value={h}>{l}</option>)}</select>
      <label className="row sub" style={{ gap: 8 }}><Switch checked={auto} onChange={setAuto} />自動更新</label>
      <button className="btn" onClick={reload}><Icon name="refresh" size={15} />更新</button>
    </div>
    <ErrorBox text={error} />
    {loading && !data ? <Skeleton rows={6} /> : !rows.length ? <div className="card"><Empty icon="list" text="該当するログがありません" /></div> : (
      <div className="table-wrap"><table>
        <thead><tr><th>時刻</th><th>種別</th><th>ユーザー</th><th>IP</th><th>詳細</th></tr></thead>
        <tbody>{rows.map((r, i) => { const [label, tone] = r.type === "feature_status" ? [`${r.feature || "?"}:${r.status || ""}`, STATUS_TONE[r.status] || "gray"] : typeInfo(r.type); return (
          <tr key={i}>
            <td style={{ whiteSpace: "nowrap" }} title={fmtFull(r._time)}>{fmt(r._time)}</td>
            <td><Badge tone={tone}>{label}</Badge></td>
            <td>{r.username || ""}</td>
            <td className="mono">{r.ip || ""}</td>
            <td className="sub mono" style={{ maxWidth: 360 }}>{[r.action && `action=${r.action}`, r.page && `page=${r.page}`, r.message, r.reason, r.key && `${r.key}=${r.value}`].filter(Boolean).join("  ")}</td>
          </tr>); })}</tbody>
      </table></div>
    )}
    <div className="sub">最大300件まで表示します。</div>
  </>;
}

/* =========================================================
   停止設定
   ========================================================= */
function Control({ title, desc, enabledKey, msgKey, s, put }) {
  const { confirm } = useUI(); const on = s[enabledKey] !== false;
  const [msg, setMsg] = useState(s[msgKey] || ""); const dirty = msg !== (s[msgKey] || "");
  const toggle = async (v) => {
    if (!v && !(await confirm({ title: `${title}を停止しますか?`, body: "一般ユーザーは利用できなくなります。admin / developer は影響を受けません。", danger: true, okText: "停止する" }))) return;
    put(enabledKey, v);
  };
  return (
    <div className="card card-pad stack">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
        <div><div className="row"><h2 style={{ fontSize: 16 }}>{title}</h2><Badge tone={on ? "green" : "red"} dot>{on ? "稼働中" : "停止中"}</Badge></div><div className="sub" style={{ marginTop: 4 }}>{desc}</div></div>
        <Switch checked={on} onChange={toggle} />
      </div>
      <div className="field"><label>停止中にユーザーへ表示するメッセージ</label>
        <div className="row" style={{ flexWrap: "nowrap" }}><input className="input" value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="メンテナンス中です" /><button className="btn primary" disabled={!dirty} onClick={() => put(msgKey, msg)}>保存</button></div></div>
    </div>
  );
}
export function Settings() {
  const { toast } = useUI();
  const { data, loading, error, reload } = useLoad(() => api("/api/admin/settings"));
  const put = async (key, value) => { try { await api("/api/admin/settings", "PUT", { key, value }); toast("保存しました"); reload(); } catch (e) { toast(e.message, "err"); } };
  if (loading && !data) return <Skeleton rows={3} />;
  if (error) return <ErrorBox text={error} />;
  const s = data.settings || {};
  return <>
    <Control title="ログイン" desc="停止すると一般ユーザーはログインできません(ログイン済みセッションはそのまま使えます)" enabledKey="login_enabled" msgKey="login_disabled_message" s={s} put={put} />
    <Control title="新規アカウント作成" desc="停止すると新しいアカウントを作れません" enabledKey="register_enabled" msgKey="register_disabled_message" s={s} put={put} />
    <div className="notice info"><Icon name="info" />変更はGather APIに即時反映されます。停止中も admin / developer はログインできます。</div>
  </>;
}


/* =========================================================
   アクセスマップ(PostHog GeoIP)
   ========================================================= */
export function Geo({ go }) {
  const [mode, setMode] = useState("japan"); const [days, setDays] = useState(30); const [anon, setAnon] = useState(true);
  const { data, loading, error, reload } = useLoad(() => api(`/api/admin/geo?days=${days}`), [days]);
  const rows = (data?.rows || []).filter((r) => anon || r.username);
  const total = rows.reduce((a, r) => a + r.n, 0); const users = new Set(rows.map((r) => r.uid)).size;
  return <>
    <div className="row">
      <Seg value={mode} onChange={setMode} options={[["japan", "日本(都道府県)"], ["world", "世界"]]} />
      <Seg value={days} onChange={setDays} options={[[7, "7日"], [30, "30日"], [90, "90日"]]} />
      <label className="row sub" style={{ gap: 8 }}><Switch checked={anon} onChange={setAnon} />匿名アクセスを含める</label>
      <button className="btn" onClick={reload}><Icon name="refresh" size={15} />更新</button>
      {data && <span className="sub" style={{ marginLeft: "auto" }}>{total.toLocaleString()}アクセス / {users}人(ユーザー)</span>}
    </div>
    <ErrorBox text={error} />
    {loading && !data ? <Skeleton rows={6} /> : data && <GeoPanel rows={rows} mode={mode} onOpenUser={(name) => go("users", { q: name })} />}
  </>;
}

/* =========================================================
   機能ステータス(Axiomにログを残す)
   ========================================================= */
const FEATURE_LIST = ["いいね", "リポスト", "ブックマーク", "投稿", "返信", "DM", "フォロー", "通知", "チャット", "ポイント・スタンプ", "画像アップロード", "アンケート", "ログイン", "新規アカウント作成"];
const STATUS_LIST = ["停止", "復旧", "不具合", "調査中", "メンテナンス"];
export function Status() {
  const { toast } = useUI();
  const [f, setF] = useState({ feature: "いいね", custom: "", status: "停止", message: "" }); const [busy, setBusy] = useState(false);
  const { data, loading, error, reload } = useLoad(() => api("/api/admin/status-log"));
  const feature = f.feature === "__other" ? f.custom.trim() : f.feature;
  const submit = async () => {
    setBusy(true);
    try { await api("/api/admin/status-log", "POST", { feature, status: f.status, message: f.message }); toast(`Axiomに記録しました: ${feature} ${f.status}`); setF({ ...f, message: "" }); setTimeout(reload, 1800); }
    catch (e) { toast(e.message, "err"); } finally { setBusy(false); }
  };
  const quick = (feat, status) => setF({ feature: FEATURE_LIST.includes(feat) ? feat : "__other", custom: feat, status, message: "" });
  return <>
    <div className="card card-pad">
      <div className="card-head"><div><h2>機能ステータスを記録</h2><div className="sub">「いいねが停止しました」「復旧しました」などをAxiomにログとして残します(機能そのものは操作しません)</div></div></div>
      <div className="grid g3" style={{ marginBottom: 12 }}>
        <div className="field"><label>機能</label>
          <select className="select" value={f.feature} onChange={(e) => setF({ ...f, feature: e.target.value })}>{FEATURE_LIST.map((x) => <option key={x}>{x}</option>)}<option value="__other">その他(自由入力)</option></select></div>
        {f.feature === "__other" ? <div className="field"><label>機能名</label><input className="input" value={f.custom} onChange={(e) => setF({ ...f, custom: e.target.value })} placeholder="例: ランキング" /></div> : <div />}
        <div className="field"><label>状態</label><Seg value={f.status} onChange={(v) => setF({ ...f, status: v })} options={STATUS_LIST.map((x) => [x, x])} /></div>
      </div>
      <div className="field"><label>メッセージ(任意・300文字まで)</label><input className="input" value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} placeholder="例: データベース障害のため一時停止 / 原因を修正して復旧" /></div>
      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn primary" disabled={busy || !feature} onClick={submit}>{busy ? "記録中…" : `「${feature || "?"}」を「${f.status}」として記録`}</button>
      </div>
    </div>
    <div className="card card-pad">
      <div className="card-head"><div><h2>現在の状況</h2><div className="sub">機能ごとの最新の記録</div></div><button className="btn sm" onClick={reload}><Icon name="refresh" size={14} />更新</button></div>
      <ErrorBox text={error} />
      {loading && !data ? <Skeleton rows={3} /> : !data?.current?.length ? <Empty icon="activity" text="まだ記録がありません" /> : (
        <div className="grid g3">{data.current.map((e) => (
          <div key={e.feature} className="check" style={{ alignItems: "flex-start" }}>
            <div style={{ minWidth: 0 }}><b>{e.feature}</b><div className="row" style={{ gap: 6, marginTop: 4 }}><Badge tone={STATUS_TONE[e.status] || "gray"} dot>{e.status}</Badge><span className="sub">{ago(e._time)}</span></div>{e.message && <span style={{ display: "block", marginTop: 4 }}>{e.message}</span>}</div>
            <button className="btn sm" onClick={() => quick(e.feature, e.status === "復旧" ? "停止" : "復旧")}>{e.status === "復旧" ? "停止を記録" : "復旧を記録"}</button>
          </div>))}</div>)}
    </div>
    <div className="card card-pad">
      <div className="card-head"><h2>履歴</h2></div>
      {loading && !data ? <Skeleton rows={4} /> : !data?.events?.length ? <Empty icon="list" text="履歴はありません" /> : (
        <div className="stack">{data.events.slice(0, 60).map((e, i) => (
          <div key={i} className="row" style={{ gap: 10, flexWrap: "nowrap", alignItems: "flex-start" }}>
            <span className="sub" style={{ width: 96, flex: "none" }} title={fmtFull(e._time)}>{fmt(e._time)}</span>
            <Badge tone={STATUS_TONE[e.status] || "gray"} dot>{e.status}</Badge><b>{e.feature}</b><span className="sub grow">{e.message}</span>
          </div>))}</div>)}
    </div>
  </>;
}
