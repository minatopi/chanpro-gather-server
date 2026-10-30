"use client";
import { useState } from "react";
import { UIProvider, Icon, api } from "@/components/ui";
import { Dashboard, Users, Bans, Reports, Logs, Settings, Geo, Status } from "@/components/views";

const NAV = [
  ["dashboard", "ダッシュボード", "home", "全体の状況をひと目で確認", Dashboard],
  ["users", "ユーザー", "users", "権限・公式バッジ・アカウントBAN", Users],
  ["bans", "BAN管理", "shield", "ユーザー名・IP・端末のBANと芋づる式解除", Bans],
  ["reports", "報告・通報", "flag", "ユーザーから届いた報告と通報", Reports],
  ["geo", "アクセスマップ", "globe", "どこからアクセスが多いか(日本・世界)", Geo],
  ["logs", "アクセスログ", "list", "ログイン・アクセス・IP制限・機能ステータス(Axiom)", Logs],
  ["status", "機能ステータス", "activity", "いいね等の停止・復旧をAxiomに記録", Status],
  ["settings", "停止設定", "power", "ログイン・新規作成の停止", Settings],
];

export default function AdminClient() {
  const [view, setView] = useState("dashboard"); const [params, setParams] = useState({});
  const go = (v, p = {}) => { setParams(p); setView(v); window.scrollTo({ top: 0 }); };
  const cur = NAV.find((n) => n[0] === view); const View = cur[4];
  return (
    <UIProvider>
      <div className="app">
        <aside className="side">
          <div className="logo"><div className="logo-mark">C</div><div><b>Chanpro</b><small>Admin Console</small></div></div>
          <nav className="nav">
            {NAV.map(([k, label, icon]) => <button key={k} className={view === k ? "active" : ""} onClick={() => go(k)}><Icon name={icon} />{label}</button>)}
          </nav>
          <div className="side-foot"><div className="nav"><button onClick={() => api("/api/admin/logout", "POST").then(() => (location.href = "/login"))}><Icon name="logout" />ログアウト</button></div></div>
        </aside>
        <div className="content">
          <header className="topbar"><div><h1>{cur[1]}</h1><p>{cur[3]}</p></div></header>
          <main className="page"><View key={view + JSON.stringify(params)} go={go} params={params} /></main>
        </div>
      </div>
    </UIProvider>
  );
}
