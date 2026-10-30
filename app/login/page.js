"use client";
import { useState } from "react";
export default function Login() {
  const [pw, setPw] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setErr(""); setBusy(true);
    const r = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) });
    if (r.ok) location.href = "/admin"; else { setErr((await r.json().catch(() => ({}))).error || "ログインに失敗しました"); setBusy(false); }
  }
  return (
    <div className="login-wrap">
      <form onSubmit={submit} className="card login-card">
        <div className="logo"><div className="logo-mark">C</div><div><b style={{ fontSize: 20 }}>Chanpro Admin</b><small>管理者パスワードでログイン</small></div></div>
        <div className="stack">
          <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="パスワード" autoFocus autoComplete="current-password" />
          {err && <div className="notice err" style={{ textAlign: "left" }}>{err}</div>}
          <button className="btn primary" style={{ padding: "11px 14px" }} disabled={busy || !pw}>{busy ? "確認中…" : "ログイン"}</button>
        </div>
      </form>
    </div>
  );
}
