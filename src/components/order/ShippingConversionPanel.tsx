import { useCallback, useEffect, useState } from 'react'
import { fetchAllSupabasePagesResult } from '../../lib/supabasePagination'
import { supabase } from '../../lib/supabase'
import { useAuthContext } from '../../contexts/AuthContext'
import { uploadToStorage } from '../../lib/slipVerification'
import { parseAddressText } from '../../lib/thaiAddress'
import Modal from '../ui/Modal'
import type { Order } from '../../types'

type RequestRow = {
  id: string; order_id: string; requested_by: string; requested_at: string; shipping_cost: number; original_total: number; suggested_shipping_cost: number | null
  reason: string; verification_error: string | null; review_reason: string | null; status: 'pending' | 'ready' | 'rejected' | 'cancelled'; zero_approved_by: string | null
  details: Record<string, string>; or_orders: { bill_no: string; channel_code: string; payment_method: string; status: string }
  or_shipping_conversion_payments: { amount: number; verified_at: string; trans_ref: string }[]
}
const fields = [
  ['recipient_name', 'ชื่อผู้รับ'], ['mobile_phone', 'เบอร์โทร'], ['address_line', 'ที่อยู่'],
  ['sub_district', 'ตำบล/แขวง'], ['district', 'อำเภอ/เขต'], ['province', 'จังหวัด'], ['postal_code', 'รหัสไปรษณีย์'],
] as const
const control = 'w-full rounded-lg border px-3 py-2 text-gray-900'
const button = 'rounded-lg border px-3 py-2 text-sm disabled:opacity-50'

const statusFilters = [
  ['pending', 'รอดำเนินการ'], ['zero-approval', 'รออนุมัติค่าส่ง 0'],
  ['payment', 'รอชำระ / ตรวจสลิป'], ['verification-failed', 'สลิปไม่ผ่าน / ตรวจไม่สำเร็จ'],
  ['ready', 'เสร็จสิ้น'], ['rejected', 'ไม่อนุมัติ'], ['cancelled', 'ยกเลิก'], ['all', 'ทั้งหมด'],
] as const
function matchesFilter(row: RequestRow, filter: string) {
  return filter === 'all' || row.status === filter ||
    (filter === 'verification-failed' && row.status === 'pending' && !!row.verification_error) ||
    (filter === 'zero-approval' && row.status === 'pending' && Number(row.shipping_cost) === 0 && !row.zero_approved_by) ||
    (filter === 'payment' && row.status === 'pending' && (Number(row.shipping_cost) > 0 || !!row.zero_approved_by) && !row.verification_error)
}

function statusLabel(row: RequestRow, remaining = 0) {
  if (row.status === 'ready' && remaining > 0) return 'ยอดชำระเปลี่ยนไป · รอบัญชีตรวจสอบ'
  if (row.status === 'ready') return 'เสร็จสิ้น · พร้อมแพ็ค'
  if (row.status === 'rejected') return 'ไม่อนุมัติ · ส่งกลับฝ่ายขาย'
  if (row.status === 'cancelled') return 'ยกเลิกคำขอ'
  if (Number(row.shipping_cost) === 0 && !row.zero_approved_by) return 'รออนุมัติค่าส่ง 0'
  if (row.verification_error) return 'สลิปไม่ผ่าน / ตรวจไม่สำเร็จ'
  return 'รอชำระ / ตรวจสลิปให้ครบ'
}

