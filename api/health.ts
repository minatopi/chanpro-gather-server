import { createClient } from '@supabase/supabase-js'

export default async function handler(req: any, res: any) {
  const token = req.query.token
  if (!process.env.MONITOR_TOKEN || token !== process.env.MONITOR_TOKEN) {
    return res.status(401).json({ status: 'unauthorized' })
  }
  try {
    const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!)
    const { error } = await supabase.from('health_check').select('id').limit(1)
    if (error) throw error
    return res.status(200).json({ status: 'ok', database: 'supabase' })
  } catch (err: any) {
    return res.status(500).json({ status: 'error', message: err.message })
  }
}
