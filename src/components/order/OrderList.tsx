import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { Order, OrderStatus } from '../../types'
import { formatDateTime } from '../../lib/utils'

interface OrderListProps {
  status: OrderStatus | OrderStatus[]
  onOrderClick: (order: Order) => void
  searchTerm?: string
  channelFilter?: string
<<<<<<< HEAD
  showBillingStatus?: boolean
  verifiedOnly?: boolean
  onCountChange?: (count: number) => void
=======
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
}

export default function OrderList({
  status,
  onOrderClick,
  searchTerm = '',
  channelFilter = '',
<<<<<<< HEAD
  showBillingStatus = false,
  verifiedOnly = false,
  onCountChange,
=======
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
}: OrderListProps) {
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadOrders()
<<<<<<< HEAD
  }, [status, searchTerm, channelFilter, verifiedOnly])
=======
  }, [status, searchTerm, channelFilter])
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208

  async function loadOrders() {
    setLoading(true)
    try {
      let query = supabase
        .from('or_orders')
<<<<<<< HEAD
        .select('*, or_order_items(*), or_order_reviews(*)')
=======
        .select('*, or_order_items(*)')
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
        .order('created_at', { ascending: false })

      if (Array.isArray(status)) {
        query = query.in('status', status)
      } else {
        query = query.eq('status', status)
      }

      if (searchTerm) {
        query = query.or(
          `bill_no.ilike.%${searchTerm}%,customer_name.ilike.%${searchTerm}%,tracking_number.ilike.%${searchTerm}%`
        )
      }

      if (channelFilter) {
        query = query.eq('channel_code', channelFilter)
      }

      const { data, error } = await query.limit(100)

      if (error) throw error
<<<<<<< HEAD
      
      // กรองข้อมูล verifiedOnly ใน client-side (เพราะ join อาจไม่ทำงานถูกต้อง)
      let filteredData = data || []
      if (verifiedOnly) {
        filteredData = filteredData.filter((order: any) => {
          return order.or_order_reviews && 
                 Array.isArray(order.or_order_reviews) &&
                 order.or_order_reviews.some((review: any) => review.status === 'approved')
        })
      }
      
      setOrders(filteredData)
      
      // ส่งจำนวนรายการกลับไปให้ parent component
      if (onCountChange) {
        onCountChange(filteredData.length)
      }
=======
      setOrders(data || [])
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
    } catch (error: any) {
      console.error('Error loading orders:', error)
      alert('เกิดข้อผิดพลาดในการโหลดข้อมูล: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    )
  }

  if (orders.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        ไม่พบข้อมูลออเดอร์
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {orders.map((order) => (
        <div
          key={order.id}
          onClick={() => onOrderClick(order)}
          className="bg-white p-4 rounded-lg border border-gray-200 hover:border-blue-500 hover:shadow-md cursor-pointer transition-all"
        >
          <div className="flex items-center justify-between">
            <div className="flex-1">
<<<<<<< HEAD
              <div className="flex items-center gap-3 mb-2 flex-wrap">
=======
              <div className="flex items-center gap-3 mb-2">
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
                <strong className="text-blue-600 text-lg">{order.bill_no}</strong>
                <span className="px-2 py-1 bg-gray-100 text-gray-700 rounded text-sm">
                  {order.channel_code}
                </span>
                <span
                  className={`px-2 py-1 rounded text-sm ${
                    order.status === 'ลงข้อมูลเสร็จสิ้น'
                      ? 'bg-green-100 text-green-700'
                      : order.status === 'รอลงข้อมูล'
                      ? 'bg-yellow-100 text-yellow-700'
                      : order.status === 'รอตรวจคำสั่งซื้อ'
                      ? 'bg-orange-100 text-orange-700'
                      : 'bg-gray-100 text-gray-700'
                  }`}
                >
                  {order.status}
                </span>
<<<<<<< HEAD
                {showBillingStatus && order.billing_details && (
                  <>
                    {order.billing_details.request_tax_invoice && (
                      <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded text-sm">
                        ขอใบกำกับภาษี
                      </span>
                    )}
                    {order.billing_details.request_cash_bill && (
                      <span className="px-2 py-1 bg-green-100 text-green-700 rounded text-sm">
                        ขอบิลเงินสด
                      </span>
                    )}
                  </>
                )}
=======
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
              </div>
              <div className="text-sm text-gray-600">
                <p className="mb-1">
                  <span className="font-medium">ลูกค้า:</span> {order.customer_name}
                </p>
                {order.tracking_number && (
                  <p>
                    <span className="font-medium">เลขพัสดุ:</span> {order.tracking_number}
                  </p>
                )}
              </div>
            </div>
            <div className="text-right">
              <div className="text-lg font-bold text-green-600">
                ฿{order.total_amount.toLocaleString()}
              </div>
              <div className="text-xs text-gray-500">
                {formatDateTime(order.created_at)}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
