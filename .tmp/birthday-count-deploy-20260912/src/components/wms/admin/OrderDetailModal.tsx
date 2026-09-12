import { useState, useEffect, useCallback } from 'react'
import Modal from '../../ui/Modal'
import { supabase } from '../../../lib/supabase'
import { getProductImageUrl, sortOrderItems, WMS_STATUS_LABELS, WMS_FULFILLMENT_PICK_OR_LEGACY } from '../wmsUtils'
import {
  consolidateCondoStampWmsDisplayRows,
  consolidateDuplicateWmsRows,
  getWmsConsolidatedRowIds,
  getCondoStampDisplayQty,
  getCondoStampLayersLabel,
} from '../../../lib/wmsCondoStampConsolidation'
import { useWmsModal } from '../useWmsModal'
import { useAuthContext } from '../../../contexts/AuthContext'

interface OrderDetailModalProps {
  /** ตัวตนจริงของใบงาน — ต้องใช้กรอง wms_orders ไม่ให้ปนกับใบงานเก่าที่ชื่อซ้ำ */
  workOrderId: string | null
  /** ชื่อแสดง (work_order_name / order_id text) */
  orderDisplayName: string
  onClose: () => void
}

type WmsDetailItem = {
  id: string
  product_name: string
  product_code: string
  location?: string | null
  qty?: number | null
  unit_name?: string | null
  status: string
  created_at?: string | null
  _consolidated_wms_ids?: string[]
  _consolidated_line_count?: number
  _consolidated_statuses?: string[]
}

type VoidAuditRow = {
  id: string
  product_name: string | null
  product_code: string | null
  qty: number
  previous_status: string
  reason: string
  voided_at: string
}

