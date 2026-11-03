
const { createClient } = require("@supabase/supabase-js");
const { channel } = require("@vreden/youtube_scraper");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      })
    : null;

const CACHE_EXPIRATION_MS = 24 * 60 * 60 * 1000;

const ALLOWED_HOSTS = [
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "www.youtu.be"
];

function sendJson(res, status, data) {
  return res.status(status).json(data);
}

// ========================================
// チャンネルURL検証
// ========================================

function getChannelKey(channelUrl) {
  const parsed = new URL(channelUrl);

  const host = parsed.hostname.toLowerCase();

  if (
    parsed.protocol !== "https:" ||
    !ALLOWED_HOSTS.includes(host) ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("有効なYouTubeのHTTPS URLを指定してください。");
  }

  const parts = parsed.pathname.split("/").filter(Boolean);

  if (host.includes("youtu.be")) {
    return parts[0] || host;
  }

  if (
    ["channel", "c", "user"].includes(parts[0])
  ) {
    return parts[1] || parts[0];
  }

  if (parts[0] && parts[0].startsWith("@")) {
    return parts[0];
  }

  return parts[0] || host;
}

// ========================================
// 登録者数を数値に変換
// ========================================

function parseSubscriberCount(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0
      ? Math.round(value)
      : null;
  }

  if (typeof value === "object") {
    value =
      value.simpleText ||
      value.text ||
      value.label ||
      value.accessibility?.accessibilityData?.label;

    if (!value) return null;
  }

  const text = String(value)
    .replace(/,/g, "")
    .replace(/\s/g, "")
    .replace(/&nbsp;/g, "");

  if (!text) return null;

  // 数値のみ
  if (/^\d+$/.test(text)) {
    return Number(text);
  }

  // 日本語: 万・億
  const japanese = text.match(
    /([\d.]+)(億|万)/
  );

  if (japanese) {
    const number = Number(japanese[1]);

    const multiplier =
      japanese[2] === "億"
        ? 100000000
        : 10000;

    return Number.isFinite(number)
      ? Math.round(number * multiplier)
      : null;
  }

  // 英語: K / M / B
  const english = text.match(
    /([\d.]+)([KMB])/i
  );

  if (english) {
    const number = Number(english[1]);

    const multipliers = {
      K: 1000,
      M: 1000000,
      B: 1000000000
    };

    return Number.isFinite(number)
      ? Math.round(
          number * multipliers[english[2].toUpperCase()]
        )
      : null;
  }

  // 数字と登録者数表記
  const plain = text.match(/(\d+)/);

  if (
    plain &&
    /subscriber|登録者|subscribers/i.test(text)
  ) {
    return Number(plain[1]);
  }

  return null;
}

// ========================================
// HTML内の登録者数を抽出
// ========================================

function extractSubscribersFromHTML(html) {
  if (!html) return null;

  const candidates = [];

  // 1. subscriberCountText
  const patterns = [
    /"subscriberCountText"\s*:\s*(\{[\s\S]{0,1500}?\})/g,
    /"subscriberCountText"\s*:\s*"([^"]+)"/g
  ];

  for (const pattern of patterns) {
    let match;

    while ((match = pattern.exec(html)) !== null) {
      candidates.push(match[1]);
    }
  }

  // 2. subscriberCountText周辺のsimpleText
  const subscriberIndexes = [];
  const keyPattern = /subscriberCountText/g;

  let keyMatch;

  while ((keyMatch = keyPattern.exec(html)) !== null) {
    subscriberIndexes.push(keyMatch.index);
  }

  for (const index of subscriberIndexes) {
    const section = html.slice(
      index,
      index + 1500
    );

    const simpleText = section.match(
      /"simpleText"\s*:\s*"((?:\\.|[^"\\])*)"/
    );

    if (simpleText) {
      try {
        candidates.push(
          JSON.parse(`"${simpleText[1]}"`)
        );
      } catch {
        candidates.push(simpleText[1]);
      }
    }

    const accessibility = section.match(
      /"label"\s*:\s*"((?:\\.|[^"\\])*)"/
    );

    if (accessibility) {
      try {
        candidates.push(
          JSON.parse(`"${accessibility[1]}"`)
        );
      } catch {
        candidates.push(accessibility[1]);
      }
    }
  }

  // 3. 登録者数に関するHTMLの表示文字列
  const textPatterns = [
    /([\d,.]+\s*(?:億|万|[KMB])?)\s*人の登録者/g,
    /([\d,.]+\s*(?:億|万|[KMB])?)\s*subscribers/gi,
    /([\d,.]+\s*(?:億|万|[KMB])?)\s*登録者/g
  ];

  for (const pattern of textPatterns) {
    let match;

    while ((match = pattern.exec(html)) !== null) {
      candidates.push(match[1]);
    }
  }

  // 4. JSON形式の候補から数値を取得
  for (const candidate of candidates) {
    const count = parseSubscriberCount(candidate);

    if (count !== null) {
      return count;
    }

    // JSONオブジェクト文字列の場合
    if (
      typeof candidate === "string" &&
      candidate.startsWith("{")
    ) {
      try {
        const obj = JSON.parse(candidate);

        const nestedCount = parseSubscriberCount(
          obj.simpleText ||
          obj.accessibility?.accessibilityData?.label ||
          obj.runs?.[0]?.text
        );

        if (nestedCount !== null) {
          return nestedCount;
        }
      } catch {
        // 次の候補を試す
      }
    }
  }

  return null;
}

