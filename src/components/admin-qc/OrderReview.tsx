import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { Order, OrderReview as OrderReviewType } from '../../types'
import { formatDateTime } from '../../lib/utils'
import { useAuthContext } from '../../contexts/AuthContext'

export default function OrderReview() {
  const { user } = useAuthContext()
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [rejectionReason, setRejectionReason] = useState('')

  useEffect(() => {
    loadPendingOrders()
  }, [])

  async function loadPendingOrders() {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('or_orders')
        .select('*, or_order_items(*)')
        .eq('status', 'รอตรวจคำสั่งซื้อ')
        .order('created_at', { ascending: false })

      if (error) throw error
      setOrders(data || [])
    } catch (error: any) {
      console.error('Error loading orders:', error)
      alert('เกิดข้อผิดพลาดในการโหลดข้อมูล: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  async function approveOrder(order: Order) {
    if (!user) return
    if (!confirm(`ต้องการอนุมัติออเดอร์ ${order.bill_no} หรือไม่?`)) return

    try {
      // Update order status
      const { error: updateError } = await supabase
        .from('or_orders')
        .update({ status: 'ลงข้อมูลเสร็จสิ้น' })
        .eq('id', order.id)

      if (updateError) throw updateError

      // Create review record
      const { error: reviewError } = await supabase
        .from('or_order_reviews')
        .insert({
          order_id: order.id,
          reviewed_by: user.id,
          status: 'approved',
        })

      if (reviewError) throw reviewError

      alert('อนุมัติออเดอร์สำเร็จ')
      loadPendingOrders()
      setSelectedOrder(null)
    } catch (error: any) {
      console.error('Error approving order:', error)
      alert('เกิดข้อผิดพลาด: ' + error.message)
    }
  }

  async function rejectOrder(order: Order) {
    if (!user) return
    if (!rejectionReason.trim()) {
      alert('กรุณากรอกเหตุผลในการปฏิเสธ')
      return
    }
    if (!confirm(`ต้องการปฏิเสธออเดอร์ ${order.bill_no} หรือไม่?`)) return

    try {
      // Update order status
      const { error: updateError } = await supabase
        .from('or_orders')
        .update({ status: 'รอลงข้อมูล' })
        .eq('id', order.id)

      if (updateError) throw updateError

      // Create review record
      const { error: reviewError } = await supabase
        .from('or_order_reviews')
        .insert({
          order_id: order.id,
          reviewed_by: user.id,
          status: 'rejected',
          rejection_reason: rejectionReason,
        })

      if (reviewError) throw reviewError

      alert('ปฏิเสธออเดอร์สำเร็จ')
      loadPendingOrders()
      setSelectedOrder(null)
      setRejectionReason('')
    } catch (error: any) {
      console.error('Error rejecting order:', error)
      alert('เกิดข้อผิดพลาด: ' + error.message)
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">รอตรวจคำสั่งซื้อ</h1>
        <div className="text-sm text-gray-600">
          พบ {orders.length} ออเดอร์ที่รอการตรวจสอบ
        </div>
      </div>

      {orders.length === 0 ? (
        <div className="bg-white p-12 rounded-lg shadow text-center text-gray-500">
          ไม่มีออเดอร์ที่รอการตรวจสอบ
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-4">
            {orders.map((order) => (
              <div
                key={order.id}
                onClick={() => setSelectedOrder(order)}
                className={`bg-white p-4 rounded-lg border-2 cursor-pointer transition-all ${
                  selectedOrder?.id === order.id
                    ? 'border-blue-500 shadow-lg'
                    : 'border-gray-200 hover:border-blue-300'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <strong className="text-blue-600 text-lg">{order.bill_no}</strong>
                  <span className="px-2 py-1 bg-orange-100 text-orange-700 rounded text-sm">
                    รอตรวจคำสั่งซื้อ
                  </span>
                </div>
                <div className="text-sm text-gray-600 space-y-1">
                  <p>
                    <span className="font-medium">ลูกค้า:</span> {order.customer_name}
                  </p>
                  <p>
                    <span className="font-medium">ยอดรวม:</span> ฿
                    {order.total_amount.toLocaleString()}
                  </p>
                  <p>
                    <span className="font-medium">วันที่:</span>{' '}
                    {formatDateTime(order.created_at)}
                  </p>
                </div>
              </div>
            ))}
          </div>

          {selectedOrder && (
            <div className="bg-white p-6 rounded-lg shadow-lg">
              <h2 className="text-2xl font-bold mb-4">รายละเอียดออเดอร์</h2>
              <div className="space-y-4">
                <div>
                  <strong className="text-gray-700">เลขบิล:</strong>{' '}
                  <span className="text-blue-600">{selectedOrder.bill_no}</span>
                </div>
                <div>
                  <strong className="text-gray-700">ช่องทาง:</strong>{' '}
                  {selectedOrder.channel_code}
                </div>
                <div>
                  <strong className="text-gray-700">ลูกค้า:</strong>{' '}
                  {selectedOrder.customer_name}
                </div>
                <div>
                  <strong className="text-gray-700">ที่อยู่:</strong>{' '}
                  {selectedOrder.customer_address}
                </div>
                <div>
                  <strong className="text-gray-700">ยอดรวม:</strong>{' '}
                  <span className="text-green-600 font-bold">
                    ฿{selectedOrder.total_amount.toLocaleString()}
                  </span>
                </div>
                <div>
                  <strong className="text-gray-700">วิธีการชำระ:</strong>{' '}
                  {selectedOrder.payment_method}
                </div>
                {selectedOrder.payment_date && (
                  <div>
                    <strong className="text-gray-700">วันที่ชำระ:</strong>{' '}
                    {selectedOrder.payment_date} {selectedOrder.payment_time}
                  </div>
                )}

                {selectedOrder.order_items && selectedOrder.order_items.length > 0 && (
                  <div>
                    <strong className="text-gray-700 block mb-2">รายการสินค้า:</strong>
                    <div className="border rounded-lg overflow-hidden">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-100">
                          <tr>
                            <th className="p-2 text-left">สินค้า</th>
                            <th className="p-2 text-left">จำนวน</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedOrder.order_items.map((item, idx) => (
                            <tr key={idx} className="border-t">
                              <td className="p-2">{item.product_name}</td>
                              <td className="p-2">{item.quantity}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                <div className="pt-4 border-t space-y-4">
                  <div>
                    <label className="block text-sm font-medium mb-2">
                      เหตุผลในการปฏิเสธ (ถ้าต้องการปฏิเสธ):
                    </label>
                    <textarea
                      value={rejectionReason}
                      onChange={(e) => setRejectionReason(e.target.value)}
                      rows={3}
                      className="w-full px-3 py-2 border rounded-lg"
                      placeholder="กรอกเหตุผล..."
                    />
                  </div>
                  <div className="flex gap-4">
                    <button
                      onClick={() => approveOrder(selectedOrder)}
                      className="flex-1 px-6 py-3 bg-green-500 text-white rounded-lg hover:bg-green-600 font-medium"
                    >
                      ✓ อนุมัติ
                    </button>
                    <button
                      onClick={() => rejectOrder(selectedOrder)}
                      className="flex-1 px-6 py-3 bg-red-500 text-white rounded-lg hover:bg-red-600 font-medium"
                    >
                      ✗ ปฏิเสธ
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
