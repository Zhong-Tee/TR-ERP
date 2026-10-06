import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import type { Order, Product } from '../../types'
import type { PreBillDocument } from '../../types/prebill'
import { isMissingReservationRpc, reservationBreakdown, reservationStatusLabel, reservationTypeLabels, type StockReservationRow } from '../../lib/stockReservations'
import Modal from '../ui/Modal'
import OrderDetailView from '../order/OrderDetailView'
import PreBillPreview from '../order/PreBillPreview'

type BorrowDetail = { borrow_no: string; topic: string | null; due_date: string; note: string | null; items: Array<{ id: string; qty: number; returned_qty: number; written_off_qty: number; product: { product_code: string; product_name: string; unit_name: string | null } | null }> }
type Props = { product: Product; productIds: string[]; onClose: () => void; onRefresh: () => void }
export default function StockReservationModal({ product, productIds, onClose, onRefresh }: Props) {
  const [rows, setRows] = useState<StockReservationRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [balanceTotal, setBalanceTotal] = useState(0)
  const [order, setOrder] = useState<Order | null>(null)
  const [prebill, setPrebill] = useState<PreBillDocument | null>(null)
  const [borrow, setBorrow] = useState<BorrowDetail | null>(null)
  const [otherDetail, setOtherDetail] = useState<StockReservationRow | null>(null)
  const idsKey = productIds.join(',')
  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const result = await supabase.rpc('rpc_get_product_reservations', { p_product_ids: idsKey.split(',').filter(Boolean) })
      if (isMissingReservationRpc(result.error)) throw new Error('รายละเอียดจองยังไม่เปิดใช้งาน ต้องติดตั้ง migration การจองก่อน')
      if (result.error) throw result.error
      const balances = await supabase.from('inv_stock_balances').select('reserved').in('product_id', idsKey.split(',').filter(Boolean))
      if (balances.error) throw balances.error
      setRows((result.data || []).map((row: StockReservationRow) => ({ ...row, qty: Number(row.qty) })))
      setBalanceTotal((balances.data || []).reduce((sum, row) => sum + Number(row.reserved || 0), 0))
      onRefresh()
    } catch (e) { setError(e instanceof Error ? e.message : String((e as { message?: string }).message || e)) }
    finally { setLoading(false) }
  }, [idsKey, onRefresh])
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 30000); return () => window.clearInterval(timer) }, [load])
  async function openDocument(row: StockReservationRow) {
    setError('')
    try {
      if (row.source_type === 'order') {
        const result = await supabase.from('or_orders').select('*, order_items:or_order_items(*)').eq('id', row.source_id).single()
        if (result.error) throw result.error
        setOrder(result.data as Order)
      } else if (row.source_type === 'prebill') {
        const result = await supabase.from('or_prebill_documents').select('*, or_prebill_items(*)').eq('id', row.source_id).single()
        if (result.error) throw result.error
        setPrebill(result.data as PreBillDocument)
      } else if (row.source_type === 'borrow') {
        const result = await supabase.from('wms_borrow_requisitions').select('*, items:wms_borrow_requisition_items(*, product:pr_products(product_code,product_name,unit_name))').eq('id',row.source_id).single()
        if (result.error) throw result.error
        setBorrow(result.data as BorrowDetail)
      } else setOtherDetail(row)
    } catch { setError('เปิดเอกสารไม่ได้ อาจไม่มีสิทธิ์ดูเอกสารนี้') }
  }
  const total = rows.reduce((sum, row) => sum + row.qty, 0)
  const breakdown = reservationBreakdown(balanceTotal, total)
  return <>
    <Modal open onClose={onClose} contentClassName="max-w-6xl">
      <div className="p-6">
        <h2 className="pr-10 text-lg font-bold">รายการจอง · {product.product_code} {product.product_name}</h2>
        <div className="my-3 flex items-center justify-between"><span className="font-semibold text-orange-600">จ. {loading ? '…' : breakdown.total.toLocaleString()} {product.unit_name || 'ชิ้น'}</span><button type="button" onClick={() => void load()} className="rounded border px-3 py-1 text-sm">รีเฟรช</button></div>
        {error && <p role="alert" className="mb-3 text-red-600">{error}</p>}
        {!loading && !error && <p className="mb-3 text-sm text-gray-500">เชื่อมเอกสารได้ {breakdown.linked.toLocaleString()} {product.unit_name || 'ชิ้น'}</p>}
        {!loading && !error && breakdown.unexplained > 0 && <p role="alert" className="mb-3 rounded bg-amber-50 p-3 text-sm text-amber-800">จองเดิมรอตรวจสอบ {breakdown.unexplained.toLocaleString()} {product.unit_name || 'ชิ้น'} · จำนวนนี้รวมใน จ. แล้ว และยังหักจาก พข. จนกว่าจะตรวจสอบต้นทาง</p>}
        {!loading && !error && breakdown.underReserved > 0 && <p role="alert" className="mb-3 rounded bg-red-50 p-3 text-sm text-red-700">ยอดต้นทางสูงกว่ายอดจองในคลัง {breakdown.underReserved.toLocaleString()} {product.unit_name || 'ชิ้น'} กรุณาตรวจยอดจองก่อนปรับ</p>}
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-blue-50"><tr>{['ประเภท','เลขเอกสาร','ลูกค้า / ผู้จอง','จำนวนจองค้าง','วันสิ้นสุดจอง','สถานะล่าสุด'].map(label => <th key={label} className="whitespace-nowrap p-3 text-left">{label}</th>)}</tr></thead><tbody>
          {loading ? <tr><td colSpan={6} className="p-6 text-center">กำลังโหลด…</td></tr> : rows.length === 0 && breakdown.unexplained === 0 ? <tr><td colSpan={6} className="p-6 text-center text-gray-500">ไม่มีรายการจองค้าง</td></tr> : rows.map((row, index) => <tr key={`${row.source_type}-${row.source_id}-${row.product_id}-${index}`} className="border-b">
            <td className="p-3"><span className="whitespace-nowrap rounded bg-orange-50 px-2 py-1 font-semibold text-orange-700">{reservationTypeLabels[row.document_type]}</span></td>
            <td className="p-3"><button type="button" onClick={() => void openDocument(row)} className="font-semibold text-blue-600 underline">{row.document_no}</button>{row.source_document_no && <div className="mt-1 text-xs text-gray-500">จาก {row.source_document_no}</div>}</td>
            <td className="p-3">{row.customer_name}<div className="text-xs text-gray-500">{row.owner_name}</div></td>
            <td className="p-3 text-right">{row.qty.toLocaleString()} {product.unit_name || 'ชิ้น'}</td>
            <td className="p-3">{row.expires_on ? new Date(`${row.expires_on}T00:00:00+07:00`).toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok' }) : '—'}</td>
            <td className="p-3">{reservationStatusLabel(row)}</td>
          </tr>)}
          {!loading && !error && breakdown.unexplained > 0 && <tr className="border-b bg-amber-50 text-amber-800"><td className="p-3"><span className="rounded bg-amber-100 px-2 py-1 font-semibold">รอตรวจสอบ</span></td><td className="p-3">ยังระบุต้นทางไม่ได้</td><td className="p-3">—</td><td className="p-3 text-right">{breakdown.unexplained.toLocaleString()} {product.unit_name || 'ชิ้น'}</td><td className="p-3">—</td><td className="p-3">จองเดิมรอตรวจสอบ</td></tr>}
        </tbody></table></div>
      </div>
    </Modal>
    <Modal open={!!order || !!prebill || !!borrow || !!otherDetail} onClose={() => { setOrder(null); setPrebill(null); setBorrow(null); setOtherDetail(null) }} stackClassName="z-[60]" contentClassName="max-w-[96vw]" showCloseButton={!order}>
      {order && <OrderDetailView order={order} readOnly onClose={() => setOrder(null)} />}
      {prebill && <div className="p-6"><PreBillPreview document={prebill} items={[...(prebill.or_prebill_items || [])].sort((a,b) => a.sort_order-b.sort_order)} /></div>}
      {borrow && <div className="p-6"><h3 className="text-lg font-bold">ใบยืม · {borrow.borrow_no}</h3><p className="mt-2">{borrow.topic || '—'} · กำหนดคืน {new Date(`${borrow.due_date}T00:00:00+07:00`).toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok' })}</p><div className="mt-4 overflow-x-auto"><table className="w-full text-sm"><thead><tr>{['สินค้า','ยืม','คืนแล้ว','ของเสีย','จองค้าง'].map(label => <th key={label} className="p-2 text-left">{label}</th>)}</tr></thead><tbody>{borrow.items.map(item => <tr key={item.id} className="border-t"><td className="p-2">{item.product?.product_code} {item.product?.product_name}</td><td className="p-2">{Number(item.qty).toLocaleString()}</td><td className="p-2">{Number(item.returned_qty || 0).toLocaleString()}</td><td className="p-2">{Number(item.written_off_qty || 0).toLocaleString()}</td><td className="p-2">{Math.max(0,Number(item.qty)-Number(item.returned_qty || 0)-Number(item.written_off_qty || 0)).toLocaleString()} {item.product?.unit_name || 'ชิ้น'}</td></tr>)}</tbody></table></div>{borrow.note && <p className="mt-3 text-sm text-gray-500">{borrow.note}</p>}</div>}
      {otherDetail && <div className="p-6"><h3 className="text-lg font-bold">{reservationTypeLabels[otherDetail.document_type]} · {otherDetail.document_no}</h3><p className="mt-3">ผู้จอง: {otherDetail.owner_name}</p><p>{product.product_name} · {otherDetail.qty.toLocaleString()} {product.unit_name || 'ชิ้น'}</p><p>{reservationStatusLabel(otherDetail)}</p></div>}
    </Modal>
  </>
}