// ========================================
// YouTube HTMLを安全に取得
// ========================================

async function fetchYouTubeHTML(channelUrl) {
  let currentUrl = new URL(channelUrl);

  for (let i = 0; i < 5; i++) {
    if (
      currentUrl.protocol !== "https:" ||
      !ALLOWED_HOSTS.includes(
        currentUrl.hostname.toLowerCase()
      )
    ) {
      throw new Error("YouTube以外へのリダイレクトを拒否しました。");
    }

    const response = await fetch(currentUrl.toString(), {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/131.0.0.0 Safari/537.36",
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ja,en-US;q=0.9,en;q=0.8"
      }
    });

    if (
      [301, 302, 303, 307, 308].includes(response.status)
    ) {
      const location = response.headers.get("location");

      if (!location) {
        throw new Error("YouTubeのリダイレクト先がありません。");
      }

      currentUrl = new URL(location, currentUrl);
      continue;
    }

    if (!response.ok) {
      throw new Error(
        `YouTube HTML取得失敗: ${response.status}`
      );
    }

    return await response.text();
  }

  throw new Error("リダイレクト回数の上限を超えました。");
}

// ========================================
// スクレイパーの登録者数を取得
// ========================================

function getScrapedSubscribers(scraped) {
  if (!scraped) return null;

  const candidates = [
    scraped.subscribers,
    scraped.subscriberCount,
    scraped.subscriber_count,
    scraped.subscribersCount,
    scraped.subscriberCountText,
    scraped.subscribersText,
    scraped.followers
  ];

  for (const candidate of candidates) {
    const count = parseSubscriberCount(candidate);

    if (count !== null) {
      return count;
    }
  }

  return null;
}

