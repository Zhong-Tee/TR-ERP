import { createClient } from '@supabase/supabase-js'
import { routePurchaseRead } from './purchaseReadRouting'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || ''
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || ''

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('❌ Missing Supabase environment variables!')
  console.error('VITE_SUPABASE_URL:', supabaseUrl ? '✅ Set' : '❌ Missing')
  console.error('VITE_SUPABASE_ANON_KEY:', supabaseAnonKey ? '✅ Set' : '❌ Missing')
  console.error('Please check your .env file in tr-erp/.env')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  global: {
    fetch: (input, init) => {
      const source = input instanceof Request ? input.url : String(input)
      const method = init?.method || (input instanceof Request ? input.method : 'GET')
      const routed = routePurchaseRead(source, method)
      return fetch(input instanceof Request ? new Request(routed, input) : routed, init)
    },
  },
})

// Test connection
if (supabaseUrl && supabaseAnonKey) {
  console.log('✅ Supabase client initialized')
  console.log('URL:', supabaseUrl.substring(0, 30) + '...')
} else {
  console.error('❌ Supabase client NOT initialized - check .env file')
}
