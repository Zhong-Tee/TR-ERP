import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { Order } from '../../types'
import { formatDateTime } from '../../lib/utils'
import { useAuthContext } from '../../contexts/AuthContext'
import Modal from '../ui/Modal'

export const ERROR_FIELD_KEYS = [
  { key: 'customer_name', label: 'ชื่อลูกค้า' },
  { key: 'address', label: 'ที่อยู่' },
  { key: 'product_name', label: 'ชื่อสินค้า' },
  { key: 'ink_color', label: 'สีหมึก' },
  { key: 'layer', label: 'ชั้น' },
  { key: 'line_art', label: 'ลายเส้น' },
  { key: 'font', label: 'ฟอนต์' },
  { key: 'line_1', label: 'บรรทัด 1' },
  { key: 'line_2', label: 'บรรทัด 2' },
  { key: 'line_3', label: 'บรรทัด 3' },
] as const

export type ErrorFieldKey = (typeof ERROR_FIELD_KEYS)[number]['key']

interface OrderReviewListProps {
  onStatusUpdate?: () => void
}

export default function OrderReviewList({ onStatusUpdate }: OrderReviewListProps) {
  const { user } = useAuthContext()
  const [orders, setOrders] = useState<Order[]>([])
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState(false)
  const [productImageMap, setProductImageMap] = useState<Record<string, { image_url: string | null; product_name?: string }>>({})
  const [cartoonPatternImageMap, setCartoonPatternImageMap] = useState<Record<string, { image_url: string | null; pattern_name?: string }>>({})
  const [rejectModalOpen, setRejectModalOpen] = useState(false)
  const [approveModalOpen, setApproveModalOpen] = useState(false)
  const [rejectErrorFields, setRejectErrorFields] = useState<Record<string, boolean>>(
    ERROR_FIELD_KEYS.reduce((acc, { key }) => ({ ...acc, [key]: false }), {})
  )
  const [rejectRemarks, setRejectRemarks] = useState('')

  useEffect(() => {
    loadOrders()
  }, [])

  // Load product & cartoon pattern images for selected order items
  useEffect(() => {
    async function loadItemImages() {
      const items: any[] =
        (selectedOrder as any)?.order_items ||
        (selectedOrder as any)?.or_order_items ||
        []

      if (!selectedOrder || items.length === 0) {
        setProductImageMap({})
        setCartoonPatternImageMap({})
        return
      }

      try {
        const productIds = Array.from(
          new Set(items.map((i) => i.product_id).filter(Boolean))
        )
        const cartoonKeys = Array.from(
          new Set(items.map((i) => i.cartoon_pattern).filter(Boolean))
        )

        const [productsRes, patternsRes] = await Promise.all([
          productIds.length > 0
            ? supabase.from('pr_products').select('id, product_name, image_url').in('id', productIds)
            : Promise.resolve({ data: [] as any[] }),
          cartoonKeys.length > 0
            ? supabase.from('cp_cartoon_patterns').select('id, pattern_name, image_url').in('pattern_name', cartoonKeys)
            : Promise.resolve({ data: [] as any[] }),
        ])

        const nextProductMap: Record<string, { image_url: string | null; product_name?: string }> = {}
        ;(productsRes as any)?.data?.forEach((p: any) => {
          nextProductMap[p.id] = { image_url: p.image_url || null, product_name: p.product_name }
        })
        setProductImageMap(nextProductMap)

        const nextPatternMap: Record<string, { image_url: string | null; pattern_name?: string }> = {}
        ;((patternsRes as any)?.data || []).forEach((p: any) => {
          const payload = { image_url: p.image_url || null, pattern_name: p.pattern_name }
          if (p.pattern_name) nextPatternMap[p.pattern_name] = payload
        })
        setCartoonPatternImageMap(nextPatternMap)
      } catch (error) {
        console.error('Error loading item images:', error)
      }
    }

    loadItemImages()
  }, [selectedOrder?.id])

  async function loadOrders(silent = false): Promise<Order[]> {
    if (!silent) setLoading(true)
    try {
      const { data, error } = await supabase
        .from('or_orders')
        .select('*, or_order_items(*)')
        .eq('status', 'ตรวจสอบแล้ว')
        .order('created_at', { ascending: false })

      if (error) throw error
      const list = data || []
      setOrders(list)
      // Auto-select first order if available (เฉพาะตอนโหลดครั้งแรก)
      if (list.length > 0 && !selectedOrder) {
        setSelectedOrder(list[0])
      }
      return list
    } catch (error: any) {
      console.error('Error loading orders:', error)
      alert('เกิดข้อผิดพลาดในการโหลดข้อมูล: ' + error.message)
      return []
    } finally {
      if (!silent) setLoading(false)
    }
  }

  function openApproveModal() {
    if (!selectedOrder) return
    setApproveModalOpen(true)
  }

  async function handleApproveConfirm() {
    if (!selectedOrder) return

    setUpdating(true)
    setApproveModalOpen(false)
    try {
      const { error } = await supabase
        .from('or_orders')
        .update({ status: 'ใบสั่งงาน' })
        .eq('id', selectedOrder.id)

      if (error) throw error

      const newOrders = await loadOrders(true)
      setSelectedOrder(newOrders.length > 0 ? newOrders[0] : null)
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

  function openRejectModal() {
    if (!selectedOrder) return
    setRejectErrorFields(ERROR_FIELD_KEYS.reduce((acc, { key }) => ({ ...acc, [key]: false }), {}))
    setRejectRemarks('')
    setRejectModalOpen(true)
  }

  async function handleRejectSubmit() {
    if (!selectedOrder || !user?.id) return

    const errorFieldsObj: Record<string, boolean> = {}
    ERROR_FIELD_KEYS.forEach(({ key }) => {
      if (rejectErrorFields[key]) errorFieldsObj[key] = true
    })

    setUpdating(true)
    try {
      const { error: orderError } = await supabase
        .from('or_orders')
        .update({ status: 'ลงข้อมูลผิด' })
        .eq('id', selectedOrder.id)

      if (orderError) throw orderError

      const { error: reviewError } = await supabase
        .from('or_order_reviews')
        .upsert(
          {
            order_id: selectedOrder.id,
            reviewed_by: user.id,
            status: 'rejected',
            rejection_reason: rejectRemarks.trim() || null,
            error_fields: Object.keys(errorFieldsObj).length > 0 ? errorFieldsObj : null,
          },
          { onConflict: 'order_id' }
        )

      if (reviewError) throw reviewError

      setRejectModalOpen(false)
      alert('ยืนยันสำเร็จ บิลถูกย้ายกลับไปเมนู "ลงข้อมูลผิด" แล้ว')
      const newOrders = await loadOrders(true)
      setSelectedOrder(newOrders.length > 0 ? newOrders[0] : null)
      if (onStatusUpdate) onStatusUpdate()
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
    <div className="flex flex-col lg:flex-row gap-6 h-[calc(100vh-200px)] text-[12pt]">
      {/* Left Sidebar - Order List */}
      <div className="w-full lg:w-1/2 bg-white rounded-lg shadow overflow-hidden flex flex-col">
        <div className="p-4 border-b bg-gray-50">
          <h2 className="text-lg font-bold">รายการบิล (ตรวจสอบแล้ว)</h2>
          <p className="text-gray-600 mt-1">{orders.length} รายการ</p>
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
                  {/* Row 1: Bill no (left) + Customer name (right) */}
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-semibold text-gray-900">{order.bill_no}</div>
                    <div className="text-gray-700 text-right truncate max-w-[55%]">
                      {order.customer_name}
                    </div>
                  </div>
                  {/* Row 2: Date (left) + Amount (right) */}
                  <div className="flex items-center justify-between gap-3 mt-2">
                    <div className="text-gray-500">
                      {formatDateTime(order.created_at)}
                    </div>
                    <div className="font-semibold text-green-600">
                      ฿{Number(order.total_amount || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right Side - Order Details */}
      <div className="w-full lg:w-1/2 bg-white rounded-lg shadow overflow-hidden flex flex-col">
        {selectedOrder ? (
          <>
            <div className="p-6 border-b bg-gray-50 flex-1 overflow-y-auto">
              <h2 className="text-2xl font-bold mb-4">รายละเอียดบิล</h2>
              
              <div className="space-y-4">
                {/* Basic Info */}
                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <div className="w-28 text-gray-600 font-medium">เลขบิล</div>
                    <div className="text-lg font-semibold">
                      {selectedOrder.bill_no}
                      {(((selectedOrder as any).order_items || (selectedOrder as any).or_order_items) || []).length > 0 && (
                        <span className="text-base font-normal text-gray-600 ml-2">
                          ({(((selectedOrder as any).order_items || (selectedOrder as any).or_order_items) || []).length} รายการ)
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="w-28 text-gray-600 font-medium">สถานะ</div>
                    <div>
                      <span className="px-2 py-1 bg-green-100 text-green-700 rounded">
                        {selectedOrder.status}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <div className="w-28 text-gray-600 font-medium shrink-0">ชื่อลูกค้า</div>
                    <div className="flex-1">{selectedOrder.customer_name}</div>
                  </div>
                  <div className="flex items-start gap-3">
                    <div className="w-28 text-gray-600 font-medium shrink-0">ที่อยู่</div>
                    <div className="flex-1 whitespace-pre-wrap">{selectedOrder.customer_address}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="w-28 text-gray-600 font-medium">วันที่สร้าง</div>
                    <div>{formatDateTime(selectedOrder.created_at)}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="w-28 text-gray-600 font-medium">ยอดรวม</div>
                    <div className="text-lg font-bold text-green-600">
                      ฿{Number(selectedOrder.total_amount || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                  </div>
                </div>

                {/* Order Items */}
                {(((selectedOrder as any).order_items || (selectedOrder as any).or_order_items) || []).length > 0 && (
                  <div className="mt-6">
                    <h3 className="text-lg font-semibold mb-3">รายการสินค้า</h3>
                    <div className="space-y-3">
                      {(((selectedOrder as any).order_items || (selectedOrder as any).or_order_items) || []).map((item: any) => {
                        const product = productImageMap[item.product_id] || null
                        const productImageUrl = product?.image_url || null
                        const patternKey = item.cartoon_pattern || ''
                        const pattern = patternKey ? cartoonPatternImageMap[patternKey] : null
                        const patternImageUrl = pattern?.image_url || null

                        const unitPrice = Number(item.unit_price || 0)
                        const qty = Number(item.quantity || 0)

                        return (
                          <div key={item.id} className="border rounded-lg p-3">
                            <div className="flex gap-4">
                              {/* Images: product (top) + cartoon pattern (bottom) */}
                              <div className="shrink-0 w-28">
                                <div className="w-28 h-28 rounded border bg-gray-50 flex items-center justify-center overflow-hidden">
                                  {productImageUrl ? (
                                    <img
                                      src={productImageUrl}
                                      alt={item.product_name}
                                      className="w-full h-full object-contain"
                                    />
                                  ) : (
                                    <div className="text-gray-400 text-xs text-center px-2">
                                      ไม่มีรูปสินค้า
                                    </div>
                                  )}
                                </div>
                                {item.cartoon_pattern && (
                                  <div className="mt-2">
                                    <div className="w-28 h-28 rounded border bg-gray-50 flex items-center justify-center overflow-hidden">
                                      {patternImageUrl ? (
                                        <img
                                          src={patternImageUrl}
                                          alt={item.cartoon_pattern}
                                          className="w-full h-full object-contain"
                                        />
                                      ) : (
                                        <div className="text-gray-400 text-xs text-center px-2">
                                          ไม่มีรูปลาย
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                )}
                              </div>

                              <div className="flex-1 min-w-0">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="font-semibold text-gray-900 truncate">
                                      {item.product_name}
                                    </div>
                                    {item.cartoon_pattern && (
                                      <div className="text-gray-600 mt-1">
                                        ลายการ์ตูน: <span className="font-medium">{item.cartoon_pattern}</span>
                                      </div>
                                    )}
                                    {/* Extra item details for checking */}
                                    <div className="mt-3 space-y-1 text-gray-700">
                                      <div className="flex gap-3">
                                        <div className="w-24 text-gray-600 font-medium">สีหมึก</div>
                                        <div className="flex-1">{item.ink_color || '-'}</div>
                                      </div>
                                      <div className="flex gap-3">
                                        <div className="w-24 text-gray-600 font-medium">ชั้น</div>
                                        <div className="flex-1">{item.product_type || '-'}</div>
                                      </div>
                                      <div className="flex gap-3">
                                        <div className="w-24 text-gray-600 font-medium">ลายเส้น</div>
                                        <div className="flex-1">{item.line_pattern || '-'}</div>
                                      </div>
                                      <div className="flex gap-3">
                                        <div className="w-24 text-gray-600 font-medium">ฟอนต์</div>
                                        <div className="flex-1">{item.font || '-'}</div>
                                      </div>
                                      <div className="flex gap-3">
                                        <div className="w-24 text-gray-600 font-medium">บรรทัด 1</div>
                                        <div className="flex-1">{item.line_1 || '-'}</div>
                                      </div>
                                      <div className="flex gap-3">
                                        <div className="w-24 text-gray-600 font-medium">บรรทัด 2</div>
                                        <div className="flex-1">{item.line_2 || '-'}</div>
                                      </div>
                                      <div className="flex gap-3">
                                        <div className="w-24 text-gray-600 font-medium">บรรทัด 3</div>
                                        <div className="flex-1">{item.line_3 || '-'}</div>
                                      </div>
                                    </div>
                                  </div>

                                  <div className="text-right shrink-0">
                                    <div className="text-gray-700">
                                      จำนวน: <span className="font-semibold">{qty || '-'}</span>
                                    </div>
                                    <div className="text-gray-700 mt-1">
                                      ราคา/หน่วย:{' '}
                                      <span className="font-semibold">
                                        {unitPrice ? `฿${unitPrice.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '-'}
                                      </span>
                                    </div>
                                  </div>
                                </div>
                                {/* Pattern lookup info (optional) */}
                                {item.cartoon_pattern && (
                                  <div className="mt-2 text-gray-600">
                                    {pattern?.pattern_name ? (
                                      <div>
                                        พบข้อมูลลาย: <span className="font-medium">{pattern.pattern_name}</span>
                                      </div>
                                    ) : (
                                      <div>
                                        ไม่พบข้อมูลลายในระบบ
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        )
                      })}
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
                          <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded">
                            ขอใบกำกับภาษี
                          </span>
                        </div>
                      )}
                      {selectedOrder.billing_details.request_cash_bill && (
                        <div className="flex items-center gap-2">
                          <span className="px-2 py-1 bg-green-100 text-green-700 rounded">
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
                onClick={openRejectModal}
                disabled={updating}
                className="flex-1 px-6 py-3 bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed font-medium transition-colors"
              >
                {updating ? 'กำลังอัพเดต...' : 'ผิด'}
              </button>
              <button
                onClick={openApproveModal}
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

      {/* Approve modal: ยืนยันแค่อันเดียวแล้วย้ายไปใบสั่งงาน */}
      {approveModalOpen && selectedOrder && (
        <Modal
          open
          onClose={() => setApproveModalOpen(false)}
          contentClassName="max-w-md w-full"
        >
          <div className="p-6">
            <h3 className="text-lg font-bold text-gray-900 mb-2">ยืนยันบิลถูกต้อง</h3>
            <p className="text-gray-700 mb-6">
              ต้องการยืนยันว่าบิล <strong>{selectedOrder.bill_no}</strong> ถูกต้อง และย้ายไปเมนู &quot;ใบสั่งงาน&quot; หรือไม่?
            </p>
            <div className="flex gap-3 justify-end">
              <button
                type="button"
                onClick={() => setApproveModalOpen(false)}
                disabled={updating}
                className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={handleApproveConfirm}
                disabled={updating}
                className="px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:opacity-50"
              >
                {updating ? 'กำลังย้าย...' : 'ยืนยัน ย้ายไปใบสั่งงาน'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Reject modal: choose error fields + remarks — ชิดซ้ายเพื่อไม่บังรายละเอียดบิลด้านขวา */}
      {rejectModalOpen && selectedOrder && (
        <Modal
          open
          onClose={() => setRejectModalOpen(false)}
          align="start"
          contentClassName="max-w-md w-full max-h-[90vh] overflow-y-auto"
        >
            <div className="p-6 border-b">
              <h3 className="text-lg font-bold text-gray-900">ลงข้อมูลผิด — เลือกรายการที่ผิด</h3>
              <p className="text-gray-600 mt-1 text-sm">บิล {selectedOrder.bill_no}</p>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-sm font-medium text-gray-700">ติ๊กรายการที่ผิด (แสดงกรอบแดงในฟอร์มแก้ไข):</p>
              <div className="grid grid-cols-1 gap-2">
                {ERROR_FIELD_KEYS.map(({ key, label }) => (
                  <label key={key} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!!rejectErrorFields[key]}
                      onChange={(e) => setRejectErrorFields((prev) => ({ ...prev, [key]: e.target.checked }))}
                      className="rounded border-gray-300 text-red-600 focus:ring-red-500"
                    />
                    <span className="text-gray-800">{label}</span>
                  </label>
                ))}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">หมายเหตุ (ข้อความที่ต้องแก้ไข)</label>
                <textarea
                  value={rejectRemarks}
                  onChange={(e) => setRejectRemarks(e.target.value)}
                  placeholder="ระบุรายละเอียดที่ต้องแก้ไข..."
                  rows={3}
                  className="w-full px-3 py-2 border rounded-lg border-gray-300 focus:ring-2 focus:ring-red-500 focus:border-red-500"
                />
              </div>
            </div>
            <div className="p-6 border-t flex gap-3 justify-end">
              <button
                type="button"
                onClick={() => setRejectModalOpen(false)}
                className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={handleRejectSubmit}
                disabled={updating}
                className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-50"
              >
                {updating ? 'กำลังอัพเดต...' : 'ยืนยัน ย้ายไปลงข้อมูลผิด'}
              </button>
            </div>
        </Modal>
      )}
    </div>
  )
}
