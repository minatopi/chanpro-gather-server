import { createClient } from '@supabase/supabase-js'
import type { VercelRequest, VercelResponse } from '@vercel/node'

// 外部からの不正アクセスを防ぐための合言葉
const MONITOR_TOKEN = process.env.MONITOR_TOKEN

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // 1. HTTPメソッドがGETであることを確認
  if (req.method !== 'GET') {
    return res.status(405).json({ status: 'error', message: 'Method Not Allowed' })
  }

  // 2. 合言葉（MONITOR_TOKEN）のチェック
  const token = req.query.token

  if (!MONITOR_TOKEN || token !== MONITOR_TOKEN) {
    return res.status(401).json({ status: 'unauthorized', message: 'Invalid or missing token' })
  }

  try {
    // 3. 環境変数の存在チェック
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
      throw new Error('Missing Supabase environment variables')
    }

    // 4. Supabase クライアントの初期化
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    )

    // 5. 「health_check」テーブルから1件取得テスト
    const { error } = await supabase
      .from('health_check')
      .select('id')
      .limit(1)

    if (error) throw error

    // すべて正常な場合
    return res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      services: { vercel: 'up', supabase: 'up' }
    })

  } catch (err: any) {
    console.error('Supabase Health check failed:', err)
    return res.status(500).json({
      status: 'error',
      message: err.message || 'Database connection failed'
    })
  }
}
