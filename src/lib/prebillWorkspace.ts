import { supabase } from './supabase'
import type { PreBillDocument, PreBillDocumentType } from '../types/prebill'

export type PreBillView = 'draft' | 'mine' | 'pending' | 'approved' | 'converted' | 'expired' | 'cancelled'
export const PREBILL_VIEWS: PreBillView[] = ['draft', 'mine', 'pending', 'approved', 'converted', 'expired', 'cancelled']
export const PREBILL_PAGE_SIZE = 25
export type PreBillSummary = Pick<PreBillDocument,
  'id' | 'document_type' | 'document_no' | 'status' | 'channel_code' | 'customer_name' |
  'valid_until' | 'total_amount' | 'converted_order_id' | 'converted_order' | 'owner_name' | 'created_at'>
export type PreBillFilters = {
  documentType: PreBillDocumentType
  dateFrom: string
  dateTo: string
  ownerId: string
  today: string
}

const summaryColumns = 'id,document_type,document_no,status,channel_code,customer_name,valid_until,total_amount,converted_order_id,owner_name,created_at,converted_order:or_orders!converted_order_id(bill_no)'

function baseQuery(filters: PreBillFilters, columns: string, head = false) {
  let query = supabase.from('or_prebill_documents').select(columns, { count: 'exact', head })
    .eq('document_type', filters.documentType)
  if (filters.dateFrom) query = query.gte('created_at', `${filters.dateFrom}T00:00:00+07:00`)
  if (filters.dateTo) query = query.lt('created_at', `${nextDate(filters.dateTo)}T00:00:00+07:00`)
  if (filters.ownerId) query = query.eq('owner_id', filters.ownerId)
  return query
}

function nextDate(date: string) {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + 1)
  return value.toISOString().slice(0, 10)
}

function filterView(query: ReturnType<typeof baseQuery>, view: PreBillView, today: string) {
  if (view === 'converted' || view === 'cancelled') return query.eq('status', view)
  if (view === 'expired') return query.lt('valid_until', today).not('status', 'in', '(converted,cancelled)')
  query = query.gte('valid_until', today)
  if (view === 'mine') return query.in('status', ['draft', 'active', 'rejected'])
  return query.eq('status', view === 'pending' ? 'pending_discount' : view)
}

export async function loadPreBillPage(filters: PreBillFilters, view: PreBillView, page: number, search: string, signal?: AbortSignal) {
  const term = search.trim()
  // Empty embedding filters by product name without downloading product rows.
  let query = filterView(baseQuery(filters, summaryColumns + (term ? ',product_search:or_prebill_items()' : '')), view, filters.today)
  if (term) {
    // A literal, unanchored regex preserves substring search even for %, _ and *.
    const pattern = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const quoted = `"${pattern.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    query = query.filter('product_search.product_name', 'imatch', pattern).or(
      ['document_no', 'customer_name', 'channel_code', 'owner_name'].map(column => `${column}.imatch.${quoted}`).concat('product_search.not.is.null').join(','),
    )
  }
  const offset = Math.max(0, page - 1) * PREBILL_PAGE_SIZE
  if (signal) query = query.abortSignal(signal)
  const { data, count, error } = await query.order('created_at', { ascending: false }).order('id', { ascending: false })
    .range(offset, offset + PREBILL_PAGE_SIZE - 1)
  if (error) throw error
  return { documents: (data || []) as unknown as PreBillSummary[], total: count || 0 }
}

export async function loadPreBillCounts(filters: PreBillFilters, signal?: AbortSignal) {
  const entries = await Promise.all(PREBILL_VIEWS.map(async view => {
    let query = filterView(baseQuery(filters, 'id', true), view, filters.today)
    if (signal) query = query.abortSignal(signal)
    const { count, error } = await query
    if (error) throw error
    return [view, count || 0] as const
  }))
  return Object.fromEntries(entries) as Record<PreBillView, number>
}

export async function loadPreBillDetail(id: string): Promise<PreBillDocument> {
  const { data, error } = await supabase.from('or_prebill_documents').select('*,or_prebill_items(*)').eq('id', id).single()
  if (error) throw error
  const document = data as PreBillDocument
  return { ...document, or_prebill_items: [...(document.or_prebill_items || [])].sort((a, b) => a.sort_order - b.sort_order) }
}
