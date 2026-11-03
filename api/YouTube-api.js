const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { channel } = require('@vreden/youtube_scraper');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// 環境変数からSupabase接続情報を取得
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("エラー: 環境変数 SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を設定してください。");
  process.exit(1);
}

// サービスロールキー（管理権限）を使用してクライアントを初期化
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// キャッシュの有効期限 (24時間)
const CACHE_EXPIRATION_MS = 24 * 60 * 60 * 1000;

/**
 * チャンネルプロフィール取得・キャッシュAPI
 * GET /api/channel?url=https://youtube.com
 */
app.get('/api/channel', async (req, res) => {
  const channelUrl = req.query.url;

  if (!channelUrl) {
    return res.status(400).json({
      status: 'error',
      message: 'クエリパラメータ "url" を指定してください。'
    });
  }

  // URLから一意の識別子を抽出 (例: @Google)
  const channelKey = channelUrl.split('/').pop() || channelUrl;

  try {
    // 1. Supabaseからキャッシュデータを検索
    const { data: cachedData, error: dbError } = await supabase
      .from('youtube_channels')
      .select('*')
      .eq('id', channelKey)
      .single();

    const now = new Date();

    // キャッシュが存在し、かつ24時間以内であればDBのデータを返却
    if (cachedData && (now - new Date(cachedData.updated_at) < CACHE_EXPIRATION_MS)) {
      return res.json({
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

    // 2. キャッシュがない、または期限切れの場合は新しくスクレイピングを実行
    console.log(`YouTubeから最新のプロフィールを取得中: ${channelKey}`);
    const scraped = await channel(channelUrl);

    const profileData = {
      channelName: scraped.title,
      subscribers: scraped.subscribers,
      avatarUrl: scraped.avatar,
      description: scraped.description,
      bannerUrl: scraped.banner || null,
      isVerified: scraped.verified || false
    };

    // 3. サービスロールキー権限でデータをデータベースに永続化 (Upsert)
    const { error: upsertError } = await supabase
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

    if (upsertError) {
      console.error('Supabaseへの保存失敗（サービスロールキー使用）:', upsertError);
    }

    return res.json({
      status: 'success',
      source: 'youtube_live',
      data: profileData
    });

  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({
      status: 'error',
      message: 'データの取得または処理に失敗しました。',
      error: error.message
    });
  }
});

// サーバー起動
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
