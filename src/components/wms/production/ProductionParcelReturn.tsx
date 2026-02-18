import { useState, useEffect } from 'react'
import { useAuthContext } from '../../../contexts/AuthContext'
import { supabase } from '../../../lib/supabase'
import BarcodeScanner from './BarcodeScanner'
import { getProductImageUrl } from '../wmsUtils'
import { useWmsModal } from '../useWmsModal'

interface MatchedOrder {
  bill_no: string
  tracking_number: string
  customer_name?: string
  status?: string
  items: Array<{
    product_id: string
    product_code: string
    product_name: string
    qty: number
  }>
}

export default function ProductionParcelReturn() {
  const { user } = useAuthContext()
  const [showScanner, setShowScanner] = useState(false)
  const [trackingInput, setTrackingInput] = useState('')
  const [searching, setSearching] = useState(false)
  const [matchedOrder, setMatchedOrder] = useState<MatchedOrder | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [recentReturns, setRecentReturns] = useState<any[]>([])
  const [loadingRecent, setLoadingRecent] = useState(false)
  const [lightboxImg, setLightboxImg] = useState<string | null>(null)
  const { showMessage, showConfirm, MessageModal, ConfirmModal } = useWmsModal()

  useEffect(() => { loadRecentReturns() }, [])

  const loadRecentReturns = async () => {
    setLoadingRecent(true)
    try {
      const { data } = await supabase
        .from('inv_returns')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(20)
      setRecentReturns(data || [])
    } catch {} finally { setLoadingRecent(false) }
  }

  const lookupTracking = async (tracking: string) => {
    const trimmed = tracking.trim().toUpperCase()
    if (!trimmed) return
    setSearching(true)
    setMatchedOrder(null)
    setNotFound(false)

    try {
      const { data: orders, error } = await supabase
        .from('or_orders')
        .select('bill_no, tracking_number, recipient_name, status, or_order_items(product_id, quantity)')
        .eq('tracking_number', trimmed)
        .limit(1)
      if (error) throw error

      if (!orders || orders.length === 0) {
        setNotFound(true)
        return
      }

      const order = orders[0]
      const items = order.or_order_items || []
      const productIds = items.map((i: any) => i.product_id).filter(Boolean)

      let productMap: Record<string, { product_code: string; product_name: string }> = {}
      if (productIds.length > 0) {
        const { data: prods } = await supabase
          .from('pr_products')
          .select('id, product_code, product_name')
          .in('id', productIds)
        ;(prods || []).forEach((p: any) => {
          productMap[p.id] = { product_code: p.product_code, product_name: p.product_name }
        })
      }

      setMatchedOrder({
        bill_no: order.bill_no,
        tracking_number: order.tracking_number,
        customer_name: order.recipient_name || '-',
        status: order.status,
        items: items.map((i: any) => ({
          product_id: i.product_id,
          product_code: productMap[i.product_id]?.product_code || '-',
          product_name: productMap[i.product_id]?.product_name || '-',
          qty: Number(i.quantity) || 1,
        })),
      })
    } catch (e: any) {
      showMessage({ message: `ค้นหาไม่สำเร็จ: ${e.message}` })
    } finally {
      setSearching(false)
    }
  }

  const handleScan = (barcode: string) => {
    setShowScanner(false)
    setTrackingInput(barcode)
    lookupTracking(barcode)
  }

  const submitReturn = async () => {
    if (!matchedOrder) return
    if (!reason.trim()) {
      showMessage({ message: 'กรุณาระบุเหตุผลตีกลับ' })
      return
    }

    const ok = await showConfirm({
      title: 'ยืนยันรับสินค้าตีกลับ',
      message: `บิล: ${matchedOrder.bill_no}\nTracking: ${matchedOrder.tracking_number}\nรายการ: ${matchedOrder.items.length} รายการ`,
    })
    if (!ok) return

    setSubmitting(true)
    try {
      const date = new Date()
      const dateStr = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
      const rand = Math.floor(Math.random() * 9000) + 1000
      const returnNo = `RTN-${dateStr}-${rand}`

      const { data: retData, error: retErr } = await supabase
        .from('inv_returns')
        .insert({
          return_no: returnNo,
          ref_bill_no: matchedOrder.bill_no,
          tracking_number: matchedOrder.tracking_number,
          reason: reason.trim(),
          status: 'pending',
          created_by: user?.id || null,
          note: note.trim() || null,
        })
        .select('*')
        .single()
      if (retErr) throw retErr

      const itemsPayload = matchedOrder.items
        .filter((i) => i.product_id)
        .map((i) => ({
          return_id: retData.id,
          product_id: i.product_id,
          qty: i.qty,
        }))

      if (itemsPayload.length > 0) {
        const { error: itemErr } = await supabase.from('inv_return_items').insert(itemsPayload)
        if (itemErr) throw itemErr
      }

      showMessage({ message: `รับสินค้าตีกลับ ${returnNo} สำเร็จ` })
      setMatchedOrder(null)
      setTrackingInput('')
      setReason('')
      setNote('')
      setNotFound(false)
      loadRecentReturns()
    } catch (e: any) {
      showMessage({ message: `บันทึกไม่สำเร็จ: ${e.message}` })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="p-3 space-y-3">
      {/* Scan / manual input */}
      <div className="rounded-xl bg-slate-800 border border-slate-700 p-3 space-y-3">
        <div className="text-sm font-bold text-white">สแกนเลขพัสดุ</div>
        <button
          type="button"
          onClick={() => setShowScanner(true)}
          className="w-full py-4 rounded-xl bg-green-600 text-white font-bold text-lg hover:bg-green-700 active:bg-green-800 flex items-center justify-center gap-2"
        >
          <i className="fas fa-camera text-xl" />
          เปิดกล้องสแกน
        </button>
        <div className="flex gap-2">
          <input
            type="text"
            value={trackingInput}
            onChange={(e) => setTrackingInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && lookupTracking(trackingInput)}
            placeholder="หรือพิมพ์เลขพัสดุ..."
            className="flex-1 rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-white placeholder-gray-500"
          />
          <button
            type="button"
            onClick={() => lookupTracking(trackingInput)}
            disabled={searching || !trackingInput.trim()}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-bold disabled:opacity-50"
          >
            {searching ? '...' : 'ค้นหา'}
          </button>
        </div>
      </div>

      {/* Search result */}
      {searching && (
        <div className="flex justify-center py-6">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-400" />
        </div>
      )}

      {notFound && (
        <div className="rounded-xl bg-red-900/30 border border-red-700 p-4 text-center">
          <div className="text-red-400 font-bold text-sm">ไม่พบเลขพัสดุนี้ในระบบ</div>
          <div className="text-xs text-gray-400 mt-1">กรุณาตรวจสอบเลขพัสดุอีกครั้ง</div>
        </div>
      )}

      {matchedOrder && (
        <div className="rounded-xl bg-slate-800 border border-slate-700 p-3 space-y-3">
          <div className="text-sm font-bold text-green-400">พบข้อมูลบิล</div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-gray-400">เลขบิล:</span>
              <div className="font-bold text-white">{matchedOrder.bill_no}</div>
            </div>
            <div>
              <span className="text-gray-400">Tracking:</span>
              <div className="font-bold text-white">{matchedOrder.tracking_number}</div>
            </div>
            <div>
              <span className="text-gray-400">ลูกค้า:</span>
              <div className="font-bold text-white">{matchedOrder.customer_name}</div>
            </div>
            <div>
              <span className="text-gray-400">สถานะ:</span>
              <div className="font-bold text-white">{matchedOrder.status}</div>
            </div>
          </div>

          {/* Items */}
          <div className="space-y-1">
            <div className="text-xs text-gray-400 font-bold">รายการสินค้า ({matchedOrder.items.length})</div>
            {matchedOrder.items.map((item, idx) => (
              <div key={idx} className="flex items-center gap-2 bg-slate-700 rounded-lg px-2.5 py-1.5 text-xs">
                <img
                  src={getProductImageUrl(item.product_code)}
                  alt={item.product_code}
                  className="w-10 h-10 rounded-lg object-cover bg-slate-600 border border-slate-500 shrink-0 cursor-pointer active:scale-95 transition-transform"
                  onClick={() => setLightboxImg(getProductImageUrl(item.product_code))}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                />
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-white truncate">{item.product_code}</div>
                  <div className="text-[10px] text-gray-400 truncate">{item.product_name}</div>
                </div>
                <div className="text-white font-bold ml-2">x{item.qty}</div>
              </div>
            ))}
          </div>

          {/* Reason & Note */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">เหตุผลตีกลับ *</label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-white"
              placeholder="ระบุเหตุผล"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">หมายเหตุ</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-white"
              rows={2}
              placeholder="หมายเหตุเพิ่มเติม (ถ้ามี)"
            />
          </div>

          <button
            type="button"
            onClick={submitReturn}
            disabled={submitting}
            className="w-full py-3 rounded-xl bg-orange-600 text-white font-bold text-base hover:bg-orange-700 active:bg-orange-800 disabled:opacity-50"
          >
            {submitting ? 'กำลังบันทึก...' : 'ยืนยันรับสินค้าตีกลับ'}
          </button>
        </div>
      )}

      {/* Recent returns */}
      <div className="rounded-xl bg-slate-800 border border-slate-700 p-3">
        <div className="text-sm font-bold text-white mb-2">รายการรับตีกลับล่าสุด</div>
        {loadingRecent ? (
          <div className="flex justify-center py-4">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-400" />
          </div>
        ) : recentReturns.length === 0 ? (
          <p className="text-center text-gray-500 text-xs py-4">ยังไม่มีรายการ</p>
        ) : (
          <div className="space-y-1.5 max-h-60 overflow-y-auto">
            {recentReturns.map((r) => (
              <div key={r.id} className="flex items-center justify-between bg-slate-700 rounded-lg px-2.5 py-2 text-xs">
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-white">{r.return_no}</div>
                  <div className="text-[10px] text-gray-400">
                    {r.ref_bill_no || '-'} {r.tracking_number ? `| ${r.tracking_number}` : ''}
                  </div>
                </div>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold text-white ${
                  r.status === 'received' ? 'bg-green-500' : r.status === 'pending' ? 'bg-amber-500' : 'bg-gray-500'
                }`}>
                  {r.status === 'received' ? 'รับแล้ว' : r.status === 'pending' ? 'รอดำเนินการ' : r.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {showScanner && <BarcodeScanner onScan={handleScan} onClose={() => setShowScanner(false)} />}

      {lightboxImg && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          onClick={() => setLightboxImg(null)}
        >
          <div className="relative max-w-[90vw] max-h-[85vh]">
            <button
              type="button"
              onClick={() => setLightboxImg(null)}
              className="absolute -top-3 -right-3 z-10 w-8 h-8 rounded-full bg-slate-700 border border-slate-500 text-white flex items-center justify-center text-sm font-bold hover:bg-red-600 transition-colors"
            >
              ✕
            </button>
            <img
              src={lightboxImg}
              alt="product"
              className="max-w-full max-h-[85vh] rounded-xl object-contain shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        </div>
      )}

      {MessageModal}
      {ConfirmModal}
    </div>
  )
}
