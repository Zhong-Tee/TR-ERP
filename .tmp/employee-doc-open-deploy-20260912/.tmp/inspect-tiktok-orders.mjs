import fs from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'

const envText = await fs.readFile('.env', 'utf8')
const env = Object.fromEntries(
  envText.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).map((line) => {
    const at = line.indexOf('=')
    return [line.slice(0, at).trim(), line.slice(at + 1).trim()]
  }),
)
const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)
const orderNos = [
  '585303176132658586',
  '585303376272852186',
  '585299528949007629',
  '585299596643829714',
]

const { data, error } = await supabase
  .from('mp_orders')
  .select('id, marketplace_order_no, channel_code, config_id, payment_time, ship_due_at, overdue_at, raw_snapshot')
  .in('marketplace_order_no', orderNos)

if (error) throw error
console.log(JSON.stringify(data, null, 2))
