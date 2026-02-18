import { useState, useEffect } from 'react'
import { useAuthContext } from '../../../contexts/AuthContext'
import Modal from '../../ui/Modal'
import { supabase } from '../../../lib/supabase'
import { getProductImageUrl, sortOrderItems } from '../wmsUtils'
import { useWmsModal } from '../useWmsModal'

interface RequisitionDetailModalProps {
  requisition: any
  onClose: () => void
}

const CAN_APPROVE_ROLES = ['superadmin', 'admin']

export default function RequisitionDetailModal({ requisition, onClose }: RequisitionDetailModalProps) {
  const { user } = useAuthContext()
  const [items, setItems] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [createdByUser, setCreatedByUser] = useState<any | null>(null)
  const [approvedByUser, setApprovedByUser] = useState<any | null>(null)
  const [approving, setApproving] = useState(false)
  const [selectedPicker, setSelectedPicker] = useState('')
  const [pickers, setPickers] = useState<any[]>([])
  const { showMessage, showConfirm, MessageModal, ConfirmModal } = useWmsModal()

  const canApprove = CAN_APPROVE_ROLES.includes(user?.role || '') && requisition.status === 'pending'

  useEffect(() => {
    loadItems()
    loadUsers()
    if (canApprove) loadPickers()
  }, [requisition])

  const loadItems = async () => {
    try {
      const { data, error } = await supabase
        .from('wms_requisition_items')
        .select('*')
        .eq('requisition_id', requisition.requisition_id)
        .order('created_at', { ascending: true })

      if (error) throw error

      const sortedItems = sortOrderItems(data || [])
      setItems(sortedItems)
    } catch (error: any) {
      showMessage({ message: `เกิดข้อผิดพลาด: ${error.message}` })
    } finally {
      setLoading(false)
    }
  }

  const loadUsers = async () => {
    try {
      const [createdBy, approvedBy] = await Promise.all([
        requisition.created_by ? supabase.from('us_users').select('username').eq('id', requisition.created_by).single() : Promise.resolve({ data: null }),
        requisition.approved_by ? supabase.from('us_users').select('username').eq('id', requisition.approved_by).single() : Promise.resolve({ data: null }),
      ])
      setCreatedByUser(createdBy.data)
      setApprovedByUser(approvedBy.data)
    } catch (error) {
      console.error('Error loading users:', error)
    }
  }

  const loadPickers = async () => {
    try {
      const { data, error } = await supabase.from('us_users').select('id, username').eq('role', 'picker').order('username')
      if (error) throw error
      setPickers(data || [])
    } catch (error) {
      console.error('Error loading pickers:', error)
    }
  }

  const handleApprove = async () => {
    if (!selectedPicker) {
      showMessage({ message: 'กรุณาเลือกพนักงาน Picker' })
      return
    }

    const ok = await showConfirm({
      title: 'ยืนยันการอนุมัติ',
      message: `ยืนยันการอนุมัติใบเบิก ${requisition.requisition_id}?\nจำนวนรายการ: ${items.length}\nมอบหมายให้: ${
        pickers.find((p) => p.id === selectedPicker)?.username || '-'
      }`,
    })
    if (!ok) return

    setApproving(true)
    try {
      const { error: reqError } = await supabase
        .from('wms_requisitions')
        .update({
          status: 'approved',
          approved_by: user?.id,
          approved_at: new Date().toISOString(),
        })
        .eq('id', requisition.id)

      if (reqError) throw reqError

      const orderData = items.map((item) => ({
        order_id: requisition.requisition_id,
        product_code: item.product_code,
        product_name: item.product_name,
        location: item.location,
        qty: item.qty,
        assigned_to: selectedPicker,
        status: 'pending',
      }))

      const { error: orderError } = await supabase.from('wms_orders').insert(orderData)
      if (orderError) throw orderError

      showMessage({ message: `อนุมัติใบเบิก ${requisition.requisition_id} สำเร็จ!\nมอบหมายให้ Picker แล้ว` })
      onClose()
    } catch (error: any) {
      showMessage({ message: `เกิดข้อผิดพลาด: ${error.message}` })
    } finally {
      setApproving(false)
    }
  }

  const handleReject = async () => {
    const ok = await showConfirm({ title: 'ยืนยันการปฏิเสธ', message: `ยืนยันการปฏิเสธใบเบิก ${requisition.requisition_id}?` })
    if (!ok) return

    setApproving(true)
    try {
      const { error } = await supabase
        .from('wms_requisitions')
        .update({
          status: 'rejected',
          approved_by: user?.id,
          approved_at: new Date().toISOString(),
        })
        .eq('id', requisition.id)

      if (error) throw error

      showMessage({ message: 'ปฏิเสธใบเบิกแล้ว' })
      onClose()
    } catch (error: any) {
      showMessage({ message: `เกิดข้อผิดพลาด: ${error.message}` })
    } finally {
      setApproving(false)
    }
  }

  const imgUrl = (productCode: string) => {
    if (productCode === 'SPARE_PART') {
      return getProductImageUrl('spare_part')
    }
    return getProductImageUrl(productCode)
  }

  const formatDate = (dateString: string) => {
    if (!dateString) return '-'
    const date = new Date(dateString)
    return date.toLocaleString('th-TH', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const getStatusBadge = (status: string) => {
    const badges: Record<string, string> = {
      pending: 'bg-yellow-500 text-yellow-900',
      approved: 'bg-green-500 text-green-900',
      rejected: 'bg-red-500 text-red-900',
    }
    const labels: Record<string, string> = {
      pending: 'รออนุมัติ',
      approved: 'อนุมัติแล้ว',
      rejected: 'ปฏิเสธ',
    }
    return (
      <span className={`inline-block px-3 py-1 rounded-lg text-xs font-bold text-center min-w-[90px] ${badges[status] || 'bg-gray-500'}`}>
        {labels[status] || status}
      </span>
    )
  }

  return (
    <>
      <Modal open={true} onClose={onClose} closeOnBackdropClick={true} contentClassName="max-w-4xl">
        <div className="bg-white rounded-2xl w-full max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
          <div className="p-6 border-b border-gray-200 flex justify-between items-center bg-gradient-to-r from-blue-600 to-blue-700">
            <div>
              <h2 className="text-2xl font-black text-white">ใบเบิก: {requisition.requisition_id}</h2>
              <div className="mt-2">{getStatusBadge(requisition.status)}</div>
            </div>
            <button
              onClick={onClose}
              className="text-white hover:text-red-200 text-3xl font-bold w-12 h-12 flex items-center justify-center rounded-full hover:bg-white/20 transition-all"
              title="ปิดหน้าต่าง (ESC)"
              aria-label="ปิดหน้าต่าง"
            >
              <i className="fas fa-times" style={{ fontSize: '1.5rem', lineHeight: '1' }}></i>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-6 bg-gray-50">
            <div className="bg-white p-6 rounded-xl mb-4 border shadow-sm">
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <div className="text-sm text-gray-500 font-bold uppercase mb-1">ผู้เบิก</div>
                  <div className="font-bold text-slate-800 text-lg">{createdByUser?.username || '---'}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-500 font-bold uppercase mb-1">ผู้อนุมัติ</div>
                  <div className="font-bold text-slate-800 text-lg">{approvedByUser?.username || '-'}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-500 font-bold uppercase mb-1">วันที่ทำรายการ</div>
                  <div className="text-slate-600 text-sm">{formatDate(requisition.created_at)}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-500 font-bold uppercase mb-1">วันที่อนุมัติ</div>
                  <div className="text-slate-600 text-sm">{formatDate(requisition.approved_at)}</div>
                </div>
              </div>
              {requisition.notes && (
                <div className="mt-4 pt-4 border-t">
                  <div className="text-sm text-gray-500 font-bold uppercase mb-2">หมายเหตุ</div>
                  <div className="text-base text-gray-700 font-medium break-words bg-gray-50 p-3 rounded-lg">
                    {requisition.notes}
                  </div>
                </div>
              )}
            </div>

            <div className="bg-white p-6 rounded-xl border shadow-sm">
              <h3 className="text-lg font-black text-slate-800 mb-4">รายการสินค้า ({items.length} รายการ)</h3>
              {loading ? (
                <div className="text-center py-8 text-gray-400">
                  <i className="fas fa-spinner fa-spin text-2xl mb-2"></i>
                  <div>กำลังโหลด...</div>
                </div>
              ) : (
                <div className="space-y-3">
                  {items.map((item, idx) => (
                    <div key={item.id} className="flex items-center gap-4 p-4 bg-gray-50 rounded-xl border hover:bg-blue-50 transition">
                      <div className="text-lg font-black text-gray-400 w-8 text-center shrink-0">{idx + 1}</div>
                      <img
                        src={imgUrl(item.product_code)}
                        className="w-20 h-20 object-cover rounded-lg shrink-0 border-2 border-gray-200"
                        onError={(e) => {
                          const target = e.target as HTMLImageElement
                          target.src = 'https://placehold.co/100x100?text=NO+IMG'
                        }}
                        alt={item.product_name}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-bold text-slate-800 text-base mb-1">{item.product_name}</div>
                        <div className="text-xs text-gray-500 mb-1">รหัส: {item.product_code}</div>
                        <div className="text-xs text-red-600 font-bold">จุดเก็บ: {item.location}</div>
                      </div>
                      <div className="text-slate-800 font-black text-xl shrink-0 bg-blue-100 px-4 py-2 rounded-lg">
                        x{item.qty}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {canApprove && (
              <div className="bg-white p-6 rounded-xl border shadow-sm mt-4">
                <label className="block text-sm font-bold text-gray-700 uppercase mb-2">มอบหมายให้ Picker *</label>
                <select
                  value={selectedPicker}
                  onChange={(e) => setSelectedPicker(e.target.value)}
                  className="w-full bg-gray-50 text-slate-800 px-4 py-3 rounded-xl border border-gray-300 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 transition"
                >
                  <option value="">-- เลือกพนักงาน Picker --</option>
                  {pickers.map((picker) => (
                    <option key={picker.id} value={picker.id}>
                      {picker.username || picker.id}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {canApprove && (
            <div className="p-4 border-t border-gray-200 flex gap-3 bg-white">
              <button
                onClick={handleReject}
                disabled={approving}
                className="flex-1 bg-red-600 text-white py-3 rounded-xl font-bold hover:bg-red-700 disabled:opacity-50 transition"
              >
                <i className="fas fa-times mr-2"></i>
                ปฏิเสธ
              </button>
              <button
                onClick={handleApprove}
                disabled={approving || !selectedPicker}
                className="flex-1 bg-green-600 text-white py-3 rounded-xl font-bold hover:bg-green-700 disabled:opacity-50 transition"
              >
                {approving ? (
                  <>
                    <i className="fas fa-spinner fa-spin mr-2"></i>
                    กำลังดำเนินการ...
                  </>
                ) : (
                  <>
                    <i className="fas fa-check mr-2"></i>
                    อนุมัติ
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      </Modal>
      {MessageModal}
      {ConfirmModal}
    </>
  )
}
