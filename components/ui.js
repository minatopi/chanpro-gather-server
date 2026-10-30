"use client";
import { createContext, useCallback, useContext, useEffect, useState } from "react";

/* ---------- api / format ---------- */
export async function api(path, method = "GET", body) {
  const r = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { location.href = "/login"; throw new Error("ログインが必要です"); }
  if (!r.ok) throw new Error(j.error || "エラーが発生しました");
  return j;
}
export const fmt = (t) => (t ? new Date(t).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
export const fmtFull = (t) => (t ? new Date(t).toLocaleString("ja-JP") : "");
export function ago(t) {
  if (!t) return "";
  const s = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000);
  if (s < 60) return "たった今";
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
  return `${Math.floor(s / 86400)}日前`;
}
export function remaining(t) {
  if (!t) return { text: "無期限", tone: "red" };
  const ms = new Date(t).getTime() - Date.now();
  if (new Date(t).getFullYear() >= 2090) return { text: "無期限", tone: "red" };
  if (ms <= 0) return { text: "期限切れ", tone: "gray" };
  const m = Math.ceil(ms / 60000);
  if (m < 60) return { text: `あと${m}分`, tone: "amber" };
  if (m < 1440) return { text: `あと${Math.ceil(m / 60)}時間`, tone: "amber" };
  return { text: `あと${Math.ceil(m / 1440)}日`, tone: "amber" };
}
export const isBanned = (u) => u?.ban_until && new Date(u.ban_until).getTime() > Date.now();

export const TYPE_INFO = {
  login_success: ["ログイン成功", "green"], login_failed: ["ログイン失敗", "red"], login_blocked: ["ログイン停止中", "amber"],
  register_created: ["新規作成", "blue"], register_blocked: ["新規作成停止中", "amber"], access: ["アクセス", "gray"],
  feature_status: ["機能ステータス", "violet"], ip_banned_request: ["IP BAN遮断", "red"], device_banned_request: ["端末BAN遮断", "red"], ip_rate_limited: ["レート制限", "amber"],
};
export const STATUS_TONE = { 停止: "red", 復旧: "green", 不具合: "amber", 調査中: "blue", メンテナンス: "violet" };
export function typeInfo(t) {
  if (TYPE_INFO[t]) return TYPE_INFO[t];
  if (String(t).startsWith("admin_")) return ["管理: " + String(t).slice(6), "violet"];
  return [String(t || "-"), "gray"];
}

