import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

export const runtime = 'edge'

// 外部からの不正アクセスを防ぐための合言葉（あなたが決めるパスワード）
const MONITOR_TOKEN = process.env.MONITOR_TOKEN

export async function GET(request: Request) {
  // 1. 合言葉（MONITOR_TOKEN）のチェック
  const { searchParams } = new URL(request.url)
  const token = searchParams.get('token')
  
  if (!MONITOR_TOKEN || token !== MONITOR_TOKEN) {
    return NextResponse.json(
      { status: 'unauthorized', message: 'Invalid or missing token' },
      { status: 401 }
    )
  }

  try {
    // 2. 環境変数の存在チェック
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
      throw new Error('Missing Supabase environment variables')
    }

    // 3. Supabase クライアントの初期化
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    )

    // 4. 先ほど作った「health_check」テーブルから1件取得テスト
    const { error } = await supabase
      .from('health_check')
      .select('id')
      .limit(1)

    if (error) throw error

    // 正常な場合
    return NextResponse.json(
      { 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        services: { vercel: 'up', supabase: 'up' } 
      }, 
      { status: 200 }
    )

  } catch (err: any) {
    console.error('Supabase Health check failed:', err)
    return NextResponse.json(
      { 
        status: 'error', 
        message: err.message || 'Database connection failed'
      }, 
      { status: 500 }
    )
  }
}
