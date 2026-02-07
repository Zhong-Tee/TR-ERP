import { useState, useEffect } from 'react'
import Modal from '../../ui/Modal'
import { supabase } from '../../../lib/supabase'
import { getProductImageUrl, sortOrderItems, WMS_STATUS_LABELS } from '../wmsUtils'
import { useWmsModal } from '../useWmsModal'

interface OrderDetailModalProps {
  orderId: string
  onClose: () => void
}

export default function OrderDetailModal({ orderId, onClose }: OrderDetailModalProps) {
  const [items, setItems] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const { showMessage, showConfirm, MessageModal, ConfirmModal } = useWmsModal()

  useEffect(() => {
    loadOrderDetails()

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    document.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('keydown', handleEscape)
    }
  }, [orderId, onClose])

  const loadOrderDetails = async () => {
    const { data, error } = await supabase.from('wms_orders').select('*').eq('order_id', orderId)

    if (error) {
      console.error('Error fetching order details:', error)
      setLoading(false)
      return
    }

    const sortedData = sortOrderItems(data || [])
    setItems(sortedData)
    setLoading(false)
  }

  const updateItemStatus = async (id: string, newStatus: string) => {
    const { error } = await supabase.from('wms_orders').update({ status: newStatus }).eq('id', id)

    if (error) {
      showMessage({ message: `ไม่สามารถอัปเดตสถานะได้: ${error.message}` })
      return
    }

    loadOrderDetails()
  }

  const deleteOrderItem = async (id: string) => {
    const ok = await showConfirm({ title: 'ยืนยันการลบ', message: 'ยืนยันการลบรายการนี้หรือไม่?' })
    if (!ok) return

    const { error } = await supabase.from('wms_orders').delete().eq('id', id)

    if (error) {
      showMessage({ message: `ไม่สามารถลบข้อมูลได้: ${error.message}` })
      return
    }

    loadOrderDetails()
  }

  const statusColorMap: Record<string, string> = {
    pending: 'bg-yellow-100 text-yellow-800 border-yellow-300',
    picked: 'bg-blue-100 text-blue-800 border-blue-300',
    out_of_stock: 'bg-red-100 text-red-800 border-red-300',
    correct: 'bg-green-100 text-green-800 border-green-300',
    wrong: 'bg-red-600 text-white border-red-700',
    not_find: 'bg-orange-100 text-orange-800 border-orange-300',
  }

  const dropdownStatuses = ['pending', 'picked', 'out_of_stock']

  return (
    <>
      <Modal open={true} onClose={onClose} closeOnBackdropClick={true} contentClassName="max-w-4xl">
        <div className="bg-white w-full max-h-[90vh] rounded-3xl overflow-hidden flex flex-col shadow-2xl">
          <div className="p-6 border-b flex justify-between items-center bg-slate-50">
            <h3 className="font-black text-xl text-slate-800">รายละเอียดใบงาน: {orderId}</h3>
            <button
              onClick={onClose}
              className="text-red-600 hover:text-red-800 text-3xl font-bold w-12 h-12 flex items-center justify-center rounded-full hover:bg-red-100 transition-all border-2 border-red-400 hover:border-red-600 shadow-md hover:shadow-lg"
              title="ปิดหน้าต่าง (ESC)"
              aria-label="ปิดหน้าต่าง"
            >
              <i className="fas fa-times" style={{ fontSize: '1.5rem', lineHeight: '1' }}></i>
            </button>
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
                    const currentColorClass = statusColorMap[item.status] || 'bg-gray-100'
                    const imgUrl =
                      item.product_code === 'SPARE_PART'
                        ? 'https://placehold.co/100x100?text=SPARE'
                        : getProductImageUrl(item.product_code)

                    return (
                      <tr key={item.id}>
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
                            {item.product_code === 'SPARE_PART' ? 'อะไหล่' : item.product_code}
                          </div>
                        </td>
                        <td className="p-3 text-red-600 font-bold">{item.location || '-'}</td>
                        <td className="p-3 text-center font-bold">{item.qty}</td>
                        <td className="p-3">
                          <select
                            value={item.status}
                            onChange={(e) => updateItemStatus(item.id, e.target.value)}
                            className={`text-[11px] p-1.5 border rounded-lg font-bold outline-none transition-colors ${currentColorClass}`}
                          >
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
                          <button
                            onClick={() => deleteOrderItem(item.id)}
                            className="text-red-600 hover:text-red-800 transition-all hover:scale-125 active:scale-100 p-2 rounded-lg hover:bg-red-50 inline-flex items-center justify-center"
                            title="ลบรายการ"
                            aria-label="ลบรายการ"
                          >
                            <i className="fas fa-trash-alt" style={{ fontSize: '1.25rem', display: 'block' }}></i>
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </Modal>
      {MessageModal}
      {ConfirmModal}
    </>
  )
}
