import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { formatDateTime } from '../../lib/utils'
import Modal from '../ui/Modal'
import RefundRequestLink from '../order/RefundRequestLink'
import { fetchAllSupabasePages } from '../../lib/supabasePagination'

export type OverpaymentWaiver = {
  id: string; order_id: string; amount: number; status: 'pending' | 'approved' | 'rejected' | 'superseded'
  reason: string; evidence_url: string | null; created_at: string; reviewed_at: string | null; rejected_reason: string | null
  created_by_name: string; reviewed_by_name: string | null
  or_orders?: { bill_no: string; customer_name: string; status: string } | null
}
const waiverStatus = { pending: 'รอบัญชีรับรอง', approved: 'รับรองไม่รับคืนแล้ว', rejected: 'ไม่อนุมัติการไม่รับคืน', superseded: 'ยอดเปลี่ยน ต้องยืนยันใหม่' }

export default function OverpaymentWaiverSection({ orderId, canReview = false, onChanged }: {
  orderId?: string; canReview?: boolean; onChanged?: () => void
}) {
  const [rows, setRows] = useState<OverpaymentWaiver[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [decision, setDecision] = useState<{ row: OverpaymentWaiver; action: 'approved' | 'rejected' } | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState(false)
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchAllSupabasePages<OverpaymentWaiver>((from, to) => {
        const query = supabase.from('ac_overpayment_waivers').select('*, or_orders!inner(bill_no, customer_name, status)').order('created_at', { ascending: false }).order('id').range(from, to)
        return orderId ? query.eq('order_id', orderId) : query.neq('or_orders.status', 'ยกเลิก')
      })
      setRows(data); setError('')
    } catch (caught) { setError((caught as { message?: string }).message || 'โหลดคำขอไม่สำเร็จ') }
    finally { setLoading(false) }
  }, [orderId])
  useEffect(() => {
    void load()
    const channel = supabase.channel(`waivers-${orderId || 'account'}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ac_overpayment_waivers', ...(orderId ? { filter: `order_id=eq.${orderId}` } : {}) }, () => void load()).subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [load, orderId])

  async function submit() {
    if (!decision || busy) return
    setBusy(true); setError('')
    try {
      const { error: saveError } = await supabase.rpc('decide_overpayment_waiver', { p_id: decision.row.id, p_action: decision.action, p_reason: reason.trim() || null })
      if (saveError) throw saveError
      setDecision(null)
      await load()
      onChanged?.()
      window.dispatchEvent(new CustomEvent('sidebar-refresh-counts'))
    } catch (caught) { setError((caught as { message?: string }).message || 'บันทึกไม่สำเร็จ') }
    finally { setBusy(false) }
  }
  const visible = orderId ? rows : rows.filter(row => history ? row.status !== 'pending' : row.status === 'pending')
  if (orderId && !loading && !rows.length && !error) return null
  return <section className="space-y-3 rounded-xl border border-amber-200 bg-white p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold text-gray-800">ลูกค้าไม่รับเงินส่วนเกินคืน</h3><button type="button" onClick={() => void load()} className="rounded-lg border px-3 py-1 text-sm">รีเฟรช</button></div>
    {!orderId && <div className="flex gap-2 text-sm"><button type="button" onClick={() => setHistory(false)} className={`rounded-lg px-3 py-2 ${!history ? 'bg-amber-100' : 'bg-gray-100'}`}>รอรับรอง ({rows.filter(row => row.status === 'pending').length})</button><button type="button" onClick={() => setHistory(true)} className={`rounded-lg px-3 py-2 ${history ? 'bg-amber-100' : 'bg-gray-100'}`}>ประวัติ</button></div>}
    {error && !decision && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {loading ? <p className="text-sm text-gray-500">กำลังโหลด...</p> : !visible.length ? <p className="text-sm text-gray-500">ไม่มีรายการ</p> : visible.map(row => <div key={row.id} className="space-y-1 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap justify-between gap-2"><span className="font-semibold">{row.or_orders?.bill_no} · {row.or_orders?.customer_name} · ฿{Number(row.amount).toLocaleString('th-TH', { minimumFractionDigits: 2 })}</span><span className={row.status === 'rejected' ? 'text-red-700' : 'text-amber-800'}>{waiverStatus[row.status]}</span></div>
      <p className="whitespace-pre-wrap">{row.reason}</p>
      <RefundRequestLink value={row.evidence_url} />
      <p className="text-xs text-gray-500">ส่งโดย {row.created_by_name} · {formatDateTime(row.created_at)}{row.reviewed_at && ` · พิจารณาโดย ${row.reviewed_by_name || '–'} · ${formatDateTime(row.reviewed_at)}`}</p>
      {row.rejected_reason && <p className="text-red-700">เหตุผลไม่อนุมัติ: {row.rejected_reason}</p>}
      {row.status === 'approved' && <p className="text-xs text-gray-600">ไม่มีรายการโอนเงินออก · ยอดบิลและยอดรับเงินจริงคงเดิม</p>}
      {canReview && row.status === 'pending' && <div className="flex gap-2 pt-2"><button type="button" onClick={() => { setDecision({ row, action: 'approved' }); setReason(''); setError('') }} className="rounded-lg bg-emerald-600 px-3 py-2 text-white">รับรองไม่รับคืน</button><button type="button" onClick={() => { setDecision({ row, action: 'rejected' }); setReason(''); setError('') }} className="rounded-lg border border-red-300 px-3 py-2 text-red-700">ไม่อนุมัติ</button></div>}
    </div>)}
    <Modal open={!!decision} onClose={() => { if (!busy) setDecision(null) }} closeOnBackdropClick={!busy} showCloseButton={!busy} contentClassName="max-w-md" ariaLabelledby="waiver-decision-title">
      <div className="space-y-4 p-5"><h3 id="waiver-decision-title" className="text-lg font-semibold">{decision?.action === 'approved' ? 'รับรองลูกค้าไม่รับเงินคืน' : 'ไม่อนุมัติคำขอ'}</h3>
        <p className="text-sm">บิล {decision?.row.or_orders?.bill_no} · ส่วนเกิน ฿{Number(decision?.row.amount || 0).toLocaleString()} {decision?.action === 'approved' && 'ยืนยันว่าตรวจสอบข้อมูลแล้ว ลูกค้าไม่รับเงินส่วนเกินคืน'}</p>
        {decision?.action === 'rejected' && <label className="block text-sm">เหตุผลที่ไม่อนุมัติ *<textarea value={reason} onChange={event => setReason(event.target.value)} maxLength={1000} disabled={busy} rows={3} className="mt-1 w-full rounded-lg border p-2" /></label>}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2"><button type="button" disabled={busy} onClick={() => setDecision(null)} className="rounded-lg border px-3 py-2">ย้อนกลับ</button><button type="button" disabled={busy || (decision?.action === 'rejected' && !reason.trim())} onClick={() => void submit()} className="rounded-lg bg-blue-600 px-3 py-2 text-white disabled:opacity-50">{busy ? 'กำลังบันทึก...' : 'ยืนยัน'}</button></div>
      </div>
    </Modal>
  </section>
}
