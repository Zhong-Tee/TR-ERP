import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { Order } from '../../types'
import { formatDateTime } from '../../lib/utils'

interface OrderReviewListProps {
  onStatusUpdate?: () => void
}

export default function OrderReviewList({ onStatusUpdate }: OrderReviewListProps) {
  const [orders, setOrders] = useState<Order[]>([])
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState(false)

  useEffect(() => {
    loadOrders()
  }, [])

  async function loadOrders() {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('or_orders')
        .select('*, or_order_items(*)')
        .eq('status', 'ตรวจสอบแล้ว')
        .order('created_at', { ascending: false })

      if (error) throw error
      setOrders(data || [])
      
      // Auto-select first order if available
      if (data && data.length > 0 && !selectedOrder) {
        setSelectedOrder(data[0])
      }
    } catch (error: any) {
      console.error('Error loading orders:', error)
      alert('เกิดข้อผิดพลาดในการโหลดข้อมูล: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleApprove() {
    if (!selectedOrder) return
    
    if (!confirm(`ต้องการยืนยันว่าบิล ${selectedOrder.bill_no} ถูกต้อง และย้ายไปเมนู "ใบสั่งงาน" หรือไม่?`)) {
      return
    }

    setUpdating(true)
    try {
      const { error } = await supabase
        .from('or_orders')
        .update({ status: 'ใบสั่งงาน' })
        .eq('id', selectedOrder.id)

      if (error) throw error

      alert('ยืนยันสำเร็จ บิลถูกย้ายไปเมนู "ใบสั่งงาน" แล้ว')
      
      // Reload orders and select next one
      await loadOrders()
      if (onStatusUpdate) {
        onStatusUpdate()
      }
    } catch (error: any) {
      console.error('Error approving order:', error)
      alert('เกิดข้อผิดพลาด: ' + error.message)
    } finally {
      setUpdating(false)
    }
  }

  async function handleReject() {
    if (!selectedOrder) return
    
    if (!confirm(`ต้องการยืนยันว่าบิล ${selectedOrder.bill_no} มีข้อมูลผิด และย้ายกลับไปเมนู "ลงข้อมูลผิด" หรือไม่?`)) {
      return
    }

    setUpdating(true)
    try {
      const { error } = await supabase
        .from('or_orders')
        .update({ status: 'ลงข้อมูลผิด' })
        .eq('id', selectedOrder.id)

      if (error) throw error

      alert('ยืนยันสำเร็จ บิลถูกย้ายกลับไปเมนู "ลงข้อมูลผิด" แล้ว')
      
      // Reload orders and select next one
      await loadOrders()
      if (onStatusUpdate) {
        onStatusUpdate()
      }
    } catch (error: any) {
      console.error('Error rejecting order:', error)
      alert('เกิดข้อผิดพลาด: ' + error.message)
    } finally {
      setUpdating(false)
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
      </div>
    )
  }

  return (
    <div className="flex gap-6 h-[calc(100vh-200px)]">
      {/* Left Sidebar - Order List */}
      <div className="w-1/3 bg-white rounded-lg shadow overflow-hidden flex flex-col">
        <div className="p-4 border-b bg-gray-50">
          <h2 className="text-lg font-bold">รายการบิล (ตรวจสอบแล้ว)</h2>
          <p className="text-sm text-gray-600 mt-1">{orders.length} รายการ</p>
        </div>
        <div className="flex-1 overflow-y-auto">
          {orders.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              ไม่พบรายการบิล
            </div>
          ) : (
            <div className="divide-y">
              {orders.map((order) => (
                <button
                  key={order.id}
                  onClick={() => setSelectedOrder(order)}
                  className={`w-full p-4 text-left hover:bg-gray-50 transition-colors ${
                    selectedOrder?.id === order.id ? 'bg-blue-50 border-l-4 border-blue-500' : ''
                  }`}
                >
                  <div className="font-semibold text-gray-900">{order.bill_no}</div>
                  <div className="text-sm text-gray-600 mt-1">{order.customer_name}</div>
                  <div className="text-sm font-medium text-green-600 mt-1">
                    ฿{order.total_amount.toLocaleString()}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    {formatDateTime(order.created_at)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right Side - Order Details */}
      <div className="flex-1 bg-white rounded-lg shadow overflow-hidden flex flex-col">
        {selectedOrder ? (
          <>
            <div className="p-6 border-b bg-gray-50 flex-1 overflow-y-auto">
              <h2 className="text-2xl font-bold mb-4">รายละเอียดบิล</h2>
              
              <div className="space-y-4">
                {/* Basic Info */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium text-gray-600">เลขบิล</label>
                    <div className="mt-1 text-lg font-semibold">{selectedOrder.bill_no}</div>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-600">สถานะ</label>
                    <div className="mt-1">
                      <span className="px-2 py-1 bg-green-100 text-green-700 rounded text-sm">
                        {selectedOrder.status}
                      </span>
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-600">ชื่อลูกค้า</label>
                    <div className="mt-1">{selectedOrder.customer_name}</div>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-600">ที่อยู่</label>
                    <div className="mt-1">{selectedOrder.customer_address}</div>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-600">ยอดรวม</label>
                    <div className="mt-1 text-lg font-bold text-green-600">
                      ฿{selectedOrder.total_amount.toLocaleString()}
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-600">วันที่สร้าง</label>
                    <div className="mt-1">{formatDateTime(selectedOrder.created_at)}</div>
                  </div>
                </div>

                {/* Order Items */}
                {selectedOrder.order_items && selectedOrder.order_items.length > 0 && (
                  <div className="mt-6">
                    <h3 className="text-lg font-semibold mb-3">รายการสินค้า</h3>
                    <div className="border rounded-lg overflow-hidden">
                      <table className="w-full">
                        <thead className="bg-gray-100">
                          <tr>
                            <th className="p-3 text-left text-sm font-medium">ชื่อสินค้า</th>
                            <th className="p-3 text-right text-sm font-medium">จำนวน</th>
                            <th className="p-3 text-right text-sm font-medium">ราคา/หน่วย</th>
                            <th className="p-3 text-right text-sm font-medium">รวม</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {selectedOrder.order_items.map((item) => (
                            <tr key={item.id}>
                              <td className="p-3">{item.product_name}</td>
                              <td className="p-3 text-right">{item.quantity}</td>
                              <td className="p-3 text-right">
                                {item.unit_price ? `฿${item.unit_price.toLocaleString()}` : '-'}
                              </td>
                              <td className="p-3 text-right font-medium">
                                {item.unit_price
                                  ? `฿${(item.quantity * item.unit_price).toLocaleString()}`
                                  : '-'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Billing Details */}
                {selectedOrder.billing_details && (
                  <div className="mt-6">
                    <h3 className="text-lg font-semibold mb-3">ข้อมูลเอกสาร</h3>
                    <div className="bg-gray-50 p-4 rounded-lg space-y-2">
                      {selectedOrder.billing_details.request_tax_invoice && (
                        <div className="flex items-center gap-2">
                          <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded text-sm">
                            ขอใบกำกับภาษี
                          </span>
                        </div>
                      )}
                      {selectedOrder.billing_details.request_cash_bill && (
                        <div className="flex items-center gap-2">
                          <span className="px-2 py-1 bg-green-100 text-green-700 rounded text-sm">
                            ขอบิลเงินสด
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Action Buttons */}
            <div className="p-6 border-t bg-gray-50 flex gap-4">
              <button
                onClick={handleReject}
                disabled={updating}
                className="flex-1 px-6 py-3 bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed font-medium transition-colors"
              >
                {updating ? 'กำลังอัพเดต...' : 'ผิด'}
              </button>
              <button
                onClick={handleApprove}
                disabled={updating}
                className="flex-1 px-6 py-3 bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed font-medium transition-colors"
              >
                {updating ? 'กำลังอัพเดต...' : 'ถูกต้อง'}
              </button>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500">
            กรุณาเลือกบิลจากรายการด้านซ้าย
          </div>
        )}
      </div>
    </div>
  )
}
