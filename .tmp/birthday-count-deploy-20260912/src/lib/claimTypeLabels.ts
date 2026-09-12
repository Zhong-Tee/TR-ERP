import { supabase } from './supabase'

let cache: Record<string, string> | null = null

/** แผนที่ code → ชื่อภาษาไทยจากตาราง claim_type (แคชหนึ่งครั้งต่อเซสชัน) */
export async function fetchClaimTypeLabelMap(): Promise<Record<string, string>> {
  if (cache) return { ...cache }
  const { data, error } = await supabase
    .from('claim_type')
    .select('code, name')
    .order('sort_order', { ascending: true })
  if (error) {
    console.error('claim_type:', error)
    return {}
  }
  cache = Object.fromEntries((data || []).map((r: { code: string; name: string }) => [r.code, r.name]))
  return { ...cache }
}

export function claimTypeLabel(map: Record<string, string>, code: string | null | undefined): string {
  const c = (code ?? '').trim()
  if (!c) return '–'
  return map[c] ?? c
}
