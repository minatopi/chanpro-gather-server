
const { createClient } = require("@supabase/supabase-js");
const { channel } = require("@vreden/youtube_scraper");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

function sendJson(res, status, data) {
  return res.status(status).json(data);
}


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

  if (!allowedHosts.includes(host)) {
    throw new Error("YouTubeのURLを指定してください。");
  }

  const parts = parsed.pathname.split("/").filter(Boolean);

  if (host.includes("youtu.be")) {
    return parts[0] || host;
  }

  if (parts[0] === "channel" || parts[0] === "c" || parts[0] === "user") {
    return parts[1] || parts[0];
  }

  if (parts[0] && parts[0].startsWith("@")) {
    return parts[0];
  }

  return parts[0] || host;
}


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
    // 1. Supabaseからキャッシュを取得
    const { data: cachedData, error: dbError } = await supabase
      .from("youtube_channels")
      .select("*")
      .eq("id", channelKey)
      .maybeSingle();

    if (dbError) {
      console.error("Supabase cache read error:", dbError.message);
    }

    // 2. 24時間以内のキャッシュがあれば返す
    if (cachedData && cachedData.updated_at) {
      const updatedAt = new Date(cachedData.updated_at).getTime();

      if (
        Number.isFinite(updatedAt) &&
        Date.now() - updatedAt < CACHE_EXPIRATION_MS
      ) {
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
    }

    // 3. キャッシュがなければYouTubeから取得
    console.log("Fetching YouTube channel:", channelKey);

    const scraped = await channel(channelUrl);

    if (!scraped || !scraped.title) {
      throw new Error("YouTubeチャンネル情報を取得できませんでした。");
    }

    const profileData = {
      channelName: scraped.title,
      subscribers: scraped.subscribers ?? null,
      avatarUrl: scraped.avatar ?? null,
      description: scraped.description ?? "",
      bannerUrl: scraped.banner ?? null,
      isVerified: Boolean(scraped.verified)
    };

    // 4. Supabaseに保存
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
        { onConflict: "id" }
      );

    if (upsertError) {
      console.error("Supabase save error:", upsertError.message);
    }

    // 5. 結果を返す
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

    return sendJson(res, 500, {
      status: "error",
      message: "YouTubeチャンネル情報の取得または処理に失敗しました。"
    });
  }
};
