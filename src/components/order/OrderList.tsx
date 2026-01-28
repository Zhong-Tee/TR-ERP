import React, { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { Order, OrderStatus } from '../../types'
import { formatDateTime } from '../../lib/utils'

interface OrderListProps {
  status: OrderStatus | OrderStatus[]
  onOrderClick: (order: Order) => void
  searchTerm?: string
  channelFilter?: string
  showBillingStatus?: boolean
  verifiedOnly?: boolean
  onCountChange?: (count: number) => void
}

export default function OrderList({
  status,
  onOrderClick,
  searchTerm = '',
  channelFilter = '',
  showBillingStatus = false,
  verifiedOnly = false,
  onCountChange,
}: OrderListProps) {
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadOrders()
  }, [status, searchTerm, channelFilter, verifiedOnly])

  async function loadOrders() {
    setLoading(true)
    try {
      let query = supabase
        .from('or_orders')
        .select('*, or_order_items(*), or_order_reviews(*)')
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
      
      // กรองข้อมูล verifiedOnly ใน client-side (เพราะ join อาจไม่ทำงานถูกต้อง)
      let filteredData = data || []
      const statusIncludesVerified = Array.isArray(status)
        ? status.includes('ตรวจสอบแล้ว')
        : status === 'ตรวจสอบแล้ว'
      if (verifiedOnly && !statusIncludesVerified) {
        filteredData = filteredData.filter((order: any) => {
          return order.or_order_reviews && 
                 Array.isArray(order.or_order_reviews) &&
                 order.or_order_reviews.some((review: any) => review.status === 'approved')
        })
      }
      
      // Load verification statuses for each order
      const orderIds = filteredData.map((o: any) => o.id)
      if (orderIds.length > 0) {
        const { data: verifiedSlipsData } = await supabase
          .from('ac_verified_slips')
          .select('order_id, account_name_match, bank_code_match, amount_match, validation_status, validation_errors')
          .in('order_id', orderIds)
          .eq('is_deleted', false)
          .order('created_at', { ascending: true })
        
        // Map verification data to orders
        const verifiedMap = new Map()
        if (verifiedSlipsData) {
          verifiedSlipsData.forEach((slip: any) => {
            if (!verifiedMap.has(slip.order_id)) {
              verifiedMap.set(slip.order_id, [])
            }
            verifiedMap.get(slip.order_id).push(slip)
          })
        }
        
        // Add verification data to orders
        filteredData = filteredData.map((order: any) => ({
          ...order,
          verified_slips: verifiedMap.get(order.id) || []
        }))
      }
      
      setOrders(filteredData)
      
      // ส่งจำนวนรายการกลับไปให้ parent component
      if (onCountChange) {
        onCountChange(filteredData.length)
      }
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
              <div className="flex items-center gap-3 mb-2 flex-wrap">
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
                      : order.status === 'ตรวจสอบแล้ว'
                      ? 'bg-blue-100 text-blue-700'
                      : order.status === 'ตรวจสอบไม่ผ่าน' || order.status === 'ตรวจสอบไม่สำเร็จ'
                      ? 'bg-red-100 text-red-700'
                      : 'bg-gray-100 text-gray-700'
                  }`}
                >
                  {order.status}
                </span>
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
                {/* แสดงสถานะการตรวจสลิปในแถวเดียวกัน */}
                {(order.status === 'ตรวจสอบแล้ว' || order.status === 'ตรวจสอบไม่ผ่าน') && 
                 (order as any).verified_slips && 
                 (order as any).verified_slips.length > 0 && (
                  <>
                    {(order as any).verified_slips.map((slip: any, idx: number) => {
                      // Check for duplicate slip status
                      const isDuplicate = slip.validation_errors && 
                        Array.isArray(slip.validation_errors) &&
                        slip.validation_errors.some((err: string) => err.includes('สลิปซ้ำ'))
                      
                      const slipNumber = idx + 1
                      const hasAnyMatch = slip.account_name_match !== null || 
                                        slip.bank_code_match !== null || 
                                        slip.amount_match !== null
                      
                      // ถ้ามีสลิปหลายใบ ให้แสดงเป็นกลุ่มที่ชัดเจน
                      const isMultipleSlips = (order as any).verified_slips.length > 1
                      
                      return (
                        <React.Fragment key={idx}>
                          {hasAnyMatch && (
                            <>
                              {/* แสดงหมายเลขสลิป (เฉพาะเมื่อมีหลายใบ) */}
                              {isMultipleSlips && (
                                <span className="px-2 py-1 bg-gray-200 text-gray-800 rounded text-sm font-semibold border border-gray-300">
                                  ใบที่ {slipNumber}
                                </span>
                              )}
                              {isDuplicate && (
                                <span className="px-2 py-1 bg-orange-100 text-orange-700 rounded text-sm">
                                  สลิปซ้ำ
                                </span>
                              )}
                              {/* แสดงสถานะแต่ละรายการพร้อมหมายเลขสลิป */}
                              <span className={`inline-flex items-center gap-1 px-2 py-1 rounded text-sm ${
                                slip.account_name_match !== null
                                  ? (slip.account_name_match 
                                      ? 'bg-green-100 text-green-700' 
                                      : 'bg-red-100 text-red-700')
                                  : 'bg-gray-100 text-gray-600'
                              }`} title={`สลิปที่ ${slipNumber}: ชื่อบัญชี ${slip.account_name_match === null ? 'ไม่ระบุ' : (slip.account_name_match ? 'ตรง' : 'ไม่ตรง')}`}>
                                {isMultipleSlips && <span className="font-bold">[{slipNumber}]</span>}
                                <span>ชื่อบัญชี</span>
                                {slip.account_name_match !== null && (
                                  <span>{slip.account_name_match ? '✓' : '✗'}</span>
                                )}
                              </span>
                              <span className={`inline-flex items-center gap-1 px-2 py-1 rounded text-sm ${
                                slip.bank_code_match !== null
                                  ? (slip.bank_code_match 
                                      ? 'bg-green-100 text-green-700' 
                                      : 'bg-red-100 text-red-700')
                                  : 'bg-gray-100 text-gray-600'
                              }`} title={`สลิปที่ ${slipNumber}: สาขา ${slip.bank_code_match === null ? 'ไม่ระบุ' : (slip.bank_code_match ? 'ตรง' : 'ไม่ตรง')}`}>
                                {isMultipleSlips && <span className="font-bold">[{slipNumber}]</span>}
                                <span>สาขา</span>
                                {slip.bank_code_match !== null && (
                                  <span>{slip.bank_code_match ? '✓' : '✗'}</span>
                                )}
                              </span>
                              <span className={`inline-flex items-center gap-1 px-2 py-1 rounded text-sm ${
                                slip.amount_match !== null
                                  ? (slip.amount_match 
                                      ? 'bg-green-100 text-green-700' 
                                      : 'bg-red-100 text-red-700')
                                  : 'bg-gray-100 text-gray-600'
                              }`} title={`สลิปที่ ${slipNumber}: ยอดเงิน ${slip.amount_match === null ? 'ไม่ระบุ' : (slip.amount_match ? 'ตรง' : 'ไม่ตรง')}`}>
                                {isMultipleSlips && <span className="font-bold">[{slipNumber}]</span>}
                                <span>ยอดเงิน</span>
                                {slip.amount_match !== null && (
                                  <span>{slip.amount_match ? '✓' : '✗'}</span>
                                )}
                              </span>
                            </>
                          )}
                        </React.Fragment>
                      )
                    })}
                  </>
                )}
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
