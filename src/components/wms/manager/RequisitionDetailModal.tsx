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

export default function RequisitionDetailModal({ requisition, onClose }: RequisitionDetailModalProps) {
  const { user } = useAuthContext()
  const [items, setItems] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [approving, setApproving] = useState(false)
  const [selectedPicker, setSelectedPicker] = useState('')
  const [pickers, setPickers] = useState<any[]>([])
  const { showMessage, showConfirm, MessageModal, ConfirmModal } = useWmsModal()

  useEffect(() => {
    loadItems()
    loadPickers()
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

      showMessage({ message: `✅ อนุมัติใบเบิก ${requisition.requisition_id} สำเร็จ!\nมอบหมายให้ Picker แล้ว` })
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
      return 'https://placehold.co/100x100?text=SPARE'
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

  if (requisition.status !== 'pending') {
    return (
      <>
        <Modal open={true} onClose={onClose} closeOnBackdropClick={true} contentClassName="max-w-2xl">
          <div className="bg-slate-800 rounded-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
            <div className="p-4 border-b border-slate-700 flex justify-between items-center">
              <h2 className="text-xl font-black text-white">ใบเบิก: {requisition.requisition_id}</h2>
              <button
                onClick={onClose}
                className="text-red-600 hover:text-red-800 text-3xl font-bold w-12 h-12 flex items-center justify-center rounded-full hover:bg-red-100 transition-all"
              >
                <i className="fas fa-times"></i>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              <div className="text-center py-8 text-gray-400">
                <div className="text-lg font-bold mb-2">สถานะ: {requisition.status === 'approved' ? 'อนุมัติแล้ว' : 'ปฏิเสธแล้ว'}</div>
                {requisition.approved_at && <div className="text-sm">อนุมัติเมื่อ: {formatDate(requisition.approved_at)}</div>}
              </div>
              {loading ? (
                <div className="text-center py-8 text-gray-400">กำลังโหลด...</div>
              ) : (
                <div className="space-y-2">
                  {items.map((item) => (
                    <div key={item.id} className="flex items-center gap-3 p-3 bg-slate-700 rounded-xl">
                      <img
                        src={imgUrl(item.product_code)}
                        className="w-16 h-16 object-cover rounded-lg"
                        onError={(e) => {
                          const target = e.target as HTMLImageElement
                          target.src = 'https://placehold.co/100x100?text=NO+IMG'
                        }}
                        alt={item.product_name}
                      />
                      <div className="flex-1">
                        <div className="font-bold text-white text-sm">{item.product_name}</div>
                        <div className="text-xs text-gray-400">รหัส: {item.product_code}</div>
                        <div className="text-xs text-red-400">จุดเก็บ: {item.location}</div>
                      </div>
                      <div className="text-white font-bold">x{item.qty}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Modal>
        {MessageModal}
        {ConfirmModal}
      </>
    )
  }

  return (
    <>
      <Modal open={true} onClose={onClose} closeOnBackdropClick={true} contentClassName="max-w-2xl">
        <div className="bg-slate-800 rounded-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
          <div className="p-4 border-b border-slate-700 flex justify-between items-center">
            <h2 className="text-xl font-black text-white">ใบเบิก: {requisition.requisition_id}</h2>
            <button
              onClick={onClose}
              className="text-red-600 hover:text-red-800 text-3xl font-bold w-12 h-12 flex items-center justify-center rounded-full hover:bg-red-100 transition-all"
            >
              <i className="fas fa-times"></i>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-6">
            <div className="bg-slate-700 p-4 rounded-xl mb-4">
              <div className="text-sm text-gray-400 mb-1">สร้างโดย</div>
              <div className="font-bold text-white">{requisition.created_by_user?.username || '---'}</div>
              <div className="text-xs text-gray-400 mt-1">{formatDate(requisition.created_at)}</div>
              {requisition.notes && (
                <div className="mt-3 text-base text-gray-300 font-medium break-words">หมายเหตุ: {requisition.notes}</div>
              )}
            </div>

            <div className="mb-4">
              <h3 className="text-sm font-bold text-gray-300 mb-3">รายการสินค้า ({items.length} รายการ)</h3>
              {loading ? (
                <div className="text-center py-8 text-gray-400">กำลังโหลด...</div>
              ) : (
                <div className="space-y-2">
                  {items.map((item, idx) => (
                    <div key={item.id} className="flex items-center gap-3 p-3 bg-slate-700 rounded-xl">
                      <div className="text-lg font-black text-gray-400 w-8 text-center">{idx + 1}</div>
                      <img
                        src={imgUrl(item.product_code)}
                        className="w-16 h-16 object-cover rounded-lg"
                        onError={(e) => {
                          const target = e.target as HTMLImageElement
                          target.src = 'https://placehold.co/100x100?text=NO+IMG'
                        }}
                        alt={item.product_name}
                      />
                      <div className="flex-1">
                        <div className="font-bold text-white text-sm">{item.product_name}</div>
                        <div className="text-xs text-gray-400">รหัส: {item.product_code}</div>
                        <div className="text-xs text-red-400">จุดเก็บ: {item.location}</div>
                      </div>
                      <div className="text-white font-bold text-lg">x{item.qty}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-slate-700 p-4 rounded-xl mb-4">
              <label className="block text-sm font-bold text-gray-300 mb-2">มอบหมายให้ Picker *</label>
              <select
                value={selectedPicker}
                onChange={(e) => setSelectedPicker(e.target.value)}
                className="w-full bg-slate-600 text-white px-4 py-3 rounded-xl border border-slate-500 focus:border-blue-500 focus:outline-none"
              >
                <option value="">-- เลือกพนักงาน Picker --</option>
                {pickers.map((picker) => (
                  <option key={picker.id} value={picker.id}>
                    {picker.username || picker.id}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="p-4 border-t border-slate-700 flex gap-3">
            <button
              onClick={handleReject}
              disabled={approving}
              className="flex-1 bg-red-600 text-white py-3 rounded-xl font-bold hover:bg-red-700 disabled:opacity-50"
            >
              <i className="fas fa-times mr-2"></i>
              ปฏิเสธ
            </button>
            <button
              onClick={handleApprove}
              disabled={approving || !selectedPicker}
              className="flex-1 bg-green-600 text-white py-3 rounded-xl font-bold hover:bg-green-700 disabled:opacity-50"
            >
              {approving ? (
                <>
                  <i className="fas fa-spinner fa-spin mr-2"></i>
                  กำลังอนุมัติ...
                </>
              ) : (
                <>
                  <i className="fas fa-check mr-2"></i>
                  อนุมัติ
                </>
              )}
            </button>
          </div>
        </div>
      </Modal>
      {MessageModal}
      {ConfirmModal}
    </>
  )
}
