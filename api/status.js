
/**
 * ChanPro Production Status API
 * Read-only monitoring API.
 * Deploy at chanpro-gather-server/api/status.js
 *
 * GET  /api/status?action=health
 * GET  /api/status?action=dashboard
 * GET  /api/status?action=dashboard&days=7
 */
"use strict";

const E = process.env;

const BASE = (E.SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = E.SUPABASE_SERVICE_ROLE_KEY || "";
const AXIOM = E.AXIOM_TOKEN || "";
const DATASET = E.AXIOM_DATASET || "chanpro";
const METRICS =
  E.STATUS_METRICS_URL ||
  "https://minatopi.github.io/chanpro-gather-surveillance/metrics.json";

const configuredTimeout = Number(E.STATUS_TEST_TIMEOUT_MS || 8000);
const TIMEOUT = Number.isFinite(configuredTimeout)
  ? Math.max(2000, Math.min(15000, configuredTimeout))
  : 8000;

const FEATURES = [
  ["post", "投稿"],
  ["reply", "返信"],
  ["read", "投稿・返信の読み込み"],
  ["delete", "投稿・返信の削除"],
  ["image", "画像アップロード"],
  ["pin", "投稿固定"],
  ["like", "いいね"],
  ["repost", "リポスト"],
  ["bookmark", "ブックマーク"],
  ["poll", "投票"],
  ["follow", "フォロー"],
  ["report", "通報"],
  ["dm_send", "DM送信"],
  ["dm_read", "DM読み込み"],
  ["chat", "チャット"],
  ["notification", "通知"],
  ["developer_msg", "運営メッセージ"],
  ["points_send", "ポイント送信"],
  ["stamp", "スタンプ"],
  ["bonus", "ログイン・継続ボーナス"],
  ["profile", "プロフィール・設定"],
  ["account_delete", "アカウント削除"]
];

const ACTIONS = {
  "post-create": "post",
  "reply-create": "reply",
  "post-read": "read",
  "reply-list": "read",
  "reply-prefetch": "read",
  "limited-post-list": "read",
  "post-view": "read",

  "post-delete": "delete",
  "reply-delete": "delete",

  "image-upload": "image",
  "image-register": "image",

  "post-pin": "pin",
  "post-like-toggle": "like",
  "repost-toggle": "repost",
  "bookmark-toggle": "bookmark",
  "poll-vote": "poll",
  "follow-toggle": "follow",

  "report": "report",
  "report-create": "report",

  "dm-send": "dm_send",
  "dm-list": "dm_read",
  "dm-get": "dm_read",

  "chat-history-add": "chat",
  "chat-history-delete": "chat",
  "chat-pins-save": "chat",

  "notifications-read": "notification",

  "developer-inbox-send": "developer_msg",
  "developer-message-read": "developer_msg",

  "transfer-points": "points_send",
  "stamp-purchase": "stamp",

  "user-login-streak": "bonus",
  "weekly-points": "bonus",
  "chat-points": "bonus",

  "user-update": "profile",
  "profile-music-save": "profile",
  "user-settings": "profile",

  "account-delete": "account_delete"
};

const clean = (value, max = 300) =>
  String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, max);

function output(res, status, data) {
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.end(JSON.stringify(data));
}

