
const { createClient } = require('@supabase/supabase-js');
const youtube = require('@vreden/youtube_scraper');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;

if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
}

const CACHE_EXPIRATION_MS = 24 * 60 * 60 * 1000;

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'GET') {
    return res.status(405).json({
      status: 'error',
      message: 'GET only'
    });
  }

  try {
    // 環境変数チェック
    if (!supabase) {
      return res.status(500).json({
        status: 'error',
        message: 'Supabase environment variables are missing'
      });
    }

    const channelUrl = req.query.url;

    if (!channelUrl || typeof channelUrl !== 'string') {
      return res.status(400).json({
        status: 'error',
        message: 'url parameter is required'
      });
    }

    let parsedUrl;

    try {
      parsedUrl = new URL(channelUrl);
    } catch {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid YouTube URL'
      });
    }

    if (
      !['youtube.com', 'www.youtube.com', 'm.youtube.com',
        'youtu.be'].includes(parsedUrl.hostname)
    ) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid YouTube domain'
      });
    }

    const channelKey = parsedUrl.pathname
      .split('/')
      .filter(Boolean)
      .pop();

    if (!channelKey) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid channel URL'
      });
    }

    // キャッシュ検索
    const { data: cachedData, error: cacheError } =
      await supabase
        .from('youtube_channels')
        .select('*')
        .eq('id', channelKey)
        .maybeSingle();

    if (cacheError) {
      console.error('Supabase cache error:', cacheError);
    }

    if (
      cachedData &&
      Date.now() - new Date(cachedData.updated_at).getTime()
        < CACHE_EXPIRATION_MS
    ) {
      return res.status(200).json({
        status: 'success',
        source: 'database_cache',
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

    // YouTube情報取得
    if (typeof youtube.channel !== 'function') {
      throw new Error(
        'youtube.channel is not available in installed package'
      );
    }

    const scraped = await youtube.channel(channelUrl);

    if (!scraped || !scraped.title) {
      throw new Error('YouTube channel data is empty');
    }

    const profileData = {
      channelName: scraped.title,
      subscribers: scraped.subscribers ?? null,
      avatarUrl: scraped.avatar ?? null,
      description: scraped.description ?? null,
      bannerUrl: scraped.banner ?? null,
      isVerified: scraped.verified ?? false
    };

    // Supabase保存
    const { error: saveError } = await supabase
      .from('youtube_channels')
      .upsert({
        id: channelKey,
        channel_name: profileData.channelName,
        subscribers: profileData.subscribers,
        avatar_url: profileData.avatarUrl,
        description: profileData.description,
        banner_url: profileData.bannerUrl,
        is_verified: profileData.isVerified,
        updated_at: new Date().toISOString()
      });

    if (saveError) {
      console.error('Supabase save error:', saveError);
    }

    return res.status(200).json({
      status: 'success',
      source: 'youtube_live',
      data: profileData
    });

  } catch (error) {
    console.error('YouTube API Error:', error);

    return res.status(500).json({
      status: 'error',
      message: error.message || 'Internal Server Error'
    });
  }
};