/* ---------- icons ---------- */
const ICONS = {
  home: "M3 11l9-8 9 8|M5 10v10h14V10", users: "M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2|M10 3a4 4 0 1 0 0 8a4 4 0 0 0 0-8|M21 21v-2a4 4 0 0 0-3-3.87|M16 3.13a4 4 0 0 1 0 7.75",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z", flag: "M5 21V4h11l-2 4 2 4H5", list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  power: "M12 3v9|M6.3 6.3a8 8 0 1 0 11.4 0", search: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14|M21 21l-4.3-4.3", x: "M18 6L6 18M6 6l12 12",
  logout: "M9 21H5V3h4|M16 17l5-5-5-5|M21 12H9", refresh: "M21 12a9 9 0 1 1-3-6.7L21 8|M21 3v5h-5", check: "M20 6L9 17l-5-5",
  badge: "M12 2l2.4 2.1 3.2-.3 1 3 2.7 1.8-.9 3.1.9 3.1-2.7 1.8-1 3-3.2-.3L12 22l-2.4-2.1-3.2.3-1-3L2.7 15.4l.9-3.1-.9-3.1 2.7-1.8 1-3 3.2.3z|M8.5 12l2.5 2.5 4.5-5", 
  ban: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18|M5.6 5.6l12.8 12.8", alert: "M12 9v4M12 17h.01|M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  inbox: "M22 12h-6l-2 3h-4l-2-3H2|M5.5 5h13l3.5 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z", activity: "M22 12h-4l-3 9L9 3l-3 9H2", globe: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18|M3 12h18|M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18",
  copy: "M9 9h11v11H9z|M5 15V4h11", info: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18|M12 16v-4M12 8h.01",
};
export function Icon({ name, size = 18, stroke = 2 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {(ICONS[name] || "").split("|").map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}

/* ---------- small components ---------- */
export const Badge = ({ tone = "gray", dot, children }) => <span className={`badge ${tone}`}>{dot && <i className="dot" />}{children}</span>;

const PALETTE = ["#2f5bff", "#12a150", "#e0554b", "#8b5cf6", "#e08a1e", "#0ea5b7", "#d946a8", "#4b5563"];
export function Avatar({ name = "?", src, size = 36 }) {
  const h = [...String(name)].reduce((a, c) => a + c.charCodeAt(0), 0);
  const style = { width: size, height: size, fontSize: size * 0.42, background: src ? `url(${src}) center/cover` : PALETTE[h % PALETTE.length] };
  return <div className="avatar" style={style}>{!src && String(name).trim().slice(0, 1).toUpperCase()}</div>;
}
export const Switch = ({ checked, onChange, disabled }) => <button type="button" role="switch" aria-checked={checked} disabled={disabled} className={`switch ${checked ? "on" : ""}`} onClick={() => onChange(!checked)} />;
export const Seg = ({ value, onChange, options }) => <div className="seg">{options.map(([v, l]) => <button key={v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>{l}</button>)}</div>;
export const Empty = ({ icon = "inbox", text }) => <div className="empty"><div className="ico"><Icon name={icon} size={22} /></div><div>{text}</div></div>;
export const Skeleton = ({ rows = 4 }) => <div className="stack">{Array.from({ length: rows }, (_, i) => <div key={i} className="skel" style={{ opacity: 1 - i * 0.12 }} />)}</div>;
export const ErrorBox = ({ text }) => text ? <div className="notice err"><Icon name="alert" />{text}</div> : null;
export function SearchBox({ value, onChange, placeholder, onEnter }) {
  return <div className="input-icon grow" style={{ minWidth: 200 }}><Icon name="search" size={16} /><input className="input" value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onEnter?.()} placeholder={placeholder} /></div>;
}

export function Modal({ title, children, footer, onClose }) {
  useEffect(() => { const f = (e) => e.key === "Escape" && onClose?.(); window.addEventListener("keydown", f); return () => window.removeEventListener("keydown", f); }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal"><div className="modal-head">{title}</div><div className="modal-body">{children}</div>{footer && <div className="modal-foot">{footer}</div>}</div>
    </div>
  );
}
export function Drawer({ onClose, header, children }) {
  useEffect(() => { const f = (e) => e.key === "Escape" && onClose?.(); window.addEventListener("keydown", f); return () => window.removeEventListener("keydown", f); }, [onClose]);
  return (
    <div className="drawer-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <aside className="drawer"><div className="drawer-head">{header}<button className="btn ghost sm" style={{ marginLeft: "auto" }} onClick={onClose}><Icon name="x" /></button></div><div className="drawer-body">{children}</div></aside>
    </div>
  );
}

/* ---------- toast + confirm ---------- */
const Ctx = createContext({ toast: () => {}, confirm: async () => true });
export const useUI = () => useContext(Ctx);
export function UIProvider({ children }) {
  const [toasts, setToasts] = useState([]); const [dlg, setDlg] = useState(null);
  const toast = useCallback((msg, tone = "ok") => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, msg, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800);
  }, []);
  const confirm = useCallback((o) => new Promise((res) => setDlg({ ...o, res })), []);
  const close = (v) => { dlg.res(v); setDlg(null); };
  return (
    <Ctx.Provider value={{ toast, confirm }}>
      {children}
      <div className="toasts">{toasts.map((t) => <div key={t.id} className={`toast ${t.tone === "err" ? "err" : ""}`}><Icon name={t.tone === "err" ? "alert" : "check"} size={16} />{t.msg}</div>)}</div>
      {dlg && (
        <Modal title={dlg.title || "確認"} onClose={() => close(false)} footer={<>
          <button className="btn" onClick={() => close(false)}>キャンセル</button>
          <button className={`btn ${dlg.danger ? "danger" : "primary"}`} onClick={() => close(true)}>{dlg.okText || "OK"}</button>
        </>}>{dlg.body}</Modal>
      )}
    </Ctx.Provider>
  );
}

/* ---------- data hook ---------- */
export function useLoad(fn, deps = []) {
  const [s, setS] = useState({ loading: true, data: null, error: "" });
  const run = useCallback(() => {
    setS((p) => ({ ...p, loading: true, error: "" }));
    return fn().then((d) => setS({ loading: false, data: d, error: "" })).catch((e) => setS({ loading: false, data: null, error: e.message }));
  }, deps); // eslint-disable-line
  useEffect(() => { run(); }, [run]);
  return { ...s, reload: run };
}
export function useDebounced(value, ms = 350) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
