
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

const CACHE_EXPIRATION_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;

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

  const host = parsed.hostname.toLowerCase();

  const allowedHosts = [
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "youtu.be",
    "www.youtu.be"
  ];

  if (
    !allowedHosts.includes(host) ||
    !["https:", "http:"].includes(parsed.protocol)
  ) {
    throw new Error("YouTubeのURLを指定してください。");
  }

  const parts = parsed.pathname.split("/").filter(Boolean);

  if (host.includes("youtu.be")) {
    return parts[0] || host;
  }

  if (
    parts[0] === "channel" ||
    parts[0] === "c" ||
    parts[0] === "user"
  ) {
    return parts[1] || parts[0];
  }

  if (parts[0]?.startsWith("@")) {
    return parts[0];
  }

  return parts[0] || host;
}

// ========================================
// Image URL normalization
// ========================================

function normalizeImageUrl(value) {
  if (typeof value !== "string" || !value) {
    return null;
  }

  let url = value
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .trim();

  try {
    const parsed = new URL(url);

    if (
      parsed.protocol !== "https:" &&
      parsed.protocol !== "http:"
    ) {
      return null;
    }

    return parsed.href;
  } catch {
    return null;
  }
}

// ========================================
// Extract image from scraper
// ========================================

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
    if (typeof candidate === "string") {
      const url = normalizeImageUrl(candidate);
      if (url) return url;
    }

    if (candidate && typeof candidate === "object") {
      const url = normalizeImageUrl(
        candidate.url || candidate.src
      );

      if (url) return url;

      if (Array.isArray(candidate)) {
        for (const item of candidate) {
          const itemUrl = normalizeImageUrl(item?.url);
          if (itemUrl) return itemUrl;
        }
      }
    }
  }

  return null;
}

// ========================================
// Extract ytInitialData JSON
// ========================================

function extractInitialData(html) {
  const markers = [
    "var ytInitialData =",
    "ytInitialData =",
    '"ytInitialData":'
  ];

  for (const marker of markers) {
    const markerIndex = html.indexOf(marker);

    if (markerIndex === -1) continue;

    const start = html.indexOf("{", markerIndex);

    if (start === -1) continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < html.length; i++) {
      const char = html[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }

        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth++;
      } else if (char === "}") {
        depth--;

        if (depth === 0) {
          try {
            return JSON.parse(html.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }

  return null;
}

// ========================================
// Search avatar in initial data
// ========================================

function findAvatarInData(data) {
  const candidates = [];

  function walk(node, depth = 0) {
    if (!node || typeof node !== "object" || depth > 40) {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item, depth + 1);
      }
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      if (
        key === "avatar" ||
        key === "avatarViewModel" ||
        key === "profilePicture"
      ) {
        if (value && typeof value === "object") {
          const thumbnails = value.thumbnails;

          if (Array.isArray(thumbnails)) {
            for (const item of thumbnails) {
              const url = normalizeImageUrl(item?.url);
              if (url) candidates.push(url);
            }
          }

          const sources = value.image?.sources;

          if (Array.isArray(sources)) {
            for (const item of sources) {
              const url = normalizeImageUrl(item?.url);
              if (url) candidates.push(url);
            }
          }

          const directUrl = normalizeImageUrl(value.url);

          if (directUrl) {
            candidates.push(directUrl);
          }
        }
      }

      walk(value, depth + 1);
    }
  }

  walk(data);

  // 大きい画像を優先
  return candidates[candidates.length - 1] || null;
}

// ========================================
// Extract og:image
// ========================================

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function getOgImage(html) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of tags) {
    const property =
      tag.match(/\bproperty=["']([^"']+)["']/i)?.[1] ||
      tag.match(/\bname=["']([^"']+)["']/i)?.[1];

    const content =
      tag.match(/\bcontent=["']([^"']+)["']/i)?.[1];

    if (
      property?.toLowerCase() === "og:image" &&
      content
    ) {
      return normalizeImageUrl(decodeHtml(content));
    }
  }

  return null;
}