export default function OrderDetailModal({ workOrderId, orderDisplayName, onClose }: OrderDetailModalProps) {
  const [items, setItems] = useState<WmsDetailItem[]>([])
  const [voidHistory, setVoidHistory] = useState<VoidAuditRow[]>([])
  const [voidTarget, setVoidTarget] = useState<{ id: string; _consolidated_wms_ids?: string[]; product_name?: string } | null>(null)
  const [voidReason, setVoidReason] = useState('')
  const [voiding, setVoiding] = useState(false)
  const [loading, setLoading] = useState(true)
  const { user } = useAuthContext()
  const isSuperadmin = user?.role === 'superadmin'
  const { showMessage, MessageModal } = useWmsModal({ showCancelButton: false })

  const loadOrderDetails = useCallback(async () => {
    let q = supabase.from('wms_orders').select('*').or(WMS_FULFILLMENT_PICK_OR_LEGACY).neq('status', 'cancelled')
    if (workOrderId) {
      q = q.eq('work_order_id', workOrderId)
    } else {
      q = q.eq('order_id', orderDisplayName)
    }
    let historyQuery = supabase.from('wms_order_void_audit').select('*').order('voided_at', { ascending: false })
    historyQuery = workOrderId
      ? historyQuery.eq('work_order_id', workOrderId)
      : historyQuery.eq('order_display_name', orderDisplayName)
    const [{ data, error }, { data: historyData, error: historyError }] = await Promise.all([q, historyQuery])

    if (error) {
      console.error('Error fetching order details:', error)
      setLoading(false)
      return
    }

    const sortedData = consolidateCondoStampWmsDisplayRows(sortOrderItems((data || []) as WmsDetailItem[]))
    setItems(consolidateDuplicateWmsRows(sortedData))
    if (!historyError) setVoidHistory((historyData || []) as VoidAuditRow[])
    setLoading(false)
  }, [workOrderId, orderDisplayName])

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadOrderDetails() }, 0)
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleEscape)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [loadOrderDetails, onClose])

  const updateItemStatus = async (row: { id: string; _consolidated_wms_ids?: string[] }, newStatus: string) => {
    const ids = getWmsConsolidatedRowIds(row)
    const { error } = await supabase.from('wms_orders').update({ status: newStatus }).in('id', ids)

    if (error) {
      showMessage({ message: `ไม่สามารถอัปเดตสถานะได้: ${error.message}` })
      return
    }

    loadOrderDetails()
  }

  const voidOrderItem = async () => {
    if (!voidTarget || voidReason.trim().length < 3) return
    setVoiding(true)
    const { error } = await supabase.rpc('rpc_void_wms_orders', {
      p_wms_order_ids: getWmsConsolidatedRowIds(voidTarget),
      p_reason: voidReason.trim(),
    })
    setVoiding(false)

    if (error) {
      showMessage({ message: `ไม่สามารถยกเลิกรายการได้: ${error.message}` })
      return
    }
    setVoidTarget(null)
    setVoidReason('')
    window.dispatchEvent(new CustomEvent('wms-data-changed'))
    loadOrderDetails()
  }

  const statusColorMap: Record<string, string> = {
    pending: 'bg-yellow-100 text-yellow-800 border-yellow-300',
    picked: 'bg-blue-100 text-blue-800 border-blue-300',
    out_of_stock: 'bg-red-100 text-red-800 border-red-300',
    correct: 'bg-green-100 text-green-800 border-green-300',
    wrong: 'bg-red-600 text-white border-red-700',
    not_find: 'bg-orange-100 text-orange-800 border-orange-300',
    mixed: 'bg-slate-200 text-slate-800 border-slate-300',
  }

  const dropdownStatuses = ['pending', 'picked', 'out_of_stock']

  return (
    <>
      <Modal open={true} onClose={onClose} closeOnBackdropClick={true} scrollable={false} contentClassName="max-w-4xl">
        <div className="bg-white w-full max-h-[90vh] rounded-3xl overflow-hidden flex flex-col shadow-2xl">
          <div className="p-6 pr-16 border-b flex items-center bg-slate-50">
            <h3 className="font-black text-xl text-slate-800">รายละเอียดใบงาน: {orderDisplayName}</h3>
          </div>
          <div className="flex-1 overflow-y-auto p-6">
            {loading ? (
              <div className="text-center p-10">กำลังโหลด...</div>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="bg-gray-50 text-[13px] uppercase font-bold">
                  <tr>
                    <th className="p-3">รูป</th>
                    <th className="p-3">สินค้า</th>
                    <th className="p-3">จุดเก็บ</th>
                    <th className="p-3">จำนวน</th>
                    <th className="p-3">สถานะ</th>
                    <th className="p-3 text-center">จัดการ</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {items.map((item) => {
                    const rowKey =
                      item._consolidated_wms_ids && item._consolidated_wms_ids.length > 0
                        ? item._consolidated_wms_ids.join('-')
                        : item.id
                    const currentColorClass = statusColorMap[item.status] || 'bg-gray-100'
                    const isSpareLike =
                      item.product_code === 'SPARE_PART' ||
                      item.location === 'อะไหล่' ||
                      String(item.product_name || '').includes('หน้ายาง+โฟม')
                    const imgUrl =
                      isSpareLike
                        ? getProductImageUrl('spare_part')
                        : getProductImageUrl(item.product_code)
                    const condoLayers = getCondoStampLayersLabel(item)

                    return (
                      <tr key={rowKey}>
                        <td className="p-3">
                          <img
                            src={imgUrl}
                            className="w-10 h-10 rounded shadow-sm"
                            onError={(e) => {
                              const target = e.target as HTMLImageElement
                              target.src = 'https://placehold.co/100x100?text=NO+IMG'
                            }}
                            alt={item.product_name}
                          />
                        </td>
                        <td className="p-3">
                          <div className="font-bold text-slate-700">{item.product_name}</div>
                          <div className="text-[10px] text-gray-400">
                            {isSpareLike ? 'อะไหล่' : item.product_code}
                            {condoLayers ? <span className="ml-1 text-blue-600 font-bold">{condoLayers}</span> : null}
                          </div>
                        </td>
                        <td className="p-3 text-red-600 font-bold">{item.location || '-'}</td>
                        <td className="p-3 text-center font-bold">
                          {getCondoStampDisplayQty(item)} {item.unit_name || 'ชิ้น'}
                          {condoLayers ? ` ${condoLayers}` : ''}
                        </td>
                        <td className="p-3">
                          <select
                            value={item.status}
                            onChange={(e) => updateItemStatus(item, e.target.value)}
                            className={`text-[11px] p-1.5 border rounded-lg font-bold outline-none transition-colors ${currentColorClass}`}
                          >
                            {item.status === 'mixed' && (
                              <option value="mixed" disabled className="bg-white text-slate-800">
                                {WMS_STATUS_LABELS['mixed'] || 'หลายสถานะ'}
                              </option>
                            )}
                            {dropdownStatuses.map((s) => (
                              <option key={s} value={s} className="bg-white text-slate-800">
                                {WMS_STATUS_LABELS[s] || s}
                              </option>
                            ))}
                            {!dropdownStatuses.includes(item.status) && (
                              <option value={item.status} disabled className="bg-white text-slate-800">
                                {WMS_STATUS_LABELS[item.status] || item.status}
                              </option>
                            )}
                          </select>
                        </td>
                        <td className="p-3 text-center">
                          {isSuperadmin ? <button
                            onClick={() => setVoidTarget(item)}
                            className="text-red-600 hover:text-red-800 transition-all hover:scale-125 active:scale-100 p-2 rounded-lg hover:bg-red-50 inline-flex items-center justify-center"
                            title="ยกเลิกรายการ (เก็บประวัติ)"
                            aria-label="ยกเลิกรายการ"
                          ><i className="fas fa-trash-alt" style={{ fontSize: '1.25rem', display: 'block' }}></i></button> : <span className="text-xs text-slate-400">-</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
            {!loading && voidHistory.length > 0 && <div className="mt-8 border-t pt-5">
              <h4 className="mb-3 font-black text-slate-700">ประวัติรายการที่ยกเลิก</h4>
              <div className="overflow-x-auto rounded-xl border border-slate-200"><table className="w-full text-sm"><thead className="bg-slate-100 text-left"><tr><th className="p-3">สินค้า</th><th className="p-3">จำนวน</th><th className="p-3">สถานะเดิม</th><th className="p-3">เหตุผล</th><th className="p-3">เวลา</th></tr></thead><tbody className="divide-y">{voidHistory.map((h) => <tr key={h.id}><td className="p-3"><div className="font-bold">{h.product_name}</div><div className="text-xs text-slate-400">{h.product_code}</div></td><td className="p-3">{h.qty}</td><td className="p-3">{WMS_STATUS_LABELS[h.previous_status] || h.previous_status}</td><td className="p-3">{h.reason}</td><td className="p-3">{new Date(h.voided_at).toLocaleString('th-TH')}</td></tr>)}</tbody></table></div>
            </div>}
          </div>
        </div>
      </Modal>
      <Modal open={!!voidTarget} onClose={() => !voiding && setVoidTarget(null)} contentClassName="max-w-md" stackClassName="z-[70]">
        <div className="p-6">
          <h3 className="text-lg font-black text-red-700">ยกเลิกรายการและเก็บประวัติ</h3>
          <p className="mt-2 text-sm text-slate-600">{voidTarget?.product_name || 'รายการที่เลือก'} หากเคยตัดสต๊อคแล้ว ระบบจะคืนสต๊อคให้อัตโนมัติ</p>
          <label className="mt-4 block text-sm font-bold">เหตุผล <span className="text-red-600">*</span></label>
          <textarea autoFocus value={voidReason} onChange={(e) => setVoidReason(e.target.value)} rows={3} className="mt-1 w-full rounded-xl border p-3" placeholder="ระบุเหตุผลอย่างน้อย 3 ตัวอักษร" />
          <div className="mt-5 flex justify-end gap-2"><button onClick={() => setVoidTarget(null)} disabled={voiding} className="rounded-xl border px-4 py-2 font-bold">ยกเลิก</button><button onClick={voidOrderItem} disabled={voiding || voidReason.trim().length < 3} className="rounded-xl bg-red-600 px-4 py-2 font-bold text-white disabled:opacity-50">{voiding ? 'กำลังดำเนินการ...' : 'ยืนยันยกเลิกรายการ'}</button></div>
        </div>
      </Modal>
      {MessageModal}
    </>
  )
}
