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
  /** ป้องกันคลิกที่รายการแล้วไปแสดงที่ สร้าง/แก้ไข (ใช้กับ ตรวจสอบแล้ว, ยกเลิก) */
  disableOrderClick?: boolean
  /** แสดงปุ่ม "ย้ายไปรอลงข้อมูล" ด้านขวาสุด */
  showMoveToWaitingButton?: boolean
  onMoveToWaiting?: (order: Order) => void | Promise<void>
  /** เปลี่ยนค่าเพื่อให้ list โหลดใหม่ (หลังย้ายสถานะ) */
  refreshTrigger?: number
}

export default function OrderList({
  status,
  onOrderClick,
  searchTerm = '',
  channelFilter = '',
  showBillingStatus = false,
  verifiedOnly = false,
  onCountChange,
  disableOrderClick = false,
  showMoveToWaitingButton = false,
  onMoveToWaiting,
  refreshTrigger = 0,
}: OrderListProps) {
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [movingOrderId, setMovingOrderId] = useState<string | null>(null)

  useEffect(() => {
    loadOrders()
  }, [status, searchTerm, channelFilter, verifiedOnly, refreshTrigger])

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
      // เมนู "ตรวจสอบแล้ว" แสดงทุกบิลที่ status = ตรวจสอบแล้ว (รวมบิลที่ไม่ได้ตรวจสลิปเพราะช่องทางไม่มี bank setting)
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
          .select('order_id, verified_amount, account_name_match, bank_code_match, amount_match, validation_status, validation_errors, easyslip_response')
          .in('order_id', orderIds)
          .eq('is_deleted', false)
          .order('created_at', { ascending: true })
        
        // Map verification data to orders
        const verifiedMap = new Map()
        const orderIdToSlipsTotal = new Map<string, number>()
        if (verifiedSlipsData) {
          verifiedSlipsData.forEach((slip: any) => {
            if (!verifiedMap.has(slip.order_id)) {
              verifiedMap.set(slip.order_id, [])
            }
            verifiedMap.get(slip.order_id).push(slip)
            const prev = orderIdToSlipsTotal.get(slip.order_id) ?? 0
            orderIdToSlipsTotal.set(slip.order_id, prev + (Number(slip.verified_amount) || 0))
          })
        }
        
        // Add verification data and ยอดรวมสลิป (จาก ac_verified_slips ไม่รวมที่ลบ) ต่อ order
        filteredData = filteredData.map((order: any) => {
          const slipsTotal = orderIdToSlipsTotal.get(order.id) ?? null
          const orderTotal = order.total_amount != null ? Number(order.total_amount) : 0
          const amountMatchesFromSlips =
            slipsTotal != null && orderTotal > 0
              ? Math.abs(slipsTotal - orderTotal) <= 0.01
              : null
          return {
            ...order,
            verified_slips: verifiedMap.get(order.id) || [],
            slip_logs_total_amount: slipsTotal,
            slip_logs_amount_matches: amountMatchesFromSlips,
          }
        })

        // Load refunds (โอนเกิน) to show "ตรวจสอบแล้ว (โอนเกิน)"
        const { data: refundsData } = await supabase
          .from('ac_refunds')
          .select('order_id')
          .in('order_id', orderIds)
          .ilike('reason', '%โอนเกิน%')

        const orderIdsWithOverpayRefund = new Set((refundsData || []).map((r: any) => r.order_id))
        filteredData = filteredData.map((order: any) => ({
          ...order,
          has_overpay_refund: orderIdsWithOverpayRefund.has(order.id)
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
          onClick={disableOrderClick ? undefined : () => onOrderClick(order)}
          className={`bg-white p-4 rounded-lg border border-gray-200 transition-all ${
            disableOrderClick ? 'cursor-default' : 'hover:border-blue-500 hover:shadow-md cursor-pointer'
          }`}
        >
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1 min-w-0">
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
                      ? (order as any).has_overpay_refund
                        ? 'bg-amber-100 text-amber-800'
                        : 'bg-blue-100 text-blue-700'
                      : order.status === 'ตรวจสอบไม่ผ่าน' || order.status === 'ตรวจสอบไม่สำเร็จ'
                      ? 'bg-red-100 text-red-700'
                      : 'bg-gray-100 text-gray-700'
                  }`}
                >
                  {order.status === 'ตรวจสอบแล้ว' && (order as any).has_overpay_refund
                    ? 'ตรวจสอบแล้ว (โอนเกิน)'
                    : order.status}
                </span>
                {/* แสดง คำขอใบกำกับภาษี / บิลเงินสด สำหรับสถานะ รอลงข้อมูล, ลงข้อมูลผิด, ตรวจสอบไม่ผ่าน, ตรวจสอบแล้ว */}
                {order.billing_details && (
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
                      // ตรวจว่าสลิปนี้ตรวจจริงจาก EasySlip หรือไม่ — ถ้าไม่ได้เช็คจาก EasySlip ไม่แสดงกล่อง ชื่อบัญชี/สาขา/ยอดเงิน
                      const hasEasySlipVerification = slip.easyslip_response != null
                      // Check for duplicate slip status
                      const isDuplicate = slip.validation_errors && 
                        Array.isArray(slip.validation_errors) &&
                        slip.validation_errors.some((err: string) => err.includes('สลิปซ้ำ'))
                      
                      const slipNumber = idx + 1
                      const isMultipleSlips = (order as any).verified_slips.length > 1
                      const hasAnyMatch = hasEasySlipVerification && (
                        slip.account_name_match !== null ||
                        slip.bank_code_match !== null ||
                        slip.amount_match !== null ||
                        (isMultipleSlips && (order as any).slip_logs_amount_matches !== null)
                      )

                      // ถ้ามีสลิปหลายใบ ใช้ผลรวมจาก ac_slip_verification_logs สำหรับยอดเงิน
                      const amountMatchForDisplay =
                        isMultipleSlips && (order as any).slip_logs_amount_matches !== null
                          ? (order as any).slip_logs_amount_matches
                          : slip.amount_match
                      const amountMatchTitle =
                        isMultipleSlips && (order as any).slip_logs_total_amount != null
                          ? `ยอดรวมสลิป ฿${Number((order as any).slip_logs_total_amount).toLocaleString()} ${(order as any).slip_logs_amount_matches ? 'ตรง' : 'ไม่ตรง'} ยอดออเดอร์`
                          : `สลิปที่ ${slipNumber}: ยอดเงิน ${slip.amount_match === null ? 'ไม่ระบุ' : (slip.amount_match ? 'ตรง' : 'ไม่ตรง')}`

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
                                amountMatchForDisplay !== null
                                  ? (amountMatchForDisplay 
                                      ? 'bg-green-100 text-green-700' 
                                      : 'bg-red-100 text-red-700')
                                  : 'bg-gray-100 text-gray-600'
                              }`} title={amountMatchTitle}>
                                {isMultipleSlips && <span className="font-bold">[{slipNumber}]</span>}
                                <span>ยอดเงิน</span>
                                {amountMatchForDisplay !== null && (
                                  <span>{amountMatchForDisplay ? '✓' : '✗'}</span>
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
              <div className="text-sm text-gray-600 min-w-0">
                <p className="mb-1">
                  <span className="font-medium">ลูกค้า:</span> {order.customer_name}
                </p>
                <p className="mb-1 font-bold">
                  ผู้ลงข้อมูล: {order.admin_user ?? '-'}
                </p>
                {order.tracking_number && (
                  <p>
                    <span className="font-medium">เลขพัสดุ:</span> {order.tracking_number}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <div className="text-right">
                <div
                  className={`text-lg font-bold ${
                    order.status === 'ตรวจสอบไม่ผ่าน' || order.status === 'ตรวจสอบไม่สำเร็จ'
                      ? 'text-red-600'
                      : order.status === 'ตรวจสอบแล้ว'
                      ? 'text-green-600'
                      : 'text-gray-700'
                  }`}
                >
                  ฿{order.total_amount.toLocaleString()}
                </div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {formatDateTime(order.created_at)}
                </div>
              </div>
              {showMoveToWaitingButton && onMoveToWaiting && (
                <button
                  type="button"
                  onClick={async (e) => {
                    e.stopPropagation()
                    if (movingOrderId) return
                    setMovingOrderId(order.id)
                    try {
                      await onMoveToWaiting(order)
                    } finally {
                      setMovingOrderId(null)
                    }
                  }}
                  disabled={movingOrderId === order.id}
                  className="px-3 py-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg whitespace-nowrap"
                >
                  {movingOrderId === order.id ? 'กำลังย้าย...' : 'ย้ายไปรอลงข้อมูล'}
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
