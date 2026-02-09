import React, { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { Order, OrderStatus } from '../../types'
import { formatDateTime } from '../../lib/utils'
import Modal from '../ui/Modal'

interface OrderListProps {
  /** กรองตามสถานะบิล (ไม่ใช้เมื่อ filterByRejectedOverpayRefund = true) */
  status?: OrderStatus | OrderStatus[]
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
  /** แสดงเฉพาะบิลที่มีรายการโอนคืน (โอนเกิน) ที่ถูกปฏิเสธ — ไม่กรองตาม status */
  filterByRejectedOverpayRefund?: boolean
  /** แสดงปุ่ม "ลบบิล" (สำหรับเมนูรอลงข้อมูล) */
  showDeleteButton?: boolean
  onDelete?: (order: Order) => Promise<void>
  /** กรองวันที่สร้าง (สำหรับเมนูจัดส่งแล้ว) */
  dateFrom?: string
  dateTo?: string
}

export default function OrderList({
  status,
  onOrderClick,
  searchTerm = '',
  channelFilter = '',
  showBillingStatus: _showBillingStatus = false,
  verifiedOnly = false,
  onCountChange,
  disableOrderClick = false,
  showMoveToWaitingButton = false,
  onMoveToWaiting,
  refreshTrigger = 0,
  filterByRejectedOverpayRefund = false,
  showDeleteButton = false,
  onDelete,
  dateFrom = '',
  dateTo = '',
}: OrderListProps) {
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [movingOrderId, setMovingOrderId] = useState<string | null>(null)
  const [deleteConfirmOrder, setDeleteConfirmOrder] = useState<Order | null>(null)
  const [deletingOrderId, setDeletingOrderId] = useState<string | null>(null)

  useEffect(() => {
    loadOrders()
  }, [status, searchTerm, channelFilter, verifiedOnly, refreshTrigger, filterByRejectedOverpayRefund, dateFrom, dateTo])

  async function loadOrders() {
    setLoading(true)
    try {
      let filteredData: any[] = []

      if (filterByRejectedOverpayRefund) {
        // โหลดบิลที่ปฏิเสธโอนคืน: จาก ac_refunds (status=rejected, reason โอนเกิน) แล้วดึง or_orders
        const { data: rejectedData } = await supabase
          .from('ac_refunds')
          .select('order_id')
          .ilike('reason', '%โอนเกิน%')
          .eq('status', 'rejected')
        const orderIds = [...new Set((rejectedData || []).map((r: any) => r.order_id).filter(Boolean))]
        if (orderIds.length === 0) {
          setOrders([])
          if (onCountChange) onCountChange(0)
          setLoading(false)
          return
        }
        let query = supabase
          .from('or_orders')
          .select('*, or_order_items(*), or_order_reviews(*)')
          .in('id', orderIds)
          .order('created_at', { ascending: false })
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
        filteredData = data || []
      } else {
        let query = supabase
          .from('or_orders')
          .select('*, or_order_items(*), or_order_reviews(*)')
          .order('created_at', { ascending: false })

        if (status != null) {
          if (Array.isArray(status)) {
            query = query.in('status', status)
          } else {
            query = query.eq('status', status)
          }
        }

        if (searchTerm) {
          query = query.or(
            `bill_no.ilike.%${searchTerm}%,customer_name.ilike.%${searchTerm}%,tracking_number.ilike.%${searchTerm}%`
          )
        }

        if (channelFilter) {
          query = query.eq('channel_code', channelFilter)
        }
        if (dateFrom) {
          query = query.gte('created_at', `${dateFrom}T00:00:00.000Z`)
        }
        if (dateTo) {
          query = query.lte('created_at', `${dateTo}T23:59:59.999Z`)
        }

        const { data, error } = await query.limit(100)

        if (error) throw error
        filteredData = data || []
      }
      
      // กรองข้อมูล verifiedOnly ใน client-side (เพราะ join อาจไม่ทำงานถูกต้อง)
      // เมนู "ตรวจสอบแล้ว" แสดงทุกบิลที่ status = ตรวจสอบแล้ว (รวมบิลที่ไม่ได้ตรวจสลิปเพราะช่องทางไม่มี bank setting)
      const statusIncludesVerified = status != null && (
        Array.isArray(status) ? status.includes('ตรวจสอบแล้ว') : status === 'ตรวจสอบแล้ว'
      )
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

        // Load refunds ที่ถูกปฏิเสธ (โอนเกิน) เพื่อแสดงป้าย "ปฏิเสธโอนคืน"
        const { data: rejectedRefundsData } = await supabase
          .from('ac_refunds')
          .select('order_id')
          .in('order_id', orderIds)
          .ilike('reason', '%โอนเกิน%')
          .eq('status', 'rejected')

        const orderIdsWithRejectedOverpayRefund = new Set((rejectedRefundsData || []).map((r: any) => r.order_id))

        filteredData = filteredData.map((order: any) => ({
          ...order,
          has_overpay_refund: orderIdsWithOverpayRefund.has(order.id),
          has_rejected_overpay_refund: orderIdsWithRejectedOverpayRefund.has(order.id)
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
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-300"></div>
      </div>
    )
  }

  if (orders.length === 0) {
    return (
      <div className="text-center py-12 text-surface-500">
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
          className={`bg-gray-100 p-5 rounded-2xl border border-gray-200 transition-all ${
            disableOrderClick ? 'cursor-default' : 'hover:border-primary-300 hover:shadow-soft cursor-pointer'
          }`}
        >
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 mb-2 flex-wrap">
                <strong className="text-primary-700 text-xl">{order.bill_no}</strong>
                {(order.claim_type != null || (order.bill_no || '').startsWith('REQ')) && (
                  <span className="px-2.5 py-1 text-xs font-semibold rounded-full bg-accent-200 text-surface-900 border border-accent-300">
                    เคลม
                  </span>
                )}
                <span className="px-2.5 py-1 bg-surface-100 text-surface-700 rounded-full text-sm font-semibold">
                  {order.channel_code}
                </span>
                <span
                  className={`px-2.5 py-1 rounded-full text-sm font-semibold ${
                    order.status === 'ลงข้อมูลเสร็จสิ้น'
                      ? 'bg-secondary-200 text-secondary-900'
                      : order.status === 'รอลงข้อมูล'
                      ? 'bg-accent-200 text-surface-900'
                      : order.status === 'รอตรวจคำสั่งซื้อ'
                      ? 'bg-accent-200 text-surface-900'
                      : order.status === 'ตรวจสอบแล้ว'
                      ? (order as any).has_overpay_refund
                        ? 'bg-accent-200 text-surface-900'
                        : 'bg-primary-100 text-primary-900'
                      : order.status === 'ลงข้อมูลผิด'
                      ? 'bg-accent-200 text-surface-900'
                      : order.status === 'ตรวจสอบไม่ผ่าน' || order.status === 'ตรวจสอบไม่สำเร็จ'
                      ? 'bg-accent-200 text-surface-900'
                      : 'bg-surface-100 text-surface-700'
                  }`}
                >
                  {order.status === 'ตรวจสอบแล้ว' && (order as any).has_overpay_refund
                    ? 'ตรวจสอบแล้ว (โอนเกิน)'
                    : order.status}
                </span>
                {(order as any).has_rejected_overpay_refund && (
                  <span className="px-2.5 py-1 bg-accent-300 text-surface-900 rounded-full text-sm font-semibold">
                    ปฏิเสธโอนคืน
                  </span>
                )}
                {/* แสดง คำขอใบกำกับภาษี / บิลเงินสด สำหรับสถานะ รอลงข้อมูล, ลงข้อมูลผิด, ตรวจสอบไม่ผ่าน, ตรวจสอบแล้ว */}
                {order.billing_details && (
                  <>
                    {order.billing_details.request_tax_invoice && (
                      <span className="px-2.5 py-1 bg-primary-100 text-primary-900 rounded-full text-sm font-semibold">
                        ขอใบกำกับภาษี
                      </span>
                    )}
                    {order.billing_details.request_cash_bill && (
                      <span className="px-2.5 py-1 bg-secondary-200 text-secondary-900 rounded-full text-sm font-semibold">
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
                      const orderTotalAmount = order.total_amount != null ? Number(order.total_amount) : null
                      // เมื่อยอดไม่ตรง แยกว่า ขาด หรือ เกิน (สำหรับป้าย ยอดเงินขาด / ยอดเงินเกิน)
                      let amountMismatchType: 'under' | 'over' | null = null
                      if (amountMatchForDisplay === false && orderTotalAmount != null) {
                        if (isMultipleSlips && (order as any).slip_logs_total_amount != null) {
                          const slipTotal = Number((order as any).slip_logs_total_amount)
                          amountMismatchType = slipTotal < orderTotalAmount ? 'under' : 'over'
                        } else if (slip.verified_amount != null) {
                          const slipAmount = Number(slip.verified_amount)
                          amountMismatchType = slipAmount < orderTotalAmount ? 'under' : 'over'
                        }
                      }
                      const amountLabel =
                        amountMatchForDisplay === true
                          ? 'ยอดเงิน'
                          : amountMismatchType === 'under'
                            ? 'ยอดเงินขาด'
                            : amountMismatchType === 'over'
                              ? 'ยอดเงินเกิน'
                              : 'ยอดเงิน'
                      const amountMatchTitle =
                        isMultipleSlips && (order as any).slip_logs_total_amount != null
                          ? `ยอดรวมสลิป ฿${Number((order as any).slip_logs_total_amount).toLocaleString()} ${(order as any).slip_logs_amount_matches ? 'ตรง' : (amountMismatchType === 'under' ? 'ขาด' : amountMismatchType === 'over' ? 'เกิน' : 'ไม่ตรง')} ยอดออเดอร์`
                          : `สลิปที่ ${slipNumber}: ยอดเงิน ${slip.amount_match === null ? 'ไม่ระบุ' : (slip.amount_match ? 'ตรง' : (amountMismatchType === 'under' ? 'ขาด' : amountMismatchType === 'over' ? 'เกิน' : 'ไม่ตรง'))}`

                      return (
                        <React.Fragment key={idx}>
                          {hasAnyMatch && (
                            <>
                              {/* แสดงหมายเลขสลิป (เฉพาะเมื่อมีหลายใบ) */}
                              {isMultipleSlips && (
                                <span className="px-2.5 py-1 bg-surface-200 text-surface-800 rounded-full text-sm font-semibold border border-surface-300">
                                  ใบที่ {slipNumber}
                                </span>
                              )}
                              {isDuplicate && (
                                <span className="px-2.5 py-1 bg-accent-200 text-surface-900 rounded-full text-sm font-semibold">
                                  สลิปซ้ำ
                                </span>
                              )}
                              {/* แสดงสถานะแต่ละรายการพร้อมหมายเลขสลิป */}
                              <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-sm font-semibold ${
                                slip.account_name_match !== null
                                  ? (slip.account_name_match 
                                      ? 'bg-secondary-200 text-secondary-900' 
                                      : 'bg-accent-200 text-surface-900')
                                  : 'bg-surface-100 text-surface-600'
                              }`} title={`สลิปที่ ${slipNumber}: ชื่อบัญชี ${slip.account_name_match === null ? 'ไม่ระบุ' : (slip.account_name_match ? 'ตรง' : 'ไม่ตรง')}`}>
                                {isMultipleSlips && <span className="font-bold">[{slipNumber}]</span>}
                                <span>ชื่อบัญชี</span>
                                {slip.account_name_match !== null && (
                                  <span>{slip.account_name_match ? '✓' : '✗'}</span>
                                )}
                              </span>
                              <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-sm font-semibold ${
                                slip.bank_code_match !== null
                                  ? (slip.bank_code_match 
                                      ? 'bg-secondary-200 text-secondary-900' 
                                      : 'bg-accent-200 text-surface-900')
                                  : 'bg-surface-100 text-surface-600'
                              }`} title={`สลิปที่ ${slipNumber}: สาขา ${slip.bank_code_match === null ? 'ไม่ระบุ' : (slip.bank_code_match ? 'ตรง' : 'ไม่ตรง')}`}>
                                {isMultipleSlips && <span className="font-bold">[{slipNumber}]</span>}
                                <span>สาขา</span>
                                {slip.bank_code_match !== null && (
                                  <span>{slip.bank_code_match ? '✓' : '✗'}</span>
                                )}
                              </span>
                              <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-sm font-semibold ${
                                amountMatchForDisplay !== null
                                  ? (amountMatchForDisplay 
                                      ? 'bg-secondary-200 text-secondary-900' 
                                      : 'bg-accent-200 text-surface-900')
                                  : 'bg-surface-100 text-surface-600'
                              }`} title={amountMatchTitle}>
                                {isMultipleSlips && <span className="font-bold">[{slipNumber}]</span>}
                                <span>{amountLabel}</span>
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
              <div className="text-base text-surface-600 min-w-0">
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
                  className={`text-xl font-bold ${
                    order.status === 'ตรวจสอบไม่ผ่าน' || order.status === 'ตรวจสอบไม่สำเร็จ'
                      ? 'text-accent-500'
                      : order.status === 'ตรวจสอบแล้ว'
                      ? 'text-secondary-700'
                      : 'text-surface-700'
                  }`}
                >
                  ฿{order.total_amount.toLocaleString()}
                </div>
                <div className="text-sm text-surface-500 mt-0.5">
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
                  className="px-3 py-2.5 bg-accent-200 hover:bg-accent-300 disabled:opacity-50 text-surface-900 text-sm font-semibold rounded-xl whitespace-nowrap"
                >
                  {movingOrderId === order.id ? 'กำลังย้าย...' : 'ย้ายไปรอลงข้อมูล'}
                </button>
              )}
              {showDeleteButton && onDelete && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setDeleteConfirmOrder(order)
                  }}
                  disabled={!!deletingOrderId}
                  className="px-3 py-2.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-semibold rounded-xl whitespace-nowrap"
                >
                  ลบบิล
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
      <Modal
        open={!!deleteConfirmOrder}
        onClose={() => { if (!deletingOrderId) setDeleteConfirmOrder(null) }}
        contentClassName="max-w-md"
      >
        {deleteConfirmOrder && (
          <div className="p-6">
            <h3 className="text-2xl font-semibold text-surface-900 mb-2">ยืนยันลบบิล</h3>
            <p className="text-surface-700 text-base mb-4">
              ต้องการลบบิล <strong>{deleteConfirmOrder.bill_no}</strong> และข้อมูลที่เกี่ยวข้อง (รวมถึงรูปสลิปใน Storage) ใช่หรือไม่? การดำเนินการนี้ไม่สามารถย้อนกลับได้
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteConfirmOrder(null)}
                disabled={!!deletingOrderId}
                className="px-4 py-2 border border-surface-300 rounded-xl hover:bg-surface-100 disabled:opacity-50"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (!onDelete || !deleteConfirmOrder) return
                  setDeletingOrderId(deleteConfirmOrder.id)
                  try {
                    await onDelete(deleteConfirmOrder)
                    setDeleteConfirmOrder(null)
                  } catch (_) {
                    // caller may show error
                  } finally {
                    setDeletingOrderId(null)
                  }
                }}
                disabled={!!deletingOrderId}
                className="px-4 py-2 bg-accent-200 text-surface-900 rounded-xl hover:bg-accent-300 disabled:opacity-50 font-semibold"
              >
                {deletingOrderId ? 'กำลังลบ...' : 'ยืนยันลบ'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