// ========================================
// メインAPI
// ========================================

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, apikey, x-client-info"
  );

  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return sendJson(res, 405, {
      status: "error",
      message: "GETリクエストのみ対応しています。"
    });
  }

  if (!supabase) {
    return sendJson(res, 503, {
      status: "error",
      message: "Supabaseの環境変数が設定されていません。"
    });
  }

  const channelUrl = String(req.query.url || "").trim();

  if (!channelUrl || channelUrl.length > 2048) {
    return sendJson(res, 400, {
      status: "error",
      message: 'クエリパラメータ "url" を指定してください。'
    });
  }

  let channelKey;

  try {
    channelKey = getChannelKey(channelUrl);
  } catch (error) {
    return sendJson(res, 400, {
      status: "error",
      message: error.message
    });
  }

  try {
    // ====================================
    // 1. Supabaseキャッシュ取得
    // ====================================

    const {
      data: cachedData,
      error: dbError
    } = await supabase
      .from("youtube_channels")
      .select("*")
      .eq("id", channelKey)
      .maybeSingle();

    if (dbError) {
      console.error(
        "Supabase cache read error:",
        dbError.message
      );
    }

    // ====================================
    // 2. キャッシュ判定
    // ====================================

    if (cachedData && cachedData.updated_at) {
      const updatedAt = new Date(
        cachedData.updated_at
      ).getTime();

      const cachedSubscribers = parseSubscriberCount(
        cachedData.subscribers
      );

      if (
        Number.isFinite(updatedAt) &&
        Date.now() - updatedAt < CACHE_EXPIRATION_MS &&
        cachedSubscribers !== null
      ) {
        return sendJson(res, 200, {
          status: "success",
          source: "database_cache",
          data: {
            channelName: cachedData.channel_name,
            subscribers: cachedSubscribers,
            avatarUrl: cachedData.avatar_url,
            description: cachedData.description,
            bannerUrl: cachedData.banner_url,
            isVerified: cachedData.is_verified,
            updatedAt: cachedData.updated_at
          }
        });
      }

      console.log(
        "Cache expired or subscriber count missing. Refetching:",
        channelKey
      );
    }

    // ====================================
    // 3. YouTubeスクレイパー
    // ====================================

    console.log(
      "Fetching YouTube channel:",
      channelKey
    );

    let scraped = null;

    try {
      scraped = await channel(channelUrl);
    } catch (error) {
      console.error(
        "youtube_scraper error:",
        error.message
      );
    }

    // ====================================
    // 4. 登録者数を複数の方法で取得
    // ====================================

    let subscribers = getScrapedSubscribers(scraped);

    let html = null;

    // スクレイパーから取れない場合はHTMLを取得
    if (subscribers === null) {
      try {
        console.log(
          "Subscriber count missing. Fetching YouTube HTML:",
          channelKey
        );

        html = await fetchYouTubeHTML(channelUrl);

        subscribers = extractSubscribersFromHTML(html);

      } catch (error) {
        console.error(
          "HTML subscriber scraping error:",
          error.message
        );
      }
    }

    // ====================================
    // 5. チャンネル情報の確認
    // ====================================

    if (!scraped && !html) {
      throw new Error(
        "YouTubeチャンネル情報を取得できませんでした。"
      );
    }

    // HTML取得だけ成功した場合も処理
    const profileData = {
      channelName:
        scraped?.title ||
        scraped?.name ||
        cachedData?.channel_name ||
        null,

      subscribers,

      avatarUrl:
        scraped?.avatar ||
        scraped?.thumbnail ||
        cachedData?.avatar_url ||
        null,

      description:
        scraped?.description ||
        cachedData?.description ||
        "",

      bannerUrl:
        scraped?.banner ||
        cachedData?.banner_url ||
        null,

      isVerified:
        scraped?.verified !== undefined
          ? Boolean(scraped.verified)
          : Boolean(cachedData?.is_verified)
    };

    // HTMLからもチャンネル名を補完
    if (!profileData.channelName && html) {
      const titleMatch = html.match(
        /"channelMetadataRenderer"[\s\S]{0,3000}?"title"\s*:\s*"((?:\\.|[^"\\])*)"/
      );

      if (titleMatch) {
        try {
          profileData.channelName = JSON.parse(
            `"${titleMatch[1]}"`
          );
        } catch {
          profileData.channelName = null;
        }
      }
    }

    if (!profileData.channelName) {
      throw new Error(
        "チャンネル名を取得できませんでした。"
      );
    }

    // ====================================
    // 6. Supabaseに保存
    // ====================================

    const updatedAt = new Date().toISOString();

    const { error: upsertError } = await supabase
      .from("youtube_channels")
      .upsert(
        {
          id: channelKey,
          channel_name: profileData.channelName,
          subscribers: profileData.subscribers,
          avatar_url: profileData.avatarUrl,
          description: profileData.description,
          banner_url: profileData.bannerUrl,
          is_verified: profileData.isVerified,
          updated_at: updatedAt
        },
        {
          onConflict: "id"
        }
      );

    if (upsertError) {
      console.error(
        "Supabase save error:",
        upsertError.message
      );
    }

    // ====================================
    // 7. APIレスポンス
    // ====================================

    return sendJson(res, 200, {
      status: "success",
      source: "youtube_live",
      data: {
        ...profileData,
        updatedAt
      }
    });

  } catch (error) {
    console.error(
      "YouTube API Error:",
      error
    );

    return sendJson(res, 500, {
      status: "error",
      message:
        "YouTubeチャンネル情報の取得または処理に失敗しました。"
    });
  }
};
