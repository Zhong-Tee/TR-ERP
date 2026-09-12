import type { SupabaseClient } from '@supabase/supabase-js'

export type SalesTrUserRow = { username?: string | null; email?: string | null }

/** ค่าที่อาจถูกเก็บใน or_orders.admin_user สำหรับผู้ใช้ role sales-tr */
export function flattenSalesTrAdminIdentifiers(rows: SalesTrUserRow[]): string[] {
  const s = new Set<string>()
  for (const r of rows) {
    const u = r.username?.trim()
    const e = r.email?.trim()
    if (u) s.add(u)
    if (e) s.add(e)
  }
  return [...s]
}

export async function fetchSalesTrTeamAdminValues(client: SupabaseClient): Promise<string[]> {
  const { data, error } = await client.from('us_users').select('username, email').eq('role', 'sales-tr')
  if (error) throw error
  return flattenSalesTrAdminIdentifiers(data || [])
}

export async function fetchSalesTrTeamRows(client: SupabaseClient): Promise<SalesTrUserRow[]> {
  const { data, error } = await client
    .from('us_users')
    .select('username, email')
    .eq('role', 'sales-tr')
    .order('username', { ascending: true })
  if (error) throw error
  return data || []
}
