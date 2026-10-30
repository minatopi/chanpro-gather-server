"use client";
import { useEffect, useMemo, useState } from "react";
import { geoNaturalEarth1, geoMercator, geoPath, geoContains } from "d3-geo";
import { feature } from "topojson-client";
import { Badge, Empty, Icon, ago } from "./ui";

const WORLD_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";
const JAPAN_URL = "https://cdn.jsdelivr.net/gh/dataofjapan/land@master/japan.geojson";
const cache = {};
async function loadLand(mode) {
  if (cache[mode]) return cache[mode];
  const r = await fetch(mode === "japan" ? JAPAN_URL : WORLD_URL);
  if (!r.ok) throw new Error("地図データを取得できませんでした");
  const j = await r.json();
  return (cache[mode] = mode === "japan" ? j : feature(j, j.objects.countries));
}
const JP_BOX = { type: "Feature", geometry: { type: "Polygon", coordinates: [[[122.5, 24], [146, 24], [146, 45.8], [122.5, 45.8], [122.5, 24]]] } };
const W = 900;
const H = { japan: 640, world: 470 };
const featName = (f, mode) => (mode === "japan" ? f.properties?.nam_ja || f.properties?.nam : f.properties?.name) || "";
const lerp = (a, b, t) => Math.round(a + (b - a) * t);
const shade = (t) => `rgb(${lerp(238, 47, t)},${lerp(242, 91, t)},${lerp(255, 255, t)})`;

