"use client";
import { useState } from "react";
export default function Login() {
  const [pw, setPw] = useState(""); const [err, setErr] = useState("");
  async function submit(e) {
    e.preventDefault(); setErr("");
    const r = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) });
    if (r.ok) location.href = "/admin"; else setErr((await r.json()).error || "失敗しました");
  }
  return (
    <main style={{ maxWidth: 360, marginTop: 120 }}>
      <h1>Chanpro 管理</h1>
      <form onSubmit={submit} className="row">
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="ADMIN_PASSWORD" autoFocus style={{ flex: 1 }} />
        <button className="on">ログイン</button>
      </form>
      {err && <p className="err">{err}</p>}
    </main>
  );
}