export default function ShippingConversionPanel({ order, approvalOnly = false, compact = false }: { order?: Order; approvalOnly?: boolean; compact?: boolean }) {
  const { user } = useAuthContext()
  const canRequest = ['superadmin', 'admin', 'sales-tr', 'sales-pump'].includes(user?.role || '')
  const canApprove = ['superadmin', 'admin', 'account'].includes(user?.role || '')
  const orderId = order?.id
  const [rows, setRows] = useState<RequestRow[]>([])
  const [balances, setBalances] = useState<Record<string, { paid: number; remaining: number }>>({})
  const [names, setNames] = useState<Record<string, string>>({})
  const [bill, setBill] = useState('')
  const [candidates, setCandidates] = useState<Order[]>([])
  const [chosen, setChosen] = useState<Order | null>(null)
  const [preview, setPreview] = useState<Order | null>(null)
  const [candidatePage, setCandidatePage] = useState(1)
  const [filter, setFilter] = useState('pending')
  const [selected, setSelected] = useState<Order | null>(null)
  const [details, setDetails] = useState<Record<string, string>>({})
  const [carrierOptions, setCarrierOptions] = useState<{ code: string; name: string }[]>([])
  const [quote, setQuote] = useState<number | null>(null)
  const [fee, setFee] = useState('')
  const [reason, setReason] = useState('')
  const [paste, setPaste] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [review, setReview] = useState<{ row: RequestRow; approve: boolean; mode: 'approval' | 'cancel' } | null>(null)
  const [reviewReason, setReviewReason] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const query = supabase.from('or_shipping_conversion_requests').select('*,or_orders(bill_no,channel_code,payment_method,status),or_shipping_conversion_payments(amount,verified_at,trans_ref)').order('requested_at', { ascending: false }).order('id')
    if (orderId) query.eq('order_id', orderId)
    if (approvalOnly) query.eq('shipping_cost', 0)
    const { data, error } = await fetchAllSupabasePagesResult<RequestRow>((from, to) => query.range(from, to))
    if (error) { setLoading(false); setMessage(error.message); return }
    setRows((data || []) as RequestRow[])
    if (!orderId && !approvalOnly && canRequest) {
      const candidateQuery = supabase.from('or_orders').select('*,order_items:or_order_items(*)')
        .eq('fulfillment_method', 'self_pickup').not('status', 'in', '(จัดส่งแล้ว,ยกเลิก)').is('shipped_time', null)
        .order('created_at', { ascending: false }).order('id')
      const result = await fetchAllSupabasePagesResult<Order>((from, to) => candidateQuery.range(from, to))
      if (result.error) setMessage(result.error.message)
      else {
        const available = (result.data || []).filter((candidate) => !candidate.transport_meta?.customer_received && !(data || []).some((r) => r.order_id === candidate.id && ['pending', 'ready'].includes(r.status)))
        setCandidates(available)
        setChosen((current) => current ? available.find((candidate) => candidate.id === current.id) || null : null)
      }
    }
    setLoading(false)
    const balanceRows: { request_id: string; paid: number; remaining: number }[] = []
    for (let start = 0; start < (data || []).length; start += 100) {
      const { data: amounts, error: balanceError } = await supabase.rpc('or_shipping_conversion_balances', { p_request_ids: (data || []).slice(start, start + 100).map((r) => r.id) })
      if (balanceError) { setMessage(balanceError.message); break }
      balanceRows.push(...(amounts || []))
    }
    setBalances(Object.fromEntries(balanceRows.map((b) => [b.request_id, { paid: Number(b.paid), remaining: Number(b.remaining) }])))
    const ids = [...new Set((data || []).flatMap((r) => [r.requested_by, r.zero_approved_by].filter(Boolean)))]
    if (ids.length) {
      const { data: people } = await supabase.from('us_users').select('id,username,email').in('id', ids)
      setNames(Object.fromEntries((people || []).map((p) => [p.id, p.username || p.email || p.id])))
    }
  }, [orderId, approvalOnly, canRequest])
  useEffect(() => {
    if (!canRequest && !canApprove) return
    const firstLoad = window.setTimeout(() => void load(), 0)
    const timer = window.setInterval(() => { if (!document.hidden) void load() }, 30000)
    return () => { window.clearTimeout(firstLoad); window.clearInterval(timer) }
  }, [load, canRequest, canApprove])

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    const timer = window.setTimeout(async () => {
      const { data, error } = await supabase.rpc('or_quote_conversion_shipping', { p_order_id: selected.id, p_details: details })
      if (!cancelled) setQuote(error || data == null ? null : Number(data))
    }, 300)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [selected, details])

  async function act(action: () => Promise<void>) {
    setBusy(true); setMessage('')
    try { await action(); await load(); window.dispatchEvent(new Event('shipping-conversion-changed')) } catch (e) { await load(); setMessage(e instanceof Error ? e.message : 'ดำเนินการไม่สำเร็จ') }
    finally { setBusy(false) }
  }
  async function openRequest(candidate?: Order) {
    await act(async () => {
      if (!candidate) throw new Error('กรุณาเลือกบิลก่อนยืนยัน')
      const { data: latest, error: orderError } = await supabase.from('or_orders').select('*').eq('id', candidate.id).single()
      if (orderError) throw orderError
      const target = latest as Order
      if (!target || target.fulfillment_method !== 'self_pickup' || ['จัดส่งแล้ว', 'ยกเลิก'].includes(target.status) || target.shipped_time || target.transport_meta?.customer_received) throw new Error('เลือกบิลรับสินค้าเองที่ยังไม่ส่งมอบสินค้า')
      if (rows.some((r) => r.order_id === target!.id && ['pending', 'ready'].includes(r.status))) throw new Error('บิลนี้มีคำขออยู่แล้ว กรุณาดำเนินการจากรายการเดิม')
      const { data: carriers, error } = await supabase.from('tr_shipping_carriers').select('code,name').eq('is_active', true).neq('code', 'SELF').order('sort_order')
      if (error) throw error
      setCarrierOptions(carriers || []); setSelected(target); setDetails({ recipient_name: target.recipient_name || target.customer_name || '' })
      setFee(''); setQuote(null); setReason(''); setPaste('')
    })
  }
  async function submit() {
    if (!selected || !Number.isFinite(Number(fee)) || fee.trim() === '' || Number(fee) < 0 || !reason.trim() || fields.some(([key]) => !details[key]?.trim()) || !details.carrier) { setMessage('กรอกข้อมูลผู้รับ ที่อยู่ ขนส่ง ค่าส่ง และเหตุผลให้ครบ'); return }
    await act(async () => {
      const { error } = await supabase.rpc('or_request_shipping_conversion', { p_order_id: selected.id, p_shipping_cost: Number(fee), p_details: details, p_reason: reason.trim() })
      if (error) throw error
      setSelected(null); setChosen(null); setMessage('ส่งคำขอแล้ว งานแพ็คจะพักจนกว่าจะตรวจเงิน/อนุมัติครบ')
    })
  }
  async function verify(row: RequestRow, file: File) {
    await act(async () => {
      const path = await uploadToStorage(file, 'slip-images', `shipping-conversion/${row.id}/${user!.id}`)
      const { data, error } = await supabase.functions.invoke('verify-shipping-conversion', { body: { requestId: row.id, storagePath: path } })
      if (error) {
        let text = error.message
        try { const payload = await error.context?.json(); text = payload?.error || text } catch { /* retain error */ }
        throw new Error(text)
      }
      if (!data?.success) throw new Error(data?.error || 'ตรวจสลิปไม่ผ่าน')
      setMessage(data.ready ? 'ตรวจเงินครบแล้ว พร้อมจัดส่งและแพ็คต่อ' : 'บันทึกสลิปผ่านแล้ว ยังต้องตรวจยอดชำระ/อนุมัติค่าส่งให้ครบ')
    })
  }
  const visible = rows.filter((row) => matchesFilter(row, filter))
  const search = bill.trim().toLocaleLowerCase()
  const matchingCandidates = candidates.filter((candidate) => [candidate.bill_no, candidate.customer_name, candidate.recipient_name].some((value) => value?.toLocaleLowerCase().includes(search)))
  const pageCount = Math.max(1, Math.ceil(matchingCandidates.length / 10))
  const currentPage = Math.min(candidatePage, pageCount)
  const eligible = order?.fulfillment_method === 'self_pickup' && !['จัดส่งแล้ว','ยกเลิก'].includes(order.status) && !order.shipped_time && !order.transport_meta?.customer_received
  if (!canRequest && !canApprove) return null
  return <section className="space-y-3 rounded-xl border bg-white p-4 text-gray-900">
    {!compact && <h2 className="text-lg font-bold">{approvalOnly ? 'อนุมัติค่าส่ง 0' : 'เปลี่ยนเป็นจัดส่ง'}</h2>}
    {message && <p role="status" className="rounded bg-amber-50 p-3 text-amber-900">{message}</p>}
    {!approvalOnly && canRequest && (!order || eligible) && <div className="space-y-3">
      {order ? <button type="button" className={`${button} bg-blue-600 text-white`} disabled={busy || loading} onClick={() => void openRequest(order)}>เปลี่ยนเป็นจัดส่ง</button> : <>
        <div className="flex flex-wrap items-center gap-2">
          <input aria-label="ค้นหาบิลรับสินค้าเอง" placeholder="ค้นหาเลขบิล หรือชื่อลูกค้า" value={bill} onChange={(e) => { setBill(e.target.value); setCandidatePage(1) }} className="w-full rounded-lg border px-3 py-2 sm:w-80" />
          <button type="button" className={`${button} bg-blue-600 text-white`} disabled={busy || loading || !chosen} onClick={() => void openRequest(chosen!)}>ยืนยัน เปลี่ยนเป็นจัดส่ง</button>
        </div>
        {chosen && <div className="flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm"><span>เลือกบิล <strong>{chosen.bill_no}</strong> · {chosen.customer_name}</span><button type="button" className="text-blue-700 underline" onClick={() => setPreview(chosen)}>ดูรายละเอียด</button><button type="button" className="text-gray-600 underline" disabled={busy} onClick={() => setChosen(null)}>ยกเลิกการเลือก</button></div>}
        <div className="overflow-hidden rounded-lg border">
          <div className="border-b bg-gray-50 px-4 py-3"><h3 className="font-semibold">บิลรับสินค้าเองที่เปลี่ยนเป็นจัดส่งได้ ({matchingCandidates.length})</h3><p className="text-sm text-gray-500">ดูรายละเอียดและเลือกบิล ก่อนกดยืนยันเปลี่ยนเป็นจัดส่ง</p></div>
          {loading ? <p className="p-4 text-gray-500">กำลังโหลดบิล...</p> : matchingCandidates.length === 0 ? <p className="p-4 text-gray-500">{bill.trim() ? 'ไม่พบบิลที่ตรงกับคำค้น' : 'ไม่มีบิลรับสินค้าเองที่เปลี่ยนเป็นจัดส่งได้'}</p> : <>
            <div className="divide-y">{matchingCandidates.slice((currentPage - 1) * 10, currentPage * 10).map((candidate) => <article key={candidate.id} className={`flex flex-wrap items-center justify-between gap-3 p-4 ${chosen?.id === candidate.id ? 'bg-blue-50' : ''}`}>
              <div className="min-w-0"><button type="button" className="font-semibold text-blue-700 hover:underline" onClick={() => setPreview(candidate)}>{candidate.bill_no}</button><p className="text-sm">{candidate.customer_name || candidate.recipient_name || 'ไม่ระบุชื่อลูกค้า'} · {candidate.channel_code}</p><p className="text-sm text-gray-500">{candidate.status} · {Number(candidate.total_amount).toLocaleString()} บาท · {candidate.order_items?.filter((item) => !item.is_detail_row).map((item) => `${item.product_name} × ${item.quantity}`).join(', ') || 'ไม่มีรายการสินค้า'}</p></div>
              <div className="flex shrink-0 gap-2"><button type="button" className={button} onClick={() => setPreview(candidate)}>ดูรายละเอียด</button><button type="button" aria-pressed={chosen?.id === candidate.id} className={`${button} ${chosen?.id === candidate.id ? 'border-blue-600 bg-blue-600 text-white' : 'text-blue-700'}`} disabled={busy} onClick={() => setChosen(candidate)}>{chosen?.id === candidate.id ? 'เลือกแล้ว' : 'เลือกบิล'}</button></div>
            </article>)}</div>
            {pageCount > 1 && <div className="flex items-center justify-end gap-3 border-t p-3 text-sm"><button type="button" className={button} disabled={currentPage === 1} onClick={() => setCandidatePage(currentPage - 1)}>ก่อนหน้า</button><span>หน้า {currentPage} / {pageCount}</span><button type="button" className={button} disabled={currentPage === pageCount} onClick={() => setCandidatePage(currentPage + 1)}>ถัดไป</button></div>}
          </>}
        </div>
      </>}
    </div>}
    {!compact && <div className="space-y-2 border-t pt-4"><h3 className="font-semibold">รายการคำขอเปลี่ยนเป็นจัดส่ง</h3><div className="flex flex-wrap gap-2" role="group" aria-label="สถานะคำขอ">{statusFilters.map(([value, label]) => <button type="button" key={value} aria-pressed={filter === value} className={`${button} ${filter === value ? 'border-blue-600 bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`} onClick={() => setFilter(value)}>{label} ({rows.filter((row) => matchesFilter(row, value)).length})</button>)}<button type="button" className={button} disabled={busy || loading} onClick={() => void load()}>รีเฟรช</button></div></div>}
    {loading ? <p>กำลังโหลด...</p> : visible.length === 0 && !compact ? <p className="text-gray-500">ไม่มีรายการ</p> : visible.map((row) => <article key={row.id} className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap justify-between gap-2"><strong>{row.or_orders.bill_no} · {row.or_orders.channel_code}</strong><span className="rounded bg-amber-50 px-2 py-1 text-sm">{statusLabel(row, balances[row.id]?.remaining)}</span></div>
      <p className="text-sm">ผู้ขอ: {names[row.requested_by] || row.requested_by} · {new Date(row.requested_at).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}</p>
      <p>ค่าส่ง {Number(row.shipping_cost).toLocaleString()} บาท · ยอดเดิม {Number(row.original_total).toLocaleString()} บาท · ยอดใหม่ {(Number(row.original_total) + Number(row.shipping_cost)).toLocaleString()} บาท</p>
      <p className="text-sm">ค่าส่งมาตรฐานก่อนส่วนลด: {row.suggested_shipping_cost == null ? 'ไม่ได้ตั้งช่วงค่าส่ง' : `${Number(row.suggested_shipping_cost).toLocaleString()} บาท`}</p>
      {balances[row.id] && <p className="text-sm">ยอดตรวจผ่าน {balances[row.id].paid.toLocaleString()} บาท · คงเหลือ {balances[row.id].remaining.toLocaleString()} บาท</p>}
      <p className="text-sm">เหตุผล: {row.reason}</p>
      <p className="text-sm">ผู้รับ: {row.details.recipient_name} · {row.details.mobile_phone}<br />{fields.slice(2).map(([key]) => row.details[key]).join(' ')} · ขนส่ง {row.details.carrier}</p>
      {row.zero_approved_by && <p className="text-sm text-green-700">ค่าส่ง 0 อนุมัติโดย {names[row.zero_approved_by] || row.zero_approved_by}</p>}
      {row.verification_error && <p className="text-sm text-red-600">ผลตรวจล่าสุด: {row.verification_error}</p>}
      {row.review_reason && <p className="text-sm">ผลพิจารณา: {row.review_reason}</p>}
      {row.or_shipping_conversion_payments.length > 0 && <p className="text-sm text-green-700">สลิปเพิ่มผ่านแล้ว {row.or_shipping_conversion_payments.length} ใบ · รวม {row.or_shipping_conversion_payments.reduce((sum, p) => sum + Number(p.amount), 0).toLocaleString()} บาท</p>}
      {row.status === 'rejected' && !approvalOnly && canRequest && <button type="button" className={button} disabled={busy} onClick={() => void act(async () => { const { data, error } = await supabase.from('or_orders').select('*').eq('id', row.order_id).single(); if (error) throw error; await openRequest(data as Order); setDetails(row.details); setReason(row.reason); setFee(String(row.shipping_cost)) })}>แก้ไขและส่งใหม่</button>}
      {row.status === 'pending' && <div className="flex flex-wrap gap-2">
        {canApprove && Number(row.shipping_cost) === 0 && !row.zero_approved_by && <><button type="button" className={`${button} bg-green-600 text-white`} disabled={busy} onClick={() => { setReview({ row, approve: true, mode: 'approval' }); setReviewReason('') }}>อนุมัติ</button><button type="button" className={`${button} text-red-600`} disabled={busy} onClick={() => { setReview({ row, approve: false, mode: 'approval' }); setReviewReason('') }}>ไม่อนุมัติ</button></>}
        {!approvalOnly && canRequest && (Number(row.shipping_cost) > 0 || !!row.zero_approved_by) && (row.requested_by === user?.id || ['admin','superadmin'].includes(user?.role || '')) && <label className={button}>อัปโหลดและตรวจสลิปเพิ่ม<input type="file" accept="image/*" className="block text-sm" disabled={busy} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void verify(row, file) }} /></label>}
        <button type="button" className={button} disabled={busy} onClick={() => void act(async () => { const { data, error } = await supabase.rpc('or_refresh_shipping_conversion', { p_request_id: row.id }); if (error) throw error; setMessage(data.ready ? 'ตรวจเงินครบแล้ว พร้อมแพ็ค' : `ยอดตรวจผ่าน ${Number(data.paid).toLocaleString()} บาท · คงเหลือ ${Number(data.remaining).toLocaleString()} บาท${Number(row.shipping_cost) === 0 && !row.zero_approved_by ? ' · รออนุมัติค่าส่ง 0' : ''}`) })}>ตรวจยอดชำระอีกครั้ง</button>
        {!approvalOnly && canRequest && (row.requested_by === user?.id || ['admin','superadmin'].includes(user?.role || '')) && row.or_shipping_conversion_payments.length === 0 && <button type="button" className={button} disabled={busy} onClick={() => { setReview({ row, approve: false, mode: 'cancel' }); setReviewReason(''); }}>ยกเลิกคำขอ</button>}
      </div>}
    </article>)}
    <Modal open={!!preview} onClose={() => setPreview(null)} contentClassName="max-w-3xl">
      {preview && <div className="space-y-4 p-5 text-gray-900">
        <h3 className="pr-8 text-xl font-bold">รายละเอียดบิล · {preview.bill_no}</h3>
        <p>ลูกค้า: {preview.customer_name} · ผู้รับ: {preview.recipient_name || preview.customer_name}</p>
        <p className="whitespace-pre-wrap">ที่อยู่: {preview.customer_address || 'ไม่ระบุ'}</p>
        <p>ช่องทาง: {preview.channel_code} · สถานะ: {preview.status} · การชำระเงิน: {preview.payment_method || 'ไม่ระบุ'}</p>
        <p>วันที่เปิดบิล: {new Date(preview.created_at).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}</p>
        <div className="divide-y rounded-lg border">{preview.order_items?.length ? [...preview.order_items].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)).map((item) => <div key={item.id} className="space-y-1 p-3"><p className="font-semibold">{item.product_name} · {item.quantity} ชิ้น</p><p className="text-sm">{[item.ink_color, item.product_type, item.line_1, item.line_2, item.line_3, item.notes].filter(Boolean).join(' · ')}</p></div>) : <p className="p-3 text-gray-500">ไม่มีรายการสินค้า</p>}</div>
        <p className="font-semibold">ยอดรวม {Number(preview.total_amount).toLocaleString()} บาท</p>
        <div className="flex justify-end gap-2"><button type="button" className={button} onClick={() => setPreview(null)}>ปิด</button><button type="button" className={`${button} bg-blue-600 text-white`} disabled={busy} onClick={() => { setChosen(preview); setPreview(null) }}>เลือกบิลนี้</button></div>
      </div>}
    </Modal>
    <Modal open={!!selected} onClose={() => { if (!busy) setSelected(null) }} contentClassName="max-w-3xl">
      <form className="space-y-4 p-5 text-gray-900" onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <h3 className="text-xl font-bold">เปลี่ยนเป็นจัดส่ง · {selected?.bill_no}</h3>
        <p className="text-sm">ค่าส่งมากกว่า 0 ต้องตรวจสลิปให้ครบ ค่าส่ง 0 ต้องให้ Superadmin / บัญชี / Admin อนุมัติก่อน ฝ่ายแพ็คจะรอจนกว่าจะครบทุกเงื่อนไข</p>
        {message && <p role="alert" className="text-red-600">{message}</p>}
        <textarea aria-label="วางที่อยู่" className={control} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="วางข้อความผู้รับและที่อยู่เพื่อแยกข้อมูล" />
        <button type="button" className={button} disabled={busy || !paste.trim()} onClick={() => void act(async () => { const p = await parseAddressText(paste, supabase); setDetails((d) => ({ ...d, recipient_name: p.recipientName || d.recipient_name, address_line: p.addressLine || '', sub_district: p.subDistrict || '', district: p.district || '', province: p.province || '', postal_code: p.postalCode || '', mobile_phone: p.mobilePhone || '' })) })}>แยกที่อยู่อัตโนมัติ</button>
        <div className="grid gap-3 sm:grid-cols-2">{fields.map(([key,label]) => <label key={key} className="text-sm">{label}<input required className={control} value={details[key] || ''} onChange={(e) => setDetails({ ...details, [key]: e.target.value })} maxLength={key === 'postal_code' ? 5 : undefined} /></label>)}
          <label className="text-sm">ขนส่ง<select required className={control} value={details.carrier || ''} onChange={(e) => setDetails({ ...details, carrier: e.target.value })}><option value="">เลือกขนส่ง</option>{carrierOptions.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></label>
          <label className="text-sm">ค่าส่ง (บาท)<input required type="number" min="0" step="0.01" className={control} value={fee} onChange={(e) => setFee(e.target.value)} /></label>
        </div>
        <p className="text-sm">ค่าส่งมาตรฐานตามช่วงยอดและพื้นที่ ก่อนส่วนลด: {quote == null ? 'ยังไม่มีค่าประเมิน' : `${quote.toLocaleString()} บาท`}</p>
        {quote != null && <button type="button" className={button} disabled={busy} onClick={() => setFee(String(quote))}>ใช้ค่าส่งมาตรฐาน</button>}
        <label className="block text-sm">เหตุผลการเปลี่ยน / เหตุผลค่าส่ง 0<textarea required className={control} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <div className="flex justify-end gap-2"><button type="button" className={button} disabled={busy} onClick={() => setSelected(null)}>ปิด</button><button type="submit" className={`${button} bg-blue-600 text-white`} disabled={busy}>{busy ? 'กำลังบันทึก...' : 'ยืนยัน เปลี่ยนเป็นจัดส่ง'}</button></div>
      </form>
    </Modal>
    <Modal open={!!review} onClose={() => { if (!busy) setReview(null) }} contentClassName="max-w-lg">
      <form className="space-y-3 p-5" onSubmit={(e) => { e.preventDefault(); if (!review) return; void act(async () => { const approval = review.mode === 'approval'; const { error } = approval ? await supabase.rpc('or_review_zero_shipping', { p_request_id: review.row.id, p_approve: review.approve, p_reason: reviewReason }) : await supabase.rpc('or_cancel_shipping_conversion', { p_request_id: review.row.id, p_reason: reviewReason }); if (error) throw error; setReview(null); setMessage(approval ? (review.approve ? 'อนุมัติค่าส่ง 0 แล้ว ระบบจะปล่อยแพ็คเมื่อยอดสินค้าตรวจผ่านครบ' : 'ไม่อนุมัติ ส่งกลับฝ่ายขายแล้ว') : 'ยกเลิกคำขอแล้ว') }) }}>
        <h3 className="font-bold">{review?.mode === 'approval' ? (review?.approve ? 'อนุมัติค่าส่ง 0' : 'ไม่อนุมัติค่าส่ง 0') : 'ยกเลิกคำขอ'} · {review?.row.or_orders.bill_no}</h3>
        {message && <p role="alert" className="text-red-600">{message}</p>}
        <textarea required aria-label="เหตุผลพิจารณา" placeholder="ระบุเหตุผล" className={control} value={reviewReason} onChange={(e) => setReviewReason(e.target.value)} />
        <button type="submit" className={`${button} bg-blue-600 text-white`} disabled={busy}>ยืนยัน</button>
      </form>
    </Modal>
  </section>
}
