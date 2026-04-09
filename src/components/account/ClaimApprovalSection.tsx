import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { fetchClaimTypeLabelMap, claimTypeLabel } from '../../lib/claimTypeLabels'
import { useAuthContext } from '../../contexts/AuthContext'
import Modal from '../ui/Modal'
import ClaimRequestComparePanel from '../claim/ClaimRequestComparePanel'
import type { ClaimCompareDetail, OrderItemRow, RefOrderDetail, RefOrderEmbed } from '../claim/claimCompareShared'
import { externalUrlOrNull, fmtMoney, rowToRefEmbed, submitterDisplayClaim } from '../claim/claimCompareShared'

type ClaimRequestRow = ClaimCompareDetail & { ref_order?: RefOrderEmbed; packing_video_url?: string | null }

function submitterDisplay(s: ClaimRequestRow): string {
  return submitterDisplayClaim(s)
}

export default function ClaimApprovalSection() {
  const { user } = useAuthContext()
  const canApprove = user?.role === 'superadmin' || user?.role === 'admin' || user?.role === 'account'

  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<ClaimRequestRow[]>([])
  const [detail, setDetail] = useState<ClaimRequestRow | null>(null)
  const [refOrder, setRefOrder] = useState<RefOrderDetail | null>(null)
  const [refLoading, setRefLoading] = useState(false)
  const [actionBusy, setActionBusy] = useState<'approve' | 'reject' | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [resultMsg, setResultMsg] = useState<{ open: boolean; title: string; message: string }>({
    open: false,
    title: '',
    message: '',
  })
  const [claimLabels, setClaimLabels] = useState<Record<string, string>>({})
  const [channelLabels, setChannelLabels] = useState<Record<string, string>>({})
  /** เคลมซ้ำ: ref_order_id → เลข REQ ล่าสุดที่อนุมัติแล้ว */
  const [latestReqBillByRefOrderId, setLatestReqBillByRefOrderId] = useState<Record<string, string>>({})

  useEffect(() => {
    void supabase
      .from('channels')
      .select('channel_code, channel_name')
      .then(({ data }) => {
        setChannelLabels(Object.fromEntries((data || []).map((c) => [c.channel_code, c.channel_name])))
      })
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      // ไม่ใช้ nested select จาก PostgREST — ถ้า hint FK / RLS ไม่ลงตัว ทั้งคำร้องจะ error แล้วรายการว่าง
      // ทั้งที่ count('head') ยังได้ = badge ไม่ตรงกับตาราง
      const { data, error } = await supabase
        .from('or_claim_requests')
        .select(
          'id, ref_order_id, claim_type, proposed_snapshot, ref_snapshot, status, created_at, submitted_by, rejected_reason, supporting_url, claim_description',
        )
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
      if (error) throw error
      const base = (data || []) as ClaimRequestRow[]
      const orderIds = [...new Set(base.map((r) => r.ref_order_id))]
      const submitterIds = [...new Set(base.map((r) => r.submitted_by).filter((id): id is string => Boolean(id)))]

      const orderById: Record<string, NonNullable<RefOrderEmbed>> = {}
      if (orderIds.length > 0) {
        const { data: ordRows, error: ordErr } = await supabase
          .from('or_orders')
          .select(
            'id, customer_name, customer_address, channel_code, admin_user, tracking_number, billing_details, entry_date, created_at',
          )
          .in('id', orderIds)
        if (ordErr) console.warn('ClaimApprovalSection: or_orders batch', ordErr)
        for (const o of ordRows || []) {
          const id = String((o as { id: string }).id)
          orderById[id] = rowToRefEmbed(
            o as {
              customer_name?: string | null
              customer_address?: string | null
              channel_code?: string | null
              admin_user?: string | null
              tracking_number?: string | null
              billing_details?: unknown
              entry_date?: string | null
              created_at?: string | null
            },
          )
        }
      }

      let latestReqByRef: Record<string, string> = {}
      if (orderIds.length > 0) {
        const CHUNK = 80
        type PriorApprovedRow = {
          ref_order_id: string
          created_claim_order_id: string
          reviewed_at: string | null
        }
        const priorRows: PriorApprovedRow[] = []
        for (let i = 0; i < orderIds.length; i += CHUNK) {
          const ch = orderIds.slice(i, i + CHUNK)
          const { data: part, error: apErr } = await supabase
            .from('or_claim_requests')
            .select('ref_order_id, created_claim_order_id, reviewed_at')
            .eq('status', 'approved')
            .not('created_claim_order_id', 'is', null)
            .in('ref_order_id', ch)
          if (apErr) console.warn('ClaimApprovalSection: prior approved for pending refs', apErr)
          if (part) priorRows.push(...(part as PriorApprovedRow[]))
        }
        const bestByRef = new Map<string, { reviewed_at: string; created_claim_order_id: string }>()
        for (const r of priorRows) {
          const prev = bestByRef.get(r.ref_order_id)
          const rt = r.reviewed_at || ''
          if (!prev || rt > prev.reviewed_at) {
            bestByRef.set(r.ref_order_id, {
              reviewed_at: rt,
              created_claim_order_id: r.created_claim_order_id,
            })
          }
        }
        const cidList = [...new Set([...bestByRef.values()].map((v) => v.created_claim_order_id))]
        const billById: Record<string, string> = {}
        for (let i = 0; i < cidList.length; i += CHUNK) {
          const ch = cidList.slice(i, i + CHUNK)
          if (ch.length === 0) continue
          const { data: ors, error: boErr } = await supabase
            .from('or_orders')
            .select('id, bill_no')
            .in('id', ch)
          if (boErr) console.warn('ClaimApprovalSection: REQ bill_no for table', boErr)
          for (const row of ors || []) {
            const o = row as { id: string; bill_no: string | null }
            const bn = (o.bill_no || '').trim()
            if (bn) billById[o.id] = bn
          }
        }
        for (const [refId, v] of bestByRef) {
          const bn = billById[v.created_claim_order_id]
          if (bn) latestReqByRef[refId] = bn
        }
      }
      setLatestReqBillByRefOrderId(latestReqByRef)

      const submitterById: Record<string, { username?: string | null }> = {}
      if (submitterIds.length > 0) {
        const { data: uRows, error: uErr } = await supabase
          .from('us_users')
          .select('id, username')
          .in('id', submitterIds)
        if (uErr) console.warn('ClaimApprovalSection: us_users batch', uErr)
        for (const u of uRows || []) {
          submitterById[String((u as { id: string }).id)] = {
            username: (u as { username?: string | null }).username ?? null,
          }
        }
      }

      const raw: ClaimRequestRow[] = base.map((r) => ({
        ...r,
        ref_order: orderById[r.ref_order_id] ?? null,
        submitter: r.submitted_by ? submitterById[r.submitted_by] ?? null : null,
      }))

      const videoByOrder = new Map<string, string>()
      const videoByTracking = new Map<string, string>()
      if (orderIds.length > 0) {
        try {
          const { data: vrows, error: vErr } = await supabase
            .from('pk_packing_videos')
            .select('order_id, tracking_number, gdrive_url, created_at')
            .in('order_id', orderIds)
            .not('gdrive_url', 'is', null)
            .order('created_at', { ascending: false })
          if (vErr) throw vErr
          for (const vr of vrows || []) {
            const url = vr.gdrive_url ? String(vr.gdrive_url) : ''
            if (!url) continue
            const oid = vr.order_id ? String(vr.order_id) : ''
            const tn = vr.tracking_number ? String(vr.tracking_number).trim() : ''
            if (oid && !videoByOrder.has(oid)) videoByOrder.set(oid, url)
            if (tn && !videoByTracking.has(tn)) videoByTracking.set(tn, url)
          }
        } catch {
          /* ignore video lookup */
        }
      }
      const enriched = raw.map((r) => {
        const tn = r.ref_order?.tracking_number ? String(r.ref_order.tracking_number).trim() : ''
        const url =
          videoByOrder.get(r.ref_order_id) || (tn ? videoByTracking.get(tn) : undefined) || null
        return { ...r, packing_video_url: url }
      })
      setRows(enriched)
    } catch (e) {
      console.error(e)
      setRows([])
      setLatestReqBillByRefOrderId({})
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void fetchClaimTypeLabelMap().then(setClaimLabels)
  }, [])

  async function openDetail(r: ClaimRequestRow) {
    setDetail(r)
    setRejectReason('')
    setRefOrder(null)
    setRefLoading(true)
    try {
      const { data: o, error } = await supabase
        .from('or_orders')
        .select(
          'bill_no, price, total_amount, shipping_cost, discount, customer_name, customer_address, channel_code, admin_user, billing_details',
        )
        .eq('id', r.ref_order_id)
        .maybeSingle()
      if (error) throw error

      let items: OrderItemRow[] = []
      const { data: itemRows, error: itemErr } = await supabase
        .from('or_order_items')
        .select('product_name, quantity, unit_price, is_free')
        .eq('order_id', r.ref_order_id)
        .order('created_at', { ascending: true })
      if (itemErr) {
        console.warn('ClaimApprovalSection: or_order_items', itemErr)
      } else {
        items = (itemRows || []) as OrderItemRow[]
      }

      if (o) {
        const emb = rowToRefEmbed(
          o as {
            customer_name?: string | null
            customer_address?: string | null
            channel_code?: string | null
            admin_user?: string | null
            tracking_number?: string | null
            billing_details?: unknown
          },
        )
        setRefOrder({
          bill_no: String(o.bill_no || ''),
          price: Number(o.price) || 0,
          total_amount: Number(o.total_amount) || 0,
          shipping_cost: Number(o.shipping_cost) || 0,
          discount: Number(o.discount) || 0,
          customer_name: emb.customer_name,
          customer_address: emb.customer_address,
          mobile_phone: emb.mobile_phone,
          channel_code: emb.channel_code,
          admin_user: emb.admin_user,
          order_items: items,
        })
      }
    } catch (e) {
      console.error(e)
    } finally {
      setRefLoading(false)
    }
  }

  async function approve() {
    if (!detail || !canApprove) return
    setActionBusy('approve')
    try {
      const { data, error } = await supabase.rpc('rpc_approve_claim_request', { p_request_id: detail.id })
      if (error) throw error
      const billNo = (data as { bill_no?: string })?.bill_no || ''
      setDetail(null)
      await load()
      setResultMsg({
        open: true,
        title: 'อนุมัติแล้ว',
        message: billNo ? 'สร้างบิลเคลม ' + billNo + ' เรียบร้อย' : 'อนุมัติเรียบร้อย',
      })
      window.dispatchEvent(new CustomEvent('sidebar-refresh-counts'))
      window.dispatchEvent(new CustomEvent('account-refresh-history'))
    } catch (e: any) {
      setResultMsg({ open: true, title: 'ผิดพลาด', message: e?.message || 'อนุมัติไม่สำเร็จ' })
    } finally {
      setActionBusy(null)
    }
  }

  async function reject() {
    if (!detail || !canApprove) return
    setActionBusy('reject')
    try {
      const { error } = await supabase.rpc('rpc_reject_claim_request', {
        p_request_id: detail.id,
        p_reason: rejectReason || '',
      })
      if (error) throw error
      setDetail(null)
      await load()
      setResultMsg({ open: true, title: 'ปฏิเสธแล้ว', message: 'บันทึกการปฏิเสธคำขอเคลมเรียบร้อย' })
      window.dispatchEvent(new CustomEvent('sidebar-refresh-counts'))
      window.dispatchEvent(new CustomEvent('account-refresh-history'))
    } catch (e: any) {
      setResultMsg({ open: true, title: 'ผิดพลาด', message: e?.message || 'ปฏิเสธไม่สำเร็จ' })
    } finally {
      setActionBusy(null)
    }
  }

  return (
    <section className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50">
        <h2 className="text-lg font-semibold text-gray-800">อนุมัติเคลม</h2>
        <p className="text-sm text-gray-500 mt-0.5">คำขอเคลมที่รออนุมัติจากบัญชี — คลิกเพื่อเปรียบเทียบกับบิลเดิม</p>
      </div>
      <div className="p-6">
        {loading ? (
          <div className="flex justify-center py-12 text-gray-500">กำลังโหลด...</div>
        ) : rows.length === 0 ? (
          <div className="text-center py-12 text-gray-500">ไม่มีคำขอเคลมที่รออนุมัติ</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[1340px]">
              <thead>
                <tr className="border-b text-left text-gray-600">
                  <th className="py-2 pr-3">วันที่ส่ง</th>
                  <th
                    className="py-2 pr-3"
                    title="เคลมซ้ำ: แสดงเลข REQ ล่าสุด — บรรทัดรองเป็นเลขบิลจัดส่งต้น"
                  >
                    บิลอ้างอิง
                  </th>
                  <th className="py-2 pr-3">วันที่สร้าง</th>
                  <th className="py-2 pr-3">ผู้สร้าง</th>
                  <th className="py-2 pr-3">ชื่อลูกค้า</th>
                  <th className="py-2 pr-3 max-w-[200px]">ที่อยู่จัดส่ง</th>
                  <th className="py-2 pr-3 whitespace-nowrap">เบอร์โทร</th>
                  <th className="py-2 pr-3">ลิงก์หลักฐาน</th>
                  <th className="py-2 pr-3">วิดีโอ (แพคสินค้า)</th>
                  <th className="py-2 pr-3">หัวข้อเคลม</th>
                  <th className="py-2">ยอดเดิม</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const baseBill = r.ref_snapshot?.bill_no || '–'
                  const reqLatest = latestReqBillByRefOrderId[r.ref_order_id]
                  return (
                  <tr
                    key={r.id}
                    className="border-b border-gray-50 hover:bg-gray-50/80 cursor-pointer"
                    onClick={() => void openDetail(r)}
                  >
                    <td className="py-2 pr-3 whitespace-nowrap">{new Date(r.created_at).toLocaleString('th-TH')}</td>
                    <td className="py-2 pr-3 align-top">
                      {reqLatest ? (
                        <div>
                          <div className="font-mono font-semibold text-gray-900 whitespace-nowrap">{reqLatest}</div>
                          <div className="text-xs text-gray-500 mt-0.5 whitespace-nowrap">บิลต้น {baseBill}</div>
                        </div>
                      ) : (
                        <span className="font-medium font-mono whitespace-nowrap">{baseBill}</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {r.ref_order?.bill_created_at_display?.trim() || '–'}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">{submitterDisplay(r)}</td>
                    <td className="py-2 pr-3 max-w-[160px] truncate" title={r.ref_order?.customer_name || ''}>
                      {r.ref_order?.customer_name?.trim() || '–'}
                    </td>
                    <td
                      className="py-2 pr-3 max-w-[200px] truncate align-top"
                      title={r.ref_order?.customer_address || ''}
                    >
                      {r.ref_order?.customer_address?.trim() || '–'}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">{r.ref_order?.mobile_phone?.trim() || '–'}</td>
                    <td className="py-2 pr-3" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        disabled={!externalUrlOrNull(r.supporting_url ?? undefined)}
                        title={externalUrlOrNull(r.supporting_url ?? undefined) ? 'เปิดลิงก์หลักฐานในแท็บใหม่' : 'ไม่มีลิงก์'}
                        onClick={() => {
                          const u = externalUrlOrNull(r.supporting_url ?? undefined)
                          if (u) window.open(u, '_blank', 'noopener,noreferrer')
                        }}
                        className="px-2.5 py-1 rounded-md text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
                      >
                        ลิงก์
                      </button>
                    </td>
                    <td className="py-2 pr-3" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        disabled={!r.packing_video_url}
                        title={r.packing_video_url ? 'เปิดวิดีโอแพคในแท็บใหม่' : 'ยังไม่พบวิดีโอของบิลนี้'}
                        onClick={() => r.packing_video_url && window.open(r.packing_video_url, '_blank', 'noopener,noreferrer')}
                        className="px-2.5 py-1 rounded-md text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
                      >
                        วิดีโอ (แพค)
                      </button>
                    </td>
                    <td className="py-2 pr-3">{claimTypeLabel(claimLabels, r.claim_type)}</td>
                    <td className="py-2 whitespace-nowrap">{fmtMoney(Number(r.ref_snapshot?.total_amount) || 0)}</td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal
        open={detail != null}
        onClose={() => setDetail(null)}
        contentClassName="max-w-6xl max-h-[92vh] flex flex-col"
        closeOnBackdropClick
      >
        {detail && (
          <div className="p-5 flex flex-col flex-1 min-h-0">
            <ClaimRequestComparePanel
              detail={detail}
              refOrder={refOrder}
              refLoading={refLoading}
              channelLabels={channelLabels}
              claimLabels={claimLabels}
              latestPriorReqBillNo={latestReqBillByRefOrderId[detail.ref_order_id] ?? null}
            />

            {canApprove && (
              <div className="mt-4 flex flex-col sm:flex-row gap-3 sm:items-end sm:justify-between border-t pt-4">
                <div className="flex-1">
                  <label className="block text-xs text-gray-600 mb-1">เหตุผลปฏิเสธ (ถ้ามี)</label>
                  <input
                    type="text"
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                    placeholder="กรอกเมื่อปฏิเสธ..."
                  />
                </div>
                <div className="flex gap-2 justify-end">
                  <button
                    type="button"
                    onClick={() => setDetail(null)}
                    className="px-4 py-2 border rounded-lg hover:bg-gray-50"
                  >
                    ปิด
                  </button>
                  <button
                    type="button"
                    disabled={actionBusy != null}
                    onClick={() => void reject()}
                    className="px-4 py-2 border border-red-200 text-red-700 rounded-lg hover:bg-red-50 disabled:opacity-50"
                  >
                    {actionBusy === 'reject' ? 'กำลัง...' : 'ปฏิเสธ'}
                  </button>
                  <button
                    type="button"
                    disabled={actionBusy != null}
                    onClick={() => void approve()}
                    className="px-4 py-2 bg-amber-500 text-white rounded-lg hover:bg-amber-600 disabled:opacity-50"
                  >
                    {actionBusy === 'approve' ? 'กำลัง...' : 'อนุมัติสร้างบิลเคลม'}
                  </button>
                </div>
              </div>
            )}
            {!canApprove && (
              <p className="mt-4 text-sm text-gray-500">บัญชีหรือผู้ดูแลระบบเท่านั้นที่อนุมัติ/ปฏิเสธได้</p>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={resultMsg.open}
        onClose={() => setResultMsg((s) => ({ ...s, open: false }))}
        contentClassName="max-w-md"
      >
        <div className="p-5">
          <h3 className="text-lg font-semibold text-gray-900 mb-2">{resultMsg.title}</h3>
          <p className="text-sm text-gray-700 whitespace-pre-line">{resultMsg.message}</p>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => setResultMsg((s) => ({ ...s, open: false }))}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700"
            >
              ตกลง
            </button>
          </div>
        </div>
      </Modal>
    </section>
  )
}