export function GeoPanel({ rows, mode, onOpenUser }) {
  const [land, setLand] = useState(null); const [landErr, setLandErr] = useState(""); const [sel, setSel] = useState(null);
  useEffect(() => { let off = false; setLand(null); setLandErr(""); setSel(null); loadLand(mode).then((l) => !off && setLand(l)).catch((e) => !off && setLandErr(e.message)); return () => { off = true; }; }, [mode]);

  const data = useMemo(() => {
    const list = mode === "japan" ? rows.filter((r) => r.cc === "JP") : rows;
    const feats = land?.features || [];
    const memo = new Map();
    const findFeat = (lon, lat) => {
      const k = lon + "," + lat; if (memo.has(k)) return memo.get(k);
      let idx = -1; for (let i = 0; i < feats.length; i++) { if (geoContains(feats[i], [lon, lat])) { idx = i; break; } }
      memo.set(k, idx); return idx;
    };
    const enriched = list.map((r) => {
      const idx = feats.length ? findFeat(r.lon, r.lat) : -1;
      const fallback = mode === "japan" ? (r.region || r.city || "不明") : (r.country || "不明");
      return { ...r, idx, label: idx >= 0 ? featName(feats[idx], mode) : fallback };
    });
    const byRegion = new Map(), byIdx = new Map(), pts = new Map();
    for (const r of enriched) {
      const g = byRegion.get(r.label) || { label: r.label, n: 0, users: new Map() }; g.n += r.n;
      const u = g.users.get(r.uid) || { uid: r.uid, username: r.username, n: 0 }; u.n += r.n; g.users.set(r.uid, u); byRegion.set(r.label, g);
      if (r.idx >= 0) byIdx.set(r.idx, (byIdx.get(r.idx) || 0) + r.n);
      const pk = r.lat + "," + r.lon; const p = pts.get(pk) || { key: pk, lat: r.lat, lon: r.lon, n: 0, label: r.label, city: r.city, users: new Map() }; p.n += r.n;
      const pu = p.users.get(r.uid) || { username: r.username, n: 0 }; pu.n += r.n; p.users.set(r.uid, pu); pts.set(pk, p);
    }
    return { enriched, regions: [...byRegion.values()].sort((a, b) => b.n - a.n), byIdx, points: [...pts.values()], maxIdx: Math.max(1, ...byIdx.values()) };
  }, [rows, mode, land]);

  const { path, projection } = useMemo(() => {
    const h = H[mode];
    const proj = mode === "japan" ? geoMercator().fitExtent([[10, 10], [W - 10, h - 10]], JP_BOX) : geoNaturalEarth1().fitExtent([[10, 10], [W - 10, h - 10]], { type: "Sphere" });
    return { projection: proj, path: geoPath(proj) };
  }, [mode]);

  const maxPt = Math.max(1, ...data.points.map((p) => p.n));
  const shownUsers = useMemo(() => {
    const list = data.enriched.filter((r) => !sel || r.label === sel);
    const m = new Map();
    for (const r of list) { const e = m.get(r.uid) || { uid: r.uid, username: r.username, n: 0, places: new Set(), last: r.last_seen }; e.n += r.n; e.places.add([r.label, r.city].filter(Boolean).join(" ")); if (new Date(r.last_seen) > new Date(e.last)) e.last = r.last_seen; m.set(r.uid, e); }
    return [...m.values()].sort((a, b) => b.n - a.n).slice(0, 100);
  }, [data, sel]);

  if (!rows.length) return <div className="card"><Empty icon="globe" text="位置情報つきのアクセスがまだありません(PostHogのGeoIPが有効か確認してください)" /></div>;
  const maxRegion = Math.max(1, ...data.regions.map((r) => r.n));
  return <>
    {landErr && <div className="notice warn"><Icon name="alert" />地図の背景データを取得できなかったため、位置の点だけを表示しています({landErr})</div>}
    <div className="grid" style={{ gridTemplateColumns: "minmax(0,1.7fr) minmax(280px,1fr)", alignItems: "start" }}>
      <div className="card" style={{ padding: 10, overflow: "hidden" }}>
        <svg viewBox={`0 0 ${W} ${H[mode]}`} style={{ width: "100%", height: "auto", display: "block", background: "#f4f7fd", borderRadius: 10 }}>
          {mode === "world" && <path d={path({ type: "Sphere" })} fill="#eef3fb" stroke="#dfe6f3" />}
          {land?.features?.map((f, i) => {
            const n = data.byIdx.get(i) || 0; const label = featName(f, mode);
            return <path key={i} d={path(f)} fill={n ? shade(Math.sqrt(n / data.maxIdx)) : "#ffffff"} stroke="#cfd6e4" strokeWidth={0.6} style={{ cursor: n ? "pointer" : "default", outline: sel === label ? "none" : undefined }} onClick={() => n && setSel(sel === label ? null : label)}>
              <title>{label}{n ? `: ${n}アクセス` : ""}</title></path>;
          })}
          {data.points.map((p) => { const xy = projection([p.lon, p.lat]); if (!xy) return null;
            const r = 4 + Math.sqrt(p.n / maxPt) * 13; const names = [...p.users.values()].map((u) => u.username || "匿名").slice(0, 8).join(", ");
            return <circle key={p.key} cx={xy[0]} cy={xy[1]} r={r} fill="rgba(220,47,63,.55)" stroke="#fff" strokeWidth={1.5} style={{ cursor: "pointer" }} onClick={() => setSel(sel === p.label ? null : p.label)}>
              <title>{[p.label, p.city].filter(Boolean).join(" / ")} — {p.n}アクセス / {p.users.size}人{"\n"}{names}</title></circle>; })}
        </svg>
        <div className="row sub" style={{ padding: "8px 6px 2px", justifyContent: "space-between" }}>
          <span>赤い丸=アクセス元の推定位置(大きいほど多い)/ 青の濃さ={mode === "japan" ? "都道府県" : "国"}ごとのアクセス数</span>
          {sel && <button className="btn sm" onClick={() => setSel(null)}>「{sel}」の絞り込みを解除</button>}
        </div>
      </div>
      <div className="card card-pad">
        <div className="card-head"><h2>{mode === "japan" ? "都道府県ランキング" : "国・地域ランキング"}</h2><Badge tone="blue">{data.regions.length}</Badge></div>
        <div className="bars" style={{ maxHeight: 470, overflowY: "auto" }}>
          {data.regions.slice(0, 30).map((g) => (
            <div key={g.label} className="bar-row" style={{ gridTemplateColumns: "92px 1fr 40px", cursor: "pointer", opacity: !sel || sel === g.label ? 1 : 0.45 }} onClick={() => setSel(sel === g.label ? null : g.label)}>
              <span title={g.label} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: sel === g.label ? 800 : 500 }}>{g.label}</span>
              <div className="bar"><i style={{ width: `${(g.n / maxRegion) * 100}%` }} /></div>
              <span className="sub" style={{ textAlign: "right" }} title={`${g.users.size}人`}>{g.n}</span>
            </div>))}
        </div>
      </div>
    </div>
    <div className="card card-pad">
      <div className="card-head"><div><h2>{sel ? `「${sel}」のユーザー` : "ユーザー別のアクセス地域"}</h2><div className="sub">位置はIPからの推定で、市区町村レベルのおおよその場所です</div></div><Badge tone="gray">{shownUsers.length}人</Badge></div>
      <div className="table-wrap" style={{ boxShadow: "none" }}><table>
        <thead><tr><th>ユーザー</th><th>地域</th><th style={{ textAlign: "right" }}>アクセス</th><th>最終</th></tr></thead>
        <tbody>{shownUsers.map((u) => (
          <tr key={u.uid} className={u.username ? "click" : ""} onClick={() => u.username && onOpenUser(u.username)}>
            <td><b>{u.username || "匿名(未ログイン)"}</b></td>
            <td>{[...u.places].slice(0, 3).join("、")}{u.places.size > 3 ? ` ほか${u.places.size - 3}` : ""}</td>
            <td style={{ textAlign: "right" }}>{u.n}</td><td className="sub">{ago(u.last)}</td>
          </tr>))}</tbody>
      </table></div>
    </div>
  </>;
}
