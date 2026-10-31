import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import Modal from '../ui/Modal'

type RefundMatch = {
  id: string; amount: number; created_at: string; recipient: string | null
  bank: string | null; account_number: string | null; reason: string | null
  has_slip: boolean; sent: boolean; matched_at: string | null
}
type MatchData = { excess: number; matched_amount: number; remaining: number; waived_amount?: number; refunds: RefundMatch[] }
const money = (value: number) => Number(value).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function OverpaymentRefundModal({ order, onClose, onChanged }: {
  order: { id: string; bill_no: string }; onClose: () => void; onChanged: () => void
}) {
  const [data, setData] = useState<MatchData | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState('')
  const [notice, setNotice] = useState('')
  const generation = useRef(0)
  const cancelLoad = useCallback(() => { generation.current++ }, [])
  const load = useCallback(async () => {
    const request = ++generation.current
    setLoading(true)
    try {
      const result = await supabase.rpc('bank_overpayment_refunds', { p_order_id: order.id })
      if (request !== generation.current) return
      if (result.error) throw result.error
      setData(result.data as MatchData)
    } catch (caught) {
      if (request === generation.current) {
        setData(null)
        setError((caught as { message?: string }).message || 'โหลดรายการโอนคืนไม่สำเร็จ')
      }
    } finally { if (request === generation.current) setLoading(false) }
  }, [order.id])
  useEffect(() => { void load(); return cancelLoad }, [load, cancelLoad])

  async function save(refundId: string, remove = false) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await supabase.rpc('bank_match_overpayment_refund', {
        p_order_id: order.id, p_refund_id: refundId, p_remove: remove,
      })
      if (result.error) throw result.error
      setNotice(remove ? 'ยกเลิกการจับคู่แล้ว' : 'จับคู่รายการโอนคืนแล้ว')
      onChanged()
    } catch (caught) {
      setError((caught as { message?: string }).message || 'บันทึกการจับคู่ไม่สำเร็จ')
    } finally {
      setSelected('')
      await load()
      setBusy(false)
    }
  }
  const matched = data?.refunds.filter(r => r.matched_at) || []
  const candidates = data?.refunds.filter(r => !r.matched_at) || []
  return <Modal open onClose={() => { if (!busy) onClose() }} ariaLabelledby="overpayment-refund-title" contentClassName="max-w-3xl w-full" showCloseButton={!busy}>
    <div className="space-y-4 p-5">
      <h3 id="overpayment-refund-title" className="pr-8 text-lg font-bold">จัดการยอดรับเกิน · {order.bill_no}</h3>
      <p className="text-sm text-gray-500">เลือกรายการโอนคืนที่อนุมัติแล้วของบิลนี้ · การจับคู่ไม่เปลี่ยนยอดเงินรับหรือยืนยันการโอนเงิน</p>
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {notice && <p role="status" className="text-sm text-emerald-700">{notice}</p>}
      {loading ? <p className="py-6 text-center">กำลังโหลดรายการ...</p> : data && <>
        {Number(data.waived_amount) > 0 && <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">บัญชีรับรองว่าลูกค้าไม่รับคืน ฿{money(data.waived_amount!)} · ไม่มีรายการโอนเงินออก · หักออกจากส่วนเกินที่รอจัดการแล้ว</p>}
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div className="rounded-lg bg-red-50 p-3">รับเกิน<div className="font-semibold text-red-600">฿{money(data.excess)}</div></div>
          <div className="rounded-lg bg-emerald-50 p-3">จับคู่แล้ว<div className="font-semibold">฿{money(data.matched_amount)}</div></div>
          <div className="rounded-lg bg-gray-100 p-3">ยังไม่จับคู่<div className="font-semibold">฿{money(data.remaining)}</div></div>
        </div>
        {Number(data.matched_amount) > Number(data.excess) && <p role="alert" className="text-sm text-red-700">ยอดรับเกินปัจจุบันน้อยกว่ายอดที่จับคู่ไว้ กรุณาตรวจสอบและยกเลิกคู่ที่ไม่ถูกต้อง</p>}
        <h4 className="font-semibold">รายการที่ยังไม่ได้จับคู่ ({candidates.length})</h4>
        {!candidates.length ? <p className="text-sm text-gray-500">ไม่มีรายการโอนคืนที่อนุมัติแล้วและยังไม่ได้จับคู่ของบิลนี้</p> : <div className="space-y-2">
          {candidates.map(r => <label key={r.id} className={`flex items-start gap-3 rounded-lg border p-3 text-sm ${selected === r.id ? 'border-blue-400 bg-blue-50' : ''}`}>
            <input type="radio" name="refund-match" value={r.id} checked={selected === r.id} disabled={busy || Number(r.amount) <= 0 || Number(r.amount) > Number(data.remaining)} onChange={() => setSelected(r.id)} className="mt-1" />
            <div className="min-w-0 flex-1"><div className="font-semibold">฿{money(r.amount)} · {r.recipient || 'ไม่ระบุชื่อบัญชี'}</div>
              <p>{r.bank || '–'} · {r.account_number || '–'}</p>
              <p className="text-xs text-gray-500">{new Date(r.created_at).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })} · {r.sent ? 'โอนคืนเสร็จสิ้น' : r.has_slip ? 'แนบสลิปแล้ว' : 'อนุมัติแล้ว รอแนบสลิป'}</p>
              {r.reason && <p>{r.reason}</p>}
              <p className="break-all text-xs text-gray-500">รหัสรายการ: {r.id}</p>
              {Number(r.amount) > Number(data.remaining) && <p className="text-xs text-red-600">ยอดเกินยอดรับเกินที่ยังไม่ได้จับคู่</p>}
            </div>
          </label>)}
          <button disabled={busy || !selected} onClick={() => void save(selected)} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{busy ? 'กำลังบันทึก...' : 'ยืนยันจับคู่'}</button>
        </div>}
        <h4 className="font-semibold">รายการที่จับคู่แล้ว ({matched.length})</h4>
        {!matched.length ? <p className="text-sm text-gray-500">ยังไม่มีรายการที่จับคู่</p> : matched.map(r => <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-200 p-3 text-sm">
          <div className="min-w-0"><p className="font-semibold">฿{money(r.amount)} · {r.recipient || 'ไม่ระบุชื่อบัญชี'}</p><p className="break-all text-xs text-gray-500">รหัสรายการ: {r.id}</p><p className="text-xs text-gray-500">จับคู่เมื่อ {new Date(r.matched_at!).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}</p></div>
          <button disabled={busy} onClick={() => void save(r.id, true)} className="text-sm text-red-700 disabled:opacity-40">ยกเลิกการจับคู่</button>
        </div>)}
      </>}
      <div className="flex justify-end gap-2"><button disabled={busy || loading} onClick={() => { setError(''); void load() }} className="rounded-lg border px-4 py-2 text-sm disabled:opacity-40">รีเฟรช</button><button disabled={busy} onClick={onClose} className="rounded-lg border px-4 py-2 text-sm disabled:opacity-40">ปิด</button></div>
    </div>
  </Modal>
}
