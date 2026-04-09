import type { SupabaseClient } from '@supabase/supabase-js'
import type { ClaimCompareDetail, OrderItemRow, RefOrderDetail } from '../components/claim/claimCompareShared'
import { rowToRefEmbed } from '../components/claim/claimCompareShared'

export async function fetchLatestPriorReqBillNo(
  supabase: SupabaseClient,
  refOrderId: string,
  excludeClaimRequestId?: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('or_claim_requests')
    .select('id, created_claim_order_id, reviewed_at')
    .eq('status', 'approved')
    .eq('ref_order_id', refOrderId)
    .not('created_claim_order_id', 'is', null)
    .order('reviewed_at', { ascending: false })
  if (error) {
    console.warn('fetchLatestPriorReqBillNo', error)
    return null
  }
  const rows = (data || []).filter(
    (r) => !excludeClaimRequestId || String((r as { id: string }).id) !== excludeClaimRequestId,
  )
  const first = rows[0] as { created_claim_order_id?: string } | undefined
  const cid = first?.created_claim_order_id
  if (!cid) return null
  const { data: ord, error: oErr } = await supabase
    .from('or_orders')
    .select('bill_no')
    .eq('id', cid)
    .maybeSingle()
  if (oErr || !ord) return null
  const bn = String((ord as { bill_no?: string }).bill_no || '').trim()
  return bn || null
}

async function resolvePackingVideoUrl(
  supabase: SupabaseClient,
  orderId: string,
  trackingNumber: string | null | undefined,
): Promise<string | null> {
  try {
    const { data: vrows, error: vErr } = await supabase
      .from('pk_packing_videos')
      .select('order_id, tracking_number, gdrive_url, created_at')
      .in('order_id', [orderId])
      .not('gdrive_url', 'is', null)
      .order('created_at', { ascending: false })
    if (vErr) throw vErr
    const byOrder = (vrows || []).find((vr) => vr.order_id && String(vr.order_id) === orderId)
    if (byOrder?.gdrive_url) return String(byOrder.gdrive_url)
    const tn = (trackingNumber || '').trim()
    if (tn) {
      const { data: byTn } = await supabase
        .from('pk_packing_videos')
        .select('gdrive_url, created_at')
        .eq('tracking_number', tn)
        .not('gdrive_url', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
      const u = byTn?.[0]?.gdrive_url
      if (u) return String(u)
    }
  } catch {
    /* ignore */
  }
  return null
}

export async function fetchRefOrderDetailWithItems(
  supabase: SupabaseClient,
  refOrderId: string,
): Promise<RefOrderDetail | null> {
  const { data: o, error } = await supabase
    .from('or_orders')
    .select(
      'bill_no, price, total_amount, shipping_cost, discount, customer_name, customer_address, channel_code, admin_user, billing_details, tracking_number',
    )
    .eq('id', refOrderId)
    .maybeSingle()
  if (error) throw error
  if (!o) return null

  let items: OrderItemRow[] = []
  const { data: itemRows, error: itemErr } = await supabase
    .from('or_order_items')
    .select('product_name, quantity, unit_price, is_free')
    .eq('order_id', refOrderId)
    .order('created_at', { ascending: true })
  if (itemErr) {
    console.warn('fetchRefOrderDetailWithItems: items', itemErr)
  } else {
    items = (itemRows || []) as OrderItemRow[]
  }

  const oo = o as {
    bill_no?: string
    price?: number
    total_amount?: number
    shipping_cost?: number
    discount?: number
    customer_name?: string | null
    customer_address?: string | null
    channel_code?: string | null
    admin_user?: string | null
    tracking_number?: string | null
    billing_details?: unknown
  }
  const emb = rowToRefEmbed(oo)
  return {
    bill_no: String(oo.bill_no || ''),
    price: Number(oo.price) || 0,
    total_amount: Number(oo.total_amount) || 0,
    shipping_cost: Number(oo.shipping_cost) || 0,
    discount: Number(oo.discount) || 0,
    customer_name: emb.customer_name,
    customer_address: emb.customer_address,
    mobile_phone: emb.mobile_phone,
    channel_code: emb.channel_code,
    admin_user: emb.admin_user,
    tracking_number: oo.tracking_number ?? null,
    order_items: items,
  }
}

export async function loadClaimCompareBundle(
  supabase: SupabaseClient,
  requestId: string,
): Promise<{
  detail: ClaimCompareDetail
  refOrder: RefOrderDetail | null
  packingVideoUrl: string | null
  latestPriorReqBillNo: string | null
  approvedResultBillNo: string | null
}> {
  const { data: raw, error } = await supabase
    .from('or_claim_requests')
    .select(
      'id, ref_order_id, claim_type, proposed_snapshot, ref_snapshot, status, created_at, submitted_by, rejected_reason, supporting_url, claim_description, created_claim_order_id',
    )
    .eq('id', requestId)
    .single()
  if (error) throw error

  const row = raw as Omit<ClaimCompareDetail, 'submitter' | 'packing_video_url' | 'ref_order'>

  let submitter: { username?: string | null } | null = null
  if (row.submitted_by) {
    const { data: u } = await supabase.from('us_users').select('username').eq('id', row.submitted_by).maybeSingle()
    submitter = { username: (u as { username?: string | null } | null)?.username ?? null }
  }

  const refOrder = await fetchRefOrderDetailWithItems(supabase, row.ref_order_id)

  const packingVideoUrl = await resolvePackingVideoUrl(
    supabase,
    row.ref_order_id,
    refOrder?.tracking_number,
  )

  const latestPriorReqBillNo = await fetchLatestPriorReqBillNo(supabase, row.ref_order_id, row.id)

  let approvedResultBillNo: string | null = null
  if (row.status === 'approved' && row.created_claim_order_id) {
    const { data: bo } = await supabase
      .from('or_orders')
      .select('bill_no')
      .eq('id', row.created_claim_order_id)
      .maybeSingle()
    const bn = String((bo as { bill_no?: string } | null)?.bill_no || '').trim()
    approvedResultBillNo = bn || null
  }

  const detail: ClaimCompareDetail = {
    ...row,
    submitter,
    packing_video_url: packingVideoUrl,
    ref_order: null,
  }

  return { detail, refOrder, packingVideoUrl, latestPriorReqBillNo, approvedResultBillNo }
}
