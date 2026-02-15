import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from '../../lib/supabase'
import { Order } from '../../types'
import { useAuthContext } from '../../contexts/AuthContext'
import { formatDateTime } from '../../lib/utils'
import Modal from '../ui/Modal'
import OrderDetailView from '../order/OrderDetailView'

type ManualSlipRow = {
  id: string
  order_id: string
  bill_no: string | null
  transfer_date: string
  transfer_time: string
  transfer_amount: number
  submitted_by: string
  submitted_at: string
  status: 'pending' | 'approved' | 'rejected'
  reviewed_by: string | null
  reviewed_at: string | null
}

type EditingCell = {
  rowId: string
  field: 'transfer_date' | 'transfer_time' | 'transfer_amount'
} | null

export default function ManualSlipCheckSection() {
  const { user } = useAuthContext()
  const [rows, setRows] = useState<ManualSlipRow[]>([])
  const [loading, setLoading] = useState(true)
  const [filterTab, setFilterTab] = useState<'pending' | 'done'>('pending')

  // Detail view
  const [detailOrder, setDetailOrder] = useState<Order | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  // Slip images for a row
  const [, setSlipImagesOrderId] = useState<string | null>(null)
  const [, setSlipUrls] = useState<string[]>([])
  const [, setSlipUrlsLoading] = useState(false)
  const [zoomImage, setZoomImage] = useState<string | null>(null)

  // Check result
  const [checkResult, setCheckResult] = useState<{ open: boolean; message: string; type: 'success' | 'warning' | 'info' }>({ open: false, message: '', type: 'info' })
  const [checkingId, setCheckingId] = useState<string | null>(null)

  // Approve/Reject popup
  const [actionModal, setActionModal] = useState<{ open: boolean; row: ManualSlipRow | null }>({ open: false, row: null })
  const [actionSubmitting, setActionSubmitting] = useState(false)

  // Inline editing state
  const [editingCell, setEditingCell] = useState<EditingCell>(null)
  const [editValue, setEditValue] = useState<string>('')
  const [editSaving, setEditSaving] = useState(false)
  const editInputRef = useRef<HTMLInputElement>(null)

  // Focus input when entering edit mode
  useEffect(() => {
    if (editingCell && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingCell])

  // Start editing a cell on double-click
  const startEditing = useCallback((rowId: string, field: EditingCell extends null ? never : NonNullable<EditingCell>['field'], currentValue: string | number) => {
    setEditingCell({ rowId, field })
    setEditValue(String(currentValue))
  }, [])

  // Cancel editing
  const cancelEditing = useCallback(() => {
    setEditingCell(null)
    setEditValue('')
  }, [])

  // Save edited value to database
  const saveEdit = useCallback(async () => {
    if (!editingCell || editSaving) return
    const { rowId, field } = editingCell
    const row = rows.find(r => r.id === rowId)
    if (!row) { cancelEditing(); return }

    // Get original value for comparison
    const originalValue = field === 'transfer_amount' ? String(row[field]) : row[field]
    if (editValue.trim() === String(originalValue)) {
      cancelEditing()
      return
    }

    // Validate
    let updateValue: string | number = editValue.trim()
    if (field === 'transfer_date') {
      // Expect YYYY-MM-DD format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(updateValue)) {
        setCheckResult({ open: true, message: 'รูปแบบวันที่ไม่ถูกต้อง (YYYY-MM-DD)', type: 'warning' })
        return
      }
    } else if (field === 'transfer_time') {
      // Expect HH:MM format
      if (!/^\d{2}:\d{2}$/.test(updateValue)) {
        setCheckResult({ open: true, message: 'รูปแบบเวลาไม่ถูกต้อง (HH:MM)', type: 'warning' })
        return
      }
    } else if (field === 'transfer_amount') {
      const num = parseFloat(updateValue)
      if (isNaN(num) || num < 0) {
        setCheckResult({ open: true, message: 'ยอดโอนไม่ถูกต้อง', type: 'warning' })
        return
      }
      updateValue = num
    }

    setEditSaving(true)
    try {
      const { error } = await supabase
        .from('ac_manual_slip_checks')
        .update({ [field]: updateValue })
        .eq('id', rowId)
      if (error) throw error

      // Update local state
      setRows(prev => prev.map(r => r.id === rowId ? { ...r, [field]: updateValue } : r))
      cancelEditing()
    } catch (e: any) {
      setCheckResult({ open: true, message: 'บันทึกไม่สำเร็จ: ' + (e?.message || e), type: 'warning' })
    } finally {
      setEditSaving(false)
    }
  }, [editingCell, editValue, editSaving, rows, cancelEditing])

  useEffect(() => {
    loadRows()
  }, [])

  async function loadRows() {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('ac_manual_slip_checks')
        .select('*')
        .order('submitted_at', { ascending: false })
      if (error) throw error
      setRows((data || []) as ManualSlipRow[])
    } catch (e) {
      console.error('Error loading manual slip checks:', e)
    } finally {
      setLoading(false)
    }
  }

  // Load order detail
  async function handleViewDetail(orderId: string) {
    setDetailLoading(true)
    try {
      const { data, error } = await supabase
        .from('or_orders')
        .select('*, or_order_items(*)')
        .eq('id', orderId)
        .single()
      if (error) throw error
      const order = data as any
      if (order.or_order_items) order.order_items = order.or_order_items
      setDetailOrder(order as Order)
    } catch (e) {
      console.error('Error loading order detail:', e)
    } finally {
      setDetailLoading(false)
    }
  }

  // Load slip images for an order
  // @ts-ignore TS6133 - kept for future use
  async function handleViewSlips(orderId: string) {
    setSlipImagesOrderId(orderId)
    setSlipUrls([])
    setSlipUrlsLoading(true)
    try {
      const { data } = await supabase
        .from('ac_verified_slips')
        .select('slip_image_url, slip_storage_path')
        .eq('order_id', orderId)
        .or('is_deleted.is.null,is_deleted.eq.false')
        .order('created_at', { ascending: true })
      const rows = (data || []) as { slip_image_url?: string; slip_storage_path?: string | null }[]
      const urls: string[] = []
      for (const r of rows) {
        if (r.slip_storage_path) {
          const parts = r.slip_storage_path.split('/')
          const bucket = parts[0] || 'slip-images'
          const filePath = parts.slice(1).join('/')
          const { data: signed } = await supabase.storage.from(bucket).createSignedUrl(filePath, 3600)
          if (signed?.signedUrl) { urls.push(signed.signedUrl); continue }
          const retry = await supabase.storage.from('slip-images').createSignedUrl(filePath || r.slip_storage_path, 3600)
          if (retry.data?.signedUrl) { urls.push(retry.data.signedUrl); continue }
        }
        if (r.slip_image_url) urls.push(r.slip_image_url)
      }
      setSlipUrls(urls)
    } catch (e) {
      console.error('Error loading slips:', e)
    } finally {
      setSlipUrlsLoading(false)
    }
  }

  // เช็คสลิป — check if transfer_date + transfer_time + transfer_amount already exist in ac_verified_slips
  async function handleCheckSlip(row: ManualSlipRow) {
    setCheckingId(row.id)
    try {
      // Check in ac_verified_slips for matching date + amount
      const { data, error } = await supabase
        .from('ac_verified_slips')
        .select('id, order_id, verified_amount, easyslip_date, easyslip_response, or_orders!inner(bill_no)')
        .or('is_deleted.is.null,is_deleted.eq.false')

      if (error) throw error

      const transferAmount = Number(row.transfer_amount)
      const transferDate = row.transfer_date
      const transferTime = row.transfer_time

      // Match: date + time + amount (แปลง easyslip_date เป็นเวลาไทย GMT+7 ก่อนเทียบ)
      const matches = (data || []).filter((slip: any) => {
        if (!slip.easyslip_date) return false
        // แปลงเป็น Date object แล้วแสดงเวลาไทย
        const d = new Date(slip.easyslip_date)
        if (isNaN(d.getTime())) return false
        // ใช้ toLocaleString เพื่อแปลงเป็นเวลาไทย (Asia/Bangkok = UTC+7)
        const thaiDate = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }) // YYYY-MM-DD
        const thaiHours = d.toLocaleString('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false }) // HH:MM
        const slipAmount = Number(slip.verified_amount) || 0
        const dateMatch = thaiDate === transferDate
        const timeMatch = thaiHours === transferTime
        const amountMatch = Math.abs(slipAmount - transferAmount) <= 0.01
        return dateMatch && timeMatch && amountMatch
      })

      if (matches.length > 0) {
        const details = matches.map((m: any) => {
          const billNo = m.or_orders?.bill_no || '-'
          const d = new Date(m.easyslip_date)
          const thaiDate = d.toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', year: 'numeric' })
          const thaiTime = d.toLocaleString('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false })
          const amount = Number(m.verified_amount).toLocaleString('th-TH', { minimumFractionDigits: 2 })
          return `• บิล ${billNo} — วันที่ ${thaiDate} เวลา ${thaiTime} ยอด ฿${amount}`
        }).join('\n')
        setCheckResult({ open: true, message: `พบข้อมูลซ้ำ (${matches.length} รายการ) — สลิปนี้อาจเคยถูกใช้แล้ว\n\n${details}`, type: 'warning' })
      } else {
        setCheckResult({ open: true, message: 'ข้อมูลไม่ซ้ำ — ไม่พบรายการที่ตรงกันในระบบ', type: 'success' })
      }
    } catch (e: any) {
      setCheckResult({ open: true, message: 'ตรวจสอบไม่สำเร็จ: ' + (e?.message || e), type: 'info' })
    } finally {
      setCheckingId(null)
    }
  }

  // Approve or Reject
  async function handleAction(action: 'approved' | 'rejected') {
    if (!actionModal.row) return
    setActionSubmitting(true)
    try {
      // Update the manual slip check status
      const { error: updateErr } = await supabase
        .from('ac_manual_slip_checks')
        .update({
          status: action,
          reviewed_by: user?.username || user?.email || 'unknown',
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', actionModal.row.id)
      if (updateErr) throw updateErr

      // Update the order status based on action
      const newOrderStatus = action === 'approved' ? 'ตรวจสอบแล้ว' : 'ตรวจสอบไม่ผ่าน'
      const { error: orderErr } = await supabase
        .from('or_orders')
        .update({ status: newOrderStatus })
        .eq('id', actionModal.row.order_id)
      if (orderErr) throw orderErr

      setActionModal({ open: false, row: null })
      await loadRows()
      setCheckResult({
        open: true,
        message: action === 'approved' ? 'อนุมัติแล้ว — สถานะบิลเปลี่ยนเป็น "ตรวจสอบแล้ว"' : 'ปฏิเสธแล้ว — สถานะบิลเปลี่ยนเป็น "ตรวจสอบไม่ผ่าน"',
        type: action === 'approved' ? 'success' : 'warning',
      })
    } catch (e: any) {
      setCheckResult({ open: true, message: 'ดำเนินการไม่สำเร็จ: ' + (e?.message || e), type: 'info' })
    } finally {
      setActionSubmitting(false)
    }
  }

  const statusColor = (s: string) => {
    if (s === 'approved') return 'bg-green-100 text-green-700'
    if (s === 'rejected') return 'bg-red-100 text-red-700'
    return 'bg-yellow-100 text-yellow-800'
  }
  const statusLabel = (s: string) => {
    if (s === 'approved') return 'อนุมัติแล้ว'
    if (s === 'rejected') return 'ปฏิเสธแล้ว'
    return 'รอตรวจสอบ'
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-800">ตรวจสลิปมือ</h2>
            <p className="text-sm text-gray-500 mt-0.5">รายการที่ส่งมาจากเมนูออเดอร์ (ตรวจสอบไม่ผ่าน)</p>
          </div>
          <button onClick={loadRows} className="px-3 py-1.5 border rounded-lg text-sm font-semibold text-gray-600 hover:bg-gray-50 transition">
            <i className="fas fa-sync-alt mr-1"></i> รีเฟรช
          </button>
        </div>

        {/* Filter tabs */}
        <div className="px-6 py-3 border-b border-gray-100 flex gap-2">
          <button
            onClick={() => setFilterTab('pending')}
            className={`px-4 py-2 rounded-lg text-sm font-bold transition ${filterTab === 'pending' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            รายการใหม่
            <span className={`ml-1.5 px-1.5 py-0.5 rounded-full text-xs ${filterTab === 'pending' ? 'bg-white/20 text-white' : 'bg-gray-200 text-gray-700'}`}>
              {rows.filter(r => r.status === 'pending').length}
            </span>
          </button>
          <button
            onClick={() => setFilterTab('done')}
            className={`px-4 py-2 rounded-lg text-sm font-bold transition ${filterTab === 'done' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            เสร็จสิ้น
            <span className={`ml-1.5 px-1.5 py-0.5 rounded-full text-xs ${filterTab === 'done' ? 'bg-white/20 text-white' : 'bg-gray-200 text-gray-700'}`}>
              {rows.filter(r => r.status === 'approved' || r.status === 'rejected').length}
            </span>
          </button>
        </div>

        {(() => {
          const filteredRows = filterTab === 'pending'
            ? rows.filter(r => r.status === 'pending')
            : rows.filter(r => r.status === 'approved' || r.status === 'rejected')
          return loading ? (
          <div className="flex justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="text-center py-12 text-gray-400">
            <i className="fas fa-inbox text-4xl mb-3 block"></i>
            <p>{filterTab === 'pending' ? 'ไม่มีรายการใหม่' : 'ไม่มีรายการที่เสร็จสิ้น'}</p>
          </div>
        ) : (
          <div className="divide-y">
            {filteredRows.map((row) => (
              <div key={row.id} className="px-6 py-4 hover:bg-gray-50/50 transition">
                <div className="flex flex-wrap items-start gap-4">
                  {/* Slip thumbnails */}
                  <div className="shrink-0">
                    <SlipThumbnails
                      orderId={row.order_id}
                      onZoom={(url) => setZoomImage(url)}
                    />
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono font-bold text-blue-600 cursor-pointer hover:underline" onClick={() => handleViewDetail(row.order_id)}>
                        {row.bill_no || '-'}
                      </span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${statusColor(row.status)}`}>
                        {statusLabel(row.status)}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-3 text-sm mt-2">
                      <div>
                        <span className="text-gray-500">วันที่โอน:</span>{' '}
                        {editingCell?.rowId === row.id && editingCell.field === 'transfer_date' ? (
                          <input
                            ref={editInputRef}
                            type="date"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={() => saveEdit()}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveEdit()
                              if (e.key === 'Escape') cancelEditing()
                            }}
                            disabled={editSaving}
                            className="inline-block w-[140px] px-1.5 py-0.5 border border-blue-400 rounded text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-blue-300 bg-blue-50"
                          />
                        ) : (
                          <span
                            className="font-semibold cursor-pointer hover:bg-yellow-100 hover:text-yellow-800 px-1 py-0.5 rounded transition select-none"
                            onDoubleClick={() => startEditing(row.id, 'transfer_date', row.transfer_date)}
                            title="ดับเบิ้ลคลิกเพื่อแก้ไข"
                          >
                            {row.transfer_date}
                          </span>
                        )}
                      </div>
                      <div>
                        <span className="text-gray-500">เวลาโอน:</span>{' '}
                        {editingCell?.rowId === row.id && editingCell.field === 'transfer_time' ? (
                          <input
                            ref={editInputRef}
                            type="time"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={() => saveEdit()}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveEdit()
                              if (e.key === 'Escape') cancelEditing()
                            }}
                            disabled={editSaving}
                            className="inline-block w-[100px] px-1.5 py-0.5 border border-blue-400 rounded text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-blue-300 bg-blue-50"
                          />
                        ) : (
                          <span
                            className="font-semibold cursor-pointer hover:bg-yellow-100 hover:text-yellow-800 px-1 py-0.5 rounded transition select-none"
                            onDoubleClick={() => startEditing(row.id, 'transfer_time', row.transfer_time)}
                            title="ดับเบิ้ลคลิกเพื่อแก้ไข"
                          >
                            {row.transfer_time}
                          </span>
                        )}
                      </div>
                      <div>
                        <span className="text-gray-500">ยอดโอน:</span>{' '}
                        {editingCell?.rowId === row.id && editingCell.field === 'transfer_amount' ? (
                          <input
                            ref={editInputRef}
                            type="number"
                            step="0.01"
                            min="0"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={() => saveEdit()}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveEdit()
                              if (e.key === 'Escape') cancelEditing()
                            }}
                            disabled={editSaving}
                            className="inline-block w-[120px] px-1.5 py-0.5 border border-blue-400 rounded text-sm font-bold text-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-300 bg-blue-50"
                          />
                        ) : (
                          <span
                            className="font-bold text-blue-600 cursor-pointer hover:bg-yellow-100 hover:text-yellow-800 px-1 py-0.5 rounded transition select-none"
                            onDoubleClick={() => startEditing(row.id, 'transfer_amount', row.transfer_amount)}
                            title="ดับเบิ้ลคลิกเพื่อแก้ไข"
                          >
                            ฿{Number(row.transfer_amount).toLocaleString('th-TH', { minimumFractionDigits: 2 })}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-xs text-gray-400 mt-1">
                      ส่งโดย: {row.submitted_by} — {formatDateTime(row.submitted_at)}
                      {row.reviewed_by && (
                        <span className="ml-3">| ตรวจโดย: {row.reviewed_by} — {row.reviewed_at ? formatDateTime(row.reviewed_at) : ''}</span>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => handleViewDetail(row.order_id)}
                      className="px-3 py-1.5 border border-gray-300 rounded-lg text-xs font-semibold text-gray-600 hover:bg-gray-50 transition"
                    >
                      <i className="fas fa-eye mr-1"></i> ดูบิล
                    </button>
                    {row.status === 'pending' && (
                      <>
                        <button
                          onClick={() => handleCheckSlip(row)}
                          disabled={checkingId === row.id}
                          className="px-3 py-1.5 bg-sky-500 text-white rounded-lg text-xs font-bold hover:bg-sky-600 transition disabled:opacity-50"
                        >
                          {checkingId === row.id ? (
                            <span className="flex items-center gap-1"><span className="animate-spin rounded-full h-3 w-3 border-b-2 border-white"></span> ตรวจ...</span>
                          ) : (
                            <><i className="fas fa-search mr-1"></i> เช็คสลิป</>
                          )}
                        </button>
                        <button
                          onClick={() => setActionModal({ open: true, row })}
                          className="px-3 py-1.5 bg-green-600 text-white rounded-lg text-xs font-bold hover:bg-green-700 transition"
                        >
                          <i className="fas fa-check-circle mr-1"></i> ยืนยันการโอน
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
        })()}
      </div>

      {/* Order Detail Modal */}
      <Modal open={!!detailOrder} onClose={() => setDetailOrder(null)} contentClassName="max-w-6xl w-full">
        {detailOrder && <OrderDetailView order={detailOrder} onClose={() => setDetailOrder(null)} />}
      </Modal>

      {/* Loading overlay for detail */}
      {detailLoading && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl p-8 flex flex-col items-center gap-3">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-500"></div>
            <p className="text-gray-600 font-semibold">กำลังโหลดข้อมูลบิล...</p>
          </div>
        </div>
      )}

      {/* Zoom image modal */}
      <Modal open={!!zoomImage} onClose={() => setZoomImage(null)} contentClassName="max-w-xl w-full">
        {zoomImage && (
          <div className="p-4">
            <img src={zoomImage} alt="สลิปขยาย" className="max-w-full max-h-[75vh] h-auto mx-auto rounded-lg" />
            <div className="text-center mt-3">
              <button onClick={() => setZoomImage(null)} className="px-4 py-2 border rounded-lg text-sm font-semibold text-gray-600 hover:bg-gray-50">ปิด</button>
            </div>
          </div>
        )}
      </Modal>

      {/* Check result modal */}
      <Modal open={checkResult.open} onClose={() => setCheckResult({ open: false, message: '', type: 'info' })} contentClassName="max-w-lg">
        <div className="p-6 text-center">
          <div className={`text-5xl mb-4 ${checkResult.type === 'success' ? 'text-green-500' : checkResult.type === 'warning' ? 'text-amber-500' : 'text-blue-500'}`}>
            <i className={`fas ${checkResult.type === 'success' ? 'fa-check-circle' : checkResult.type === 'warning' ? 'fa-exclamation-triangle' : 'fa-info-circle'}`}></i>
          </div>
          <p className="text-gray-700 font-semibold mb-4 whitespace-pre-line text-left">{checkResult.message}</p>
          <button
            onClick={() => setCheckResult({ open: false, message: '', type: 'info' })}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700 transition"
          >
            ตกลง
          </button>
        </div>
      </Modal>

      {/* Approve/Reject confirmation modal */}
      <Modal open={actionModal.open} onClose={() => { if (!actionSubmitting) setActionModal({ open: false, row: null }) }} contentClassName="max-w-md">
        {actionModal.row && (
          <div className="p-6">
            <h3 className="text-lg font-bold text-gray-800 mb-2">ยืนยันการตรวจสอบ</h3>
            <p className="text-gray-600 text-sm mb-1">
              บิล <span className="font-mono font-bold text-blue-600">{actionModal.row.bill_no}</span>
            </p>
            <p className="text-gray-600 text-sm mb-4">
              ยอดโอน ฿{Number(actionModal.row.transfer_amount).toLocaleString('th-TH', { minimumFractionDigits: 2 })} — ต้องการดำเนินการอย่างไร?
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setActionModal({ open: false, row: null })}
                disabled={actionSubmitting}
                className="flex-1 px-4 py-2.5 border border-gray-300 rounded-lg font-semibold text-gray-600 hover:bg-gray-50 transition disabled:opacity-50"
              >
                ปิด
              </button>
              <button
                onClick={() => handleAction('rejected')}
                disabled={actionSubmitting}
                className="flex-1 px-4 py-2.5 bg-red-600 text-white rounded-lg font-bold hover:bg-red-700 transition disabled:opacity-50"
              >
                {actionSubmitting ? 'กำลังดำเนินการ...' : 'ปฏิเสธ'}
              </button>
              <button
                onClick={() => handleAction('approved')}
                disabled={actionSubmitting}
                className="flex-1 px-4 py-2.5 bg-green-600 text-white rounded-lg font-bold hover:bg-green-700 transition disabled:opacity-50"
              >
                {actionSubmitting ? 'กำลังดำเนินการ...' : 'อนุมัติ'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

/** Slip thumbnail sub-component — loads slip images inline */
function SlipThumbnails({ orderId, onZoom }: { orderId: string; onZoom: (url: string) => void }) {
  const [urls, setUrls] = useState<string[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true
    async function load() {
      try {
        const { data } = await supabase
          .from('ac_verified_slips')
          .select('slip_image_url, slip_storage_path')
          .eq('order_id', orderId)
          .or('is_deleted.is.null,is_deleted.eq.false')
          .order('created_at', { ascending: true })
        const rows = (data || []) as { slip_image_url?: string; slip_storage_path?: string | null }[]
        const result: string[] = []
        for (const r of rows) {
          if (r.slip_storage_path) {
            const parts = r.slip_storage_path.split('/')
            const bucket = parts[0] || 'slip-images'
            const filePath = parts.slice(1).join('/')
            const { data: signed } = await supabase.storage.from(bucket).createSignedUrl(filePath, 3600)
            if (signed?.signedUrl) { result.push(signed.signedUrl); continue }
          }
          if (r.slip_image_url) result.push(r.slip_image_url)
        }
        if (mounted) setUrls(result)
      } catch (e) {
        console.error('Error loading slip thumbnails:', e)
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [orderId])

  if (loading) return <div className="w-16 h-16 bg-gray-100 rounded-lg animate-pulse"></div>
  if (urls.length === 0) return <div className="w-16 h-16 bg-gray-100 rounded-lg flex items-center justify-center text-gray-400 text-xs">ไม่มี</div>

  return (
    <div className="flex gap-1">
      {urls.map((url, i) => (
        <img
          key={i}
          src={url}
          alt={`สลิป ${i + 1}`}
          className="w-16 h-16 object-cover rounded-lg border cursor-pointer hover:border-blue-400 transition bg-gray-50"
          onClick={() => onZoom(url)}
          onError={(e) => { e.currentTarget.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="64" height="64"%3E%3Crect fill="%23eee" width="64" height="64"/%3E%3Ctext fill="%23999" font-family="sans-serif" font-size="8" x="50%25" y="50%25" text-anchor="middle" dy=".3em"%3E-%3C/text%3E%3C/svg%3E' }}
        />
      ))}
    </div>
  )
}