// ========================================
// Fetch avatar from YouTube page
// ========================================

async function getAvatarFromPage(channelUrl) {
  try {
    const response = await fetch(channelUrl, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ja,en-US;q=0.9,en;q=0.8"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });

    if (!response.ok) {
      console.error(
        "YouTube page response:",
        response.status
      );
      return null;
    }

    const finalUrl = new URL(response.url);

    if (
      ![
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com"
      ].includes(finalUrl.hostname.toLowerCase())
    ) {
      return null;
    }

    const html = await response.text();

    // 1. ytInitialData
    const initialData = extractInitialData(html);

    const initialAvatar = findAvatarInData(initialData);

    if (initialAvatar) {
      console.log("Avatar found in ytInitialData");
      return initialAvatar;
    }

    // 2. og:image
    const ogImage = getOgImage(html);

    if (ogImage) {
      console.log("Avatar found in og:image");
      return ogImage;
    }

    console.log("Avatar not found in YouTube HTML");

    return null;

  } catch (error) {
    console.error(
      "YouTube page avatar error:",
      error.message
    );

    return null;
  }
}

// ========================================
// Cache validation
// ========================================

function isCacheValid(data) {
  if (!data?.updated_at || !data?.avatar_url) {
    return false;
  }

  const updatedAt = new Date(data.updated_at).getTime();

  if (!Number.isFinite(updatedAt)) {
    return false;
  }

  const age = Date.now() - updatedAt;

  return (
    age >= 0 &&
    age < CACHE_EXPIRATION_MS &&
    Boolean(normalizeImageUrl(data.avatar_url))
  );
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

  let cachedData = null;

  try {

    // 1. Supabase cache
    const {
      data,
      error: dbError
    } = await supabase
      .from("youtube_channels")
      .select("*")
      .eq("id", channelKey)
      .maybeSingle();

    cachedData = data;

    if (dbError) {
      console.error(
        "Supabase cache read error:",
        dbError.message
      );
    }

    // 2. 有効なアイコン付きキャッシュ
    if (isCacheValid(cachedData)) {
      console.log("Using database cache:", channelKey);

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

    // 3. YouTube scraper
    console.log("Fetching YouTube channel:", channelKey);

    const scraped = await channel(channelUrl);

    if (!scraped || !scraped.title) {
      throw new Error(
        "YouTubeチャンネル情報を取得できませんでした。"
      );
    }

    // 4. Avatar extraction
    let avatarUrl = getAvatar(scraped);

    // 5. YouTube HTML fallback
    if (!avatarUrl) {
      console.log("Trying YouTube HTML avatar extraction");

      avatarUrl = await getAvatarFromPage(channelUrl);
    }

    // 6. Existing avatar fallback
    if (!avatarUrl && cachedData?.avatar_url) {
      avatarUrl = normalizeImageUrl(
        cachedData.avatar_url
      );

      if (avatarUrl) {
        console.log("Using previous avatar cache");
      }
    }

    // 7. Profile data
    const profileData = {
      channelName:
        scraped.title ||
        cachedData?.channel_name ||
        null,

      subscribers:
        scraped.subscribers ??
        cachedData?.subscribers ??
        null,

      avatarUrl,

      description:
        scraped.description ??
        cachedData?.description ??
        "",

      bannerUrl:
        scraped.banner ??
        cachedData?.banner_url ??
        null,

      isVerified:
        scraped.verified !== undefined
          ? Boolean(scraped.verified)
          : Boolean(cachedData?.is_verified)
    };

    // 8. Supabase save
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

    // 9. Response
    return sendJson(res, 200, {
      status: "success",
      source: "youtube_live",
      data: {
        ...profileData,
        updatedAt
      }
    });

  } catch (error) {

    console.error("YouTube API Error:", error);

    // 10. Database fallback
    if (cachedData?.channel_name) {
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
