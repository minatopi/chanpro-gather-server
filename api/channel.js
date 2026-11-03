
const { createClient } = require("@supabase/supabase-js");
const { channel } = require("@vreden/youtube_scraper");

// ========================================
// Environment
// ========================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY,
        {
          auth: {
            persistSession: false,
            autoRefreshToken: false
          }
        }
      )
    : null;

// 24時間キャッシュ
const CACHE_EXPIRATION_MS = 24 * 60 * 60 * 1000;

// ========================================
// Response
// ========================================

function sendJson(res, status, data) {
  return res.status(status).json(data);
}

// ========================================
// URL validation
// ========================================

function getChannelKey(channelUrl) {
  const parsed = new URL(channelUrl);

  const allowedHosts = [
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com"
  ];

  if (!allowedHosts.includes(parsed.hostname.toLowerCase())) {
    throw new Error("YouTubeのチャンネルURLを指定してください。");
  }

  const parts = parsed.pathname.split("/").filter(Boolean);

  if (
    parts[0] === "channel" ||
    parts[0] === "c" ||
    parts[0] === "user"
  ) {
    return parts[1] || parts[0];
  }

  if (parts[0] && parts[0].startsWith("@")) {
    return parts[0];
  }

  throw new Error("チャンネルURLを正しく指定してください。");
}

// ========================================
// Image URL extraction
// ========================================

function normalizeImageUrl(value) {
  if (!value) return null;

  if (typeof value === "string") {
    try {
      const url = new URL(value);

      if (
        url.protocol === "https:" ||
        url.protocol === "http:"
      ) {
        return url.href;
      }
    } catch {
      return null;
    }

    return null;
  }

  if (typeof value === "object") {
    const candidates = [
      value.url,
      value.src,
      value.href,
      value[0]?.url
    ];

    for (const candidate of candidates) {
      const result = normalizeImageUrl(candidate);

      if (result) return result;
    }
  }

  return null;
}

function getAvatar(scraped) {
  if (!scraped) return null;

  const candidates = [
    scraped.avatar,
    scraped.avatarUrl,
    scraped.thumbnail,
    scraped.profilePicture,
    scraped.profilePictureUrl,
    scraped.thumbnails?.high,
    scraped.thumbnails?.medium,
    scraped.thumbnails?.default
  ];

  for (const candidate of candidates) {
    const url = normalizeImageUrl(candidate);

    if (url) return url;
  }

  return null;
}

function getBanner(scraped) {
  if (!scraped) return null;

  const candidates = [
    scraped.banner,
    scraped.bannerUrl,
    scraped.bannerImage,
    scraped.bannerExternalUrl,
    scraped.banners?.[0]
  ];

  for (const candidate of candidates) {
    const url = normalizeImageUrl(candidate);

    if (url) return url;
  }

  return null;
}

// ========================================
// Cache validation
// ========================================

function isCacheValid(data) {
  if (!data || !data.updated_at) {
    return false;
  }

  const updatedAt = new Date(data.updated_at).getTime();

  if (!Number.isFinite(updatedAt)) {
    return false;
  }

  const age = Date.now() - updatedAt;

  // 未来日時の異常データも無効
  if (age < 0 || age >= CACHE_EXPIRATION_MS) {
    return false;
  }

  // アイコンがないキャッシュは使用しない
  if (!normalizeImageUrl(data.avatar_url)) {
    return false;
  }

  return true;
}

// ========================================
// Main API
// ========================================

module.exports = async function handler(req, res) {

  // CORS
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

  // OPTIONS
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // GET only
  if (req.method !== "GET") {
    return sendJson(res, 405, {
      status: "error",
      message: "GETリクエストのみ対応しています。"
    });
  }

  // Supabase
  if (!supabase) {
    return sendJson(res, 503, {
      status: "error",
      message: "Supabaseの環境変数が設定されていません。"
    });
  }

  // Channel URL
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
    // 1. Supabase cache
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
    // 2. Valid cache
    // ====================================

    if (isCacheValid(cachedData)) {

      console.log(
        "Using database cache:",
        channelKey
      );

      return sendJson(res, 200, {
        status: "success",
        source: "database_cache",
        data: {
          channelName: cachedData.channel_name,
          subscribers: cachedData.subscribers,
          avatarUrl: cachedData.avatar_url,
          description: cachedData.description,
          bannerUrl: cachedData.banner_url,
          isVerified: cachedData.is_verified,
          updatedAt: cachedData.updated_at
        }
      });
    }

    // ====================================
    // 3. Fetch YouTube
    // ====================================

    console.log(
      "Fetching YouTube channel:",
      channelKey
    );

    const scraped = await channel(channelUrl);

    if (!scraped || !scraped.title) {
      throw new Error(
        "YouTubeチャンネル情報を取得できませんでした。"
      );
    }

    // ====================================
    // 4. Get images
    // ====================================

    let avatarUrl = getAvatar(scraped);

    let bannerUrl = getBanner(scraped);

    // 新しい画像が取得できなかった場合、
    // 既存の正常な画像を保持する
    if (!avatarUrl && cachedData?.avatar_url) {
      avatarUrl = normalizeImageUrl(
        cachedData.avatar_url
      );

      console.log("Using previous avatar cache");
    }

    if (!bannerUrl && cachedData?.banner_url) {
      bannerUrl = normalizeImageUrl(
        cachedData.banner_url
      );
    }

    // ====================================
    // 5. Profile data
    // ====================================

    const profileData = {
      channelName: scraped.title,

      subscribers:
        scraped.subscribers ??
        cachedData?.subscribers ??
        null,

      avatarUrl,

      description:
        scraped.description ??
        cachedData?.description ??
        "",

      bannerUrl,

      isVerified:
        Boolean(scraped.verified) ||
        Boolean(cachedData?.is_verified)
    };

    // ====================================
    // 6. Save Supabase
    // ====================================

    const updatedAt = new Date().toISOString();

    const {
      error: upsertError
    } = await supabase
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
    // 7. Response
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

    // ==================================
    // 8. Fallback cache
    // ==================================

    // YouTube取得失敗時でも既存データがあれば返す
    if (cachedData && cachedData.channel_name) {

      return sendJson(res, 200, {
        status: "success",

        source: "database_fallback",

        data: {
          channelName: cachedData.channel_name,
          subscribers: cachedData.subscribers,
          avatarUrl: cachedData.avatar_url,
          description: cachedData.description,
          bannerUrl: cachedData.banner_url,
          isVerified: cachedData.is_verified,
          updatedAt: cachedData.updated_at
        }
      });
    }

    return sendJson(res, 500, {
      status: "error",

      message:
        "YouTubeチャンネル情報の取得または処理に失敗しました。"
    });
  }
};