async function get(url, options = {}, timeout = TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    const body = await response.text();

    let data;

    try {
      data = body ? JSON.parse(body) : null;
    } catch (_) {
      data = { message: body.slice(0, 250) };
    }

    if (!response.ok) {
      throw new Error(
        clean(
          data?.message ||
          data?.details ||
          `HTTP ${response.status}`
        )
      );
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function sb(path, options = {}) {
  if (!BASE || !KEY) {
    throw new Error("Supabase環境変数が未設定です");
  }

  return get(`${BASE}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
}

async function queryAxiom(apl) {
  if (!AXIOM) {
    throw new Error("AXIOM_TOKEN が未設定です");
  }

  const data = await get(
    "https://api.axiom.co/v1/datasets/_apl?format=legacy",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AXIOM}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ apl })
    }
  );

  if (Array.isArray(data.matches)) {
    return data.matches.map(item => ({
      _time: item._time,
      ...(item.data || {})
    }));
  }

  const table = data.tables?.[0];

  if (!table?.fields || !table?.columns) {
    return [];
  }

  const count = (table.columns[0] || []).length;

  return Array.from({ length: count }, (_, index) => {
    const row = {};

    table.fields.forEach((field, column) => {
      row[field.name] = table.columns[column]?.[index];
    });

    return row;
  });
}

function timestamp(value) {
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : 0;
}

function labelTime(value) {
  return new Date(value).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit"
  });
}

function featureOf(row) {
  return ACTIONS[String(row.action || "")] ||
    String(row.feature || "");
}

function createBucket() {
  return {
    requests: 0,
    errors: 0,
    latency_total: 0,
    latency_count: 0
  };
}

async function dashboard(days) {
  if (!AXIOM) {
    throw new Error("AXIOM_TOKEN が未設定です");
  }

  const dataset = DATASET.replace(/'/g, "''");

  const logs = await queryAxiom(
    `['${dataset}']` +
    ` | where _time > ago(${days}d)` +
    ` | where type in ("access","api_error","feature_blocked","feature_status")` +
    ` | sort by _time desc` +
    ` | take 5000`
  );

  const bucketCount = Math.min(
    48,
    Math.max(12, days * 4)
  );

  const now = Date.now();
  const period = days * 86400000;
  const interval = period / bucketCount;
  const start = now - period;

  const map = new Map();

  for (const [key, name] of FEATURES) {
    map.set(key, {
      key,
      name,
      requests: 0,
      errors: 0,
      blocked: 0,
      latencies: [],
      last_seen: null,
      buckets: Array.from(
        { length: bucketCount },
        () => createBucket()
      )
    });
  }

  const events = [];

  for (const row of logs) {
    const key = featureOf(row);
    const feature = map.get(key);

    if (!feature) continue;

    const time = timestamp(row._time);

    const isoTime = time
      ? new Date(time).toISOString()
      : null;

    if (
      !feature.last_seen ||
      time > timestamp(feature.last_seen)
    ) {
      feature.last_seen = isoTime;
    }

    if (row.type === "access") {
      feature.requests++;

      const status = Number(row.status ?? 200);
      const failed = status >= 400;

      if (failed) {
        feature.errors++;
      }

      const latency = Number(
        row.ms ?? row.duration_ms
      );

      if (Number.isFinite(latency) && latency >= 0) {
        feature.latencies.push(latency);
      }

      if (time >= start && time < now) {
        const index = Math.min(
          bucketCount - 1,
          Math.floor((time - start) / interval)
        );

        const bucket = feature.buckets[index];

        bucket.requests++;

        if (failed) {
          bucket.errors++;
        }

        if (
          Number.isFinite(latency) &&
          latency >= 0
        ) {
          bucket.latency_total += latency;
          bucket.latency_count++;
        }
      }
    }

    if (row.type === "api_error") {
      feature.requests++;
      feature.errors++;

      events.push({
        time: isoTime,
        feature: key,
        feature_name: feature.name,
        kind: "error",
        message: clean(
          row.message ||
          row.error ||
          row.action ||
          "APIエラー"
        )
      });

      if (time >= start && time < now) {
        const index = Math.min(
          bucketCount - 1,
          Math.floor((time - start) / interval)
        );

        const bucket = feature.buckets[index];

        bucket.requests++;
        bucket.errors++;
      }
    }

    if (row.type === "feature_blocked") {
      feature.blocked++;

      events.push({
        time: isoTime,
        feature: key,
        feature_name: feature.name,
        kind: "blocked",
        message: clean(
          row.message ||
          row.reason ||
          "機能停止"
        )
      });
    }

    if (
      row.type === "feature_status" &&
      !["正常", "稼働中"].includes(row.status)
    ) {
      events.push({
        time: isoTime,
        feature: key,
        feature_name: feature.name,
        kind: "blocked",
        message: clean(
          row.message ||
          row.status ||
          "状態異常"
        )
      });
    }
  }

  const features = [...map.values()].map(feature => {
    const requests = feature.requests;
    const errors = feature.errors;

    const successRate = requests > 0
      ? ((requests - errors) / requests) * 100
      : null;

    /*
     * 判定ルール
     *
     * 停止ログあり         => 停止
     * リクエスト0件        => データ不足
     * 1件以上・95%未満     => 不具合
     * 1件以上・99%未満     => 注意
     * 1件以上・99%以上     => 正常
     */

    let state;

    if (feature.blocked > 0) {
      state = "停止";
    } else if (requests === 0) {
      state = "データ不足";
    } else if (successRate < 95) {
      state = "不具合";
    } else if (successRate < 99) {
      state = "注意";
    } else {
      state = "正常";
    }

    const buckets = feature.buckets.map(
      (bucket, index) => {
        const from = start + index * interval;

        return {
          label: labelTime(from),

          success_rate: bucket.requests > 0
            ? (
                (bucket.requests - bucket.errors) /
                bucket.requests
              ) * 100
            : null,

          avg_ms: bucket.latency_count > 0
            ? bucket.latency_total /
              bucket.latency_count
            : null,

          requests: bucket.requests,
          errors: bucket.errors
        };
      }
    );

    const avgMs = feature.latencies.length > 0
      ? feature.latencies.reduce(
          (total, value) => total + value,
          0
        ) / feature.latencies.length
      : null;

    return {
      key: feature.key,
      name: feature.name,

      requests,
      errors,
      blocked: feature.blocked,

      success_rate: successRate,
      avg_ms: avgMs,

      last_seen: feature.last_seen,

      state,

      message: feature.blocked
        ? "停止ログあり"
        : errors > 0
          ? "APIエラー記録あり"
          : "",

      buckets
    };
  });

  events.sort(
    (a, b) => timestamp(b.time) - timestamp(a.time)
  );

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    period_days: days,
    total_features: features.length,

    summary: {
      normal: features.filter(
        x => x.state === "正常"
      ).length,

      warning: features.filter(
        x => x.state === "注意"
      ).length,

      error: features.filter(
        x => x.state === "不具合"
      ).length,

      stopped: features.filter(
        x => x.state === "停止"
      ).length,

      insufficient: features.filter(
        x => x.state === "データ不足"
      ).length
    },

    features,
    events: events.slice(0, 300)
  };
}

module.exports = async function(req, res) {
  try {
    const action = String(
      req.query?.action || "dashboard"
    );

    if (req.method === "OPTIONS") {
      res.setHeader("Allow", "GET, OPTIONS");
      return res.status(204).end();
    }

    if (
      req.method === "GET" &&
      action === "health"
    ) {
      return output(res, 200, {
        ok: true,
        service: "chanpro-status-api",
        time: new Date().toISOString()
      });
    }

    if (
      req.method === "GET" &&
      action === "dashboard"
    ) {
      const requestedDays = Number(
        req.query?.days ?? 30
      );

      const days = Number.isFinite(requestedDays)
        ? Math.max(1, Math.min(30, Math.floor(requestedDays)))
        : 30;

      const result = await dashboard(days);

      return output(res, 200, result);
    }

    res.setHeader("Allow", "GET, OPTIONS");

    return output(res, 405, {
      ok: false,
      error: "許可されていない操作です"
    });

  } catch (error) {
    return output(
      res,
      500,
      {
        ok: false,
        error: clean(
          error?.message || "内部サーバーエラー",
          500
        )
      }
    );
  }
};
