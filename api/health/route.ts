import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

// 動作が高速でコストの低い Edge Runtime を使用
export const runtime = 'edge'

// 外部からの不要なアクセスを防ぐためのセキュリティトークン（任意）
// UptimeRobotのURL設定で `?token=xxxx` を付与して使います
const MONITOR_TOKEN = process.env.MONITOR_TOKEN

export async function GET(request: Request) {
  // 1. トークン認証チェック（環境変数が設定されている場合のみ）
  if (MONITOR_TOKEN) {
    const { searchParams } = new URL(request.url)
    const token = searchParams.get('token')
    
    if (token !== MONITOR_TOKEN) {
      return NextResponse.json(
        { status: 'unauthorized', message: 'Invalid token' },
        { status: 401 }
      )
    }
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

    // 4. Supabaseへの疎通確認（1件だけデータが取れるかテスト）
    const { error } = await supabase
      .from('health_check')
      .select('id')
      .limit(1)

    if (error) {
      throw error
    }

    // すべて正常な場合
    return NextResponse.json(
      { 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        services: { vircel: 'up', supabase: 'up' } 
      }, 
      { status: 200 }
    )

  } catch (err: any) {
    // どちらかが落ちている、またはエラーが発生した場合
    console.error('Health check failed:', err)
    
    return NextResponse.json(
      { 
        status: 'error', 
        message: err.message || 'Database connection failed',
        timestamp: new Date().toISOString()
      }, 
      { status: 500 }
    )
  }
}
