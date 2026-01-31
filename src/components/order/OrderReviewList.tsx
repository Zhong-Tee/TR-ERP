import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { Order } from '../../types'
import { formatDateTime } from '../../lib/utils'
import { useAuthContext } from '../../contexts/AuthContext'
import Modal from '../ui/Modal'

export const ERROR_FIELD_KEYS = [
  { key: 'channel_name', label: 'ชื่อช่องทาง' },
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
  { key: 'quantity', label: 'จำนวน' },
  { key: 'unit_price', label: 'ราคา' },
] as const

export type ErrorFieldKey = (typeof ERROR_FIELD_KEYS)[number]['key']

/** ช่องทางที่แสดงฟิลด์ "ชื่อช่องทาง" ในฟอร์ม — แสดงช่องติ๊ก "ชื่อช่องทาง" เฉพาะช่องทางเหล่านี้ */
const CHANNELS_SHOW_CHANNEL_NAME = ['FBTR', 'PUMP', 'OATR', 'SHOP', 'SHOPP', 'INFU', 'PN']

/** แมป ErrorFieldKey ระดับรายการ → ชื่อคอลัมน์ใน pr_category_field_settings */
const ITEM_FIELD_TO_SETTINGS_KEY: Record<Exclude<ErrorFieldKey, 'channel_name' | 'customer_name' | 'address'>, string> = {
  product_name: 'product_name',
  ink_color: 'ink_color',
  layer: 'layer',
  line_art: 'line_pattern',
  font: 'font',
  line_1: 'line_1',
  line_2: 'line_2',
  line_3: 'line_3',
  quantity: 'quantity',
  unit_price: 'unit_price',
}

/** คืนรายการฟิลด์ที่แสดงในตัวเลือก "ลงข้อมูลผิด" ตามฟิลด์ที่ให้กรอก (pr_category_field_settings) เหมือนฟอร์มลงออเดอร์ */
function getVisibleErrorFieldsForOrder(
  order: Order | null,
  categoryFieldSettings: Record<string, Record<string, boolean>>,
  productCategoryByProductId: Record<string, string>
): Array<{ key: ErrorFieldKey; label: string }> {
  if (!order) return []
  const items: any[] = (order as any).order_items || (order as any).or_order_items || []
  const hasItems = items.length > 0

  const channelCode = (order as any).channel_code || ''
  const orderLevel: Array<{ key: ErrorFieldKey; label: string }> = [
    ...(CHANNELS_SHOW_CHANNEL_NAME.includes(channelCode) ? [{ key: 'channel_name' as const, label: 'ชื่อช่องทาง' }] : []),
    { key: 'customer_name', label: 'ชื่อลูกค้า' },
    { key: 'address', label: 'ที่อยู่' },
  ]

  if (!hasItems) return orderLevel

  const itemLevelDef: Array<{ key: ErrorFieldKey; label: string }> = [
    { key: 'product_name', label: 'ชื่อสินค้า' },
    { key: 'ink_color', label: 'สีหมึก' },
    { key: 'layer', label: 'ชั้น' },
    { key: 'line_art', label: 'ลายเส้น' },
    { key: 'font', label: 'ฟอนต์' },
    { key: 'line_1', label: 'บรรทัด 1' },
    { key: 'line_2', label: 'บรรทัด 2' },
    { key: 'line_3', label: 'บรรทัด 3' },
    { key: 'quantity', label: 'จำนวน' },
    { key: 'unit_price', label: 'ราคา' },
  ]

  const hasSettings = Object.keys(categoryFieldSettings).length > 0
  const hasCategoryMap = Object.keys(productCategoryByProductId).length > 0

  if (!hasSettings || !hasCategoryMap) {
    return [...orderLevel, ...itemLevelDef]
  }

  const enabledItemFields = new Set<ErrorFieldKey>()
  for (const def of itemLevelDef) {
    const settingsKey = (ITEM_FIELD_TO_SETTINGS_KEY as Record<ErrorFieldKey, string>)[def.key]
    for (const item of items) {
      const productId = item.product_id != null ? String(item.product_id) : null
      const cat = productId ? productCategoryByProductId[productId] : null
      if (!cat || String(cat).trim() === '') {
        enabledItemFields.add(def.key)
        break
      }
      const categorySettings = categoryFieldSettings[String(cat).trim()]
      if (!categorySettings) {
        enabledItemFields.add(def.key)
        break
      }
      const v = categorySettings[settingsKey] as boolean | string | undefined
      if (v === undefined || v === null || v === true || v === 'true') {
        enabledItemFields.add(def.key)
        break
      }
    }
  }

  const itemLevel = itemLevelDef.filter((def) => enabledItemFields.has(def.key))
  return [...orderLevel, ...itemLevel]
}

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
  const [rejectErrorFields, setRejectErrorFields] = useState<Record<string, boolean>>(
    ERROR_FIELD_KEYS.reduce((acc, { key }) => ({ ...acc, [key]: false }), {})
  )
  const [rejectRemarks, setRejectRemarks] = useState('')
  /** Modal แจ้งเตือน/ผลลัพธ์ (แทน alert): กรุณาติ๊กหรือกรอกหมายเหตุ, ยืนยันสำเร็จ, เกิดข้อผิดพลาด */
  const [messageModal, setMessageModal] = useState<{ open: boolean; title: string; message: string }>({
    open: false,
    title: '',
    message: '',
  })
  /** ตั้งค่าฟิลด์ที่อนุญาตให้กรอกต่อหมวดหมู่ (pr_category_field_settings) — ใช้กรองปุ่มติ๊ก "ลงข้อมูลผิด" */
  const [categoryFieldSettings, setCategoryFieldSettings] = useState<Record<string, Record<string, boolean>>>({})
  /** product_id → product_category สำหรับรายการในบิลที่เลือก (ใช้ร่วมกับ categoryFieldSettings) */
  const [productCategoryByProductId, setProductCategoryByProductId] = useState<Record<string, string>>({})

  useEffect(() => {
    loadOrders()
  }, [])

  // โหลด pr_category_field_settings ครั้งเดียว (เหมือน OrderForm)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { data, error } = await supabase.from('pr_category_field_settings').select('*')
        if (cancelled) return
        if (error) {
          console.error('Error loading category field settings:', error)
          return
        }
        function toBool(v: unknown, defaultVal = true): boolean {
          if (v === undefined || v === null) return defaultVal
          return v === true || v === 'true'
        }
        const settingsMap: Record<string, Record<string, boolean>> = {}
        if (data && Array.isArray(data)) {
          data.forEach((row: any) => {
            const cat = row.category
            if (cat != null && String(cat).trim() !== '') {
              const key = String(cat).trim()
              settingsMap[key] = {
                product_name: toBool(row.product_name, true),
                ink_color: toBool(row.ink_color, true),
                layer: toBool(row.layer, true),
                cartoon_pattern: toBool(row.cartoon_pattern, true),
                line_pattern: toBool(row.line_pattern, true),
                font: toBool(row.font, true),
                line_1: toBool(row.line_1, true),
                line_2: toBool(row.line_2, true),
                line_3: toBool(row.line_3, true),
                quantity: toBool(row.quantity, true),
                unit_price: toBool(row.unit_price, true),
                notes: toBool(row.notes, true),
                attachment: toBool(row.attachment, true),
              }
            }
          })
        }
        setCategoryFieldSettings(settingsMap)
      } catch (e) {
        if (!cancelled) console.error('Error loading category field settings:', e)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Load product & cartoon pattern images + product_category สำหรับ selected order items
  useEffect(() => {
    async function loadItemImages() {
      const items: any[] =
        (selectedOrder as any)?.order_items ||
        (selectedOrder as any)?.or_order_items ||
        []

      if (!selectedOrder || items.length === 0) {
        setProductImageMap({})
        setCartoonPatternImageMap({})
        setProductCategoryByProductId({})
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
            ? supabase.from('pr_products').select('id, product_name, image_url, product_category').in('id', productIds)
            : Promise.resolve({ data: [] as any[] }),
          cartoonKeys.length > 0
            ? supabase.from('cp_cartoon_patterns').select('id, pattern_name, image_url').in('pattern_name', cartoonKeys)
            : Promise.resolve({ data: [] as any[] }),
        ])

        const nextProductMap: Record<string, { image_url: string | null; product_name?: string }> = {}
        const nextCategoryMap: Record<string, string> = {}
        ;(productsRes as any)?.data?.forEach((p: any) => {
          nextProductMap[p.id] = { image_url: p.image_url || null, product_name: p.product_name }
          const cat = p.product_category
          if (cat != null && String(cat).trim() !== '') {
            nextCategoryMap[String(p.id)] = String(cat).trim()
          }
        })
        setProductImageMap(nextProductMap)
        setProductCategoryByProductId(nextCategoryMap)

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

  // รีเซ็ตกล่องติ๊กเมื่อเปลี่ยนบิลที่เลือก
  useEffect(() => {
    if (selectedOrder) {
      setRejectErrorFields(ERROR_FIELD_KEYS.reduce((acc, { key }) => ({ ...acc, [key]: false }), {}))
      setRejectRemarks('')
    }
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

  async function handleApproveConfirm() {
    if (!selectedOrder) return

    setUpdating(true)
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

  async function handleRejectSubmit() {
    if (!selectedOrder || !user?.id) return

    const hasAnyChecked = ERROR_FIELD_KEYS.some(({ key }) => !!rejectErrorFields[key])
    const hasRemarks = (rejectRemarks || '').trim().length > 0
    if (!hasAnyChecked && !hasRemarks) {
      setMessageModal({
        open: true,
        title: 'กรุณาระบุรายการที่ผิด',
        message:
          'กรุณาติ๊กเลือกรายการที่ผิด หรือกรอกหมายเหตุ (ข้อความที่ต้องแก้ไข) อย่างน้อยหนึ่งอย่าง',
      })
      return
    }

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

      setMessageModal({
        open: true,
        title: 'ยืนยันสำเร็จ',
        message: 'บิลถูกย้ายกลับไปเมนู "ลงข้อมูลผิด" แล้ว',
      })
      const newOrders = await loadOrders(true)
      setSelectedOrder(newOrders.length > 0 ? newOrders[0] : null)
      if (onStatusUpdate) onStatusUpdate()
    } catch (error: any) {
      console.error('Error rejecting order:', error)
      setMessageModal({
        open: true,
        title: 'เกิดข้อผิดพลาด',
        message: error?.message || 'เกิดข้อผิดพลาด',
      })
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
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 h-[calc(100vh-200px)] text-[12pt] min-h-0">
      {/* การ์ดซ้าย - รายการบิล */}
      <div className="bg-white rounded-lg shadow overflow-hidden flex flex-col min-h-0">
        <div className="p-4 border-b bg-gray-50 shrink-0">
          <h2 className="text-lg font-bold">รายการบิล</h2>
          <p className="text-gray-600 mt-1 text-sm">{orders.length} รายการ</p>
        </div>
        <div className="flex-1 overflow-y-auto min-h-0 flex flex-col">
          {orders.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-gray-500 p-6 text-center min-h-0">
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
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-semibold text-gray-900">{order.bill_no}</div>
                    <div className="text-gray-700 text-right truncate max-w-[55%] text-sm">
                      {order.customer_name}
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3 mt-2">
                    <div className="text-gray-500 text-sm">
                      {formatDateTime(order.created_at)}
                    </div>
                    <div className="font-semibold text-green-600 text-sm">
                      ฿{Number(order.total_amount || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* การ์ดกลาง - รายละเอียดบิล */}
      <div className="bg-white rounded-lg shadow overflow-hidden flex flex-col min-h-0">
        {selectedOrder ? (
          <>
            <div className="p-4 border-b bg-gray-50 shrink-0">
              <h2 className="text-lg font-bold">รายละเอียดบิล</h2>
              <p className="text-gray-600 mt-1 text-sm min-h-[1.25rem]">&nbsp;</p>
            </div>
            <div className="flex-1 overflow-y-auto p-4 min-h-0">
              <div className="space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <div className="w-24 text-gray-600 font-medium text-sm shrink-0">เลขบิล</div>
                    <div className="text-base font-semibold">
                      {selectedOrder.bill_no}
                      {(((selectedOrder as any).order_items || (selectedOrder as any).or_order_items) || []).length > 0 && (
                        <span className="text-gray-600 font-normal ml-2 text-sm">
                          ({(((selectedOrder as any).order_items || (selectedOrder as any).or_order_items) || []).length} รายการ)
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="w-24 text-gray-600 font-medium text-sm shrink-0">สถานะ</div>
                    <div>
                      <span className="px-2 py-1 bg-green-100 text-green-700 rounded text-sm">
                        {selectedOrder.status}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <div className="w-24 text-gray-600 font-medium text-sm shrink-0">ชื่อช่องทาง</div>
                    <div className="flex-1 text-sm">{selectedOrder.customer_name}</div>
                  </div>
                  <div className="flex items-start gap-3">
                    <div className="w-24 text-gray-600 font-medium text-sm shrink-0">ชื่อลูกค้า</div>
                    <div className="flex-1 text-sm">{(selectedOrder as Order & { recipient_name?: string | null }).recipient_name ?? selectedOrder.customer_name ?? '—'}</div>
                  </div>
                  <div className="flex items-start gap-3">
                    <div className="w-24 text-gray-600 font-medium text-sm shrink-0">ที่อยู่</div>
                    <div className="flex-1 whitespace-pre-wrap text-sm">{selectedOrder.customer_address}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="w-24 text-gray-600 font-medium text-sm shrink-0">วันที่สร้าง</div>
                    <div className="text-sm">{formatDateTime(selectedOrder.created_at)}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="w-24 text-gray-600 font-medium text-sm shrink-0">ยอดรวม</div>
                    <div className="text-base font-bold text-green-600">
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
                                        <div className="w-24 text-gray-600 font-medium">ชื่อ ไม่รับชื่อ</div>
                                        <div className="flex-1">{item.no_name_line ? '✓' : '-'}</div>
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
                                      <div className="flex gap-3">
                                        <div className="w-24 text-gray-600 font-medium">หมายเหตุ</div>
                                        <div className="flex-1">{item.no_name_line ? ('ไม่รับชื่อ' + (item.notes ? ' ' + item.notes : '')) : (item.notes || '-')}</div>
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
                    <h3 className="text-base font-semibold mb-2">ข้อมูลเอกสาร</h3>
                    <div className="bg-gray-50 p-3 rounded-lg space-y-2 text-sm">
                      {selectedOrder.billing_details.request_tax_invoice && (
                        <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded">ขอใบกำกับภาษี</span>
                      )}
                      {selectedOrder.billing_details.request_cash_bill && (
                        <span className="px-2 py-1 bg-green-100 text-green-700 rounded">ขอบิลเงินสด</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-col flex-1 min-h-0">
            <div className="p-4 border-b bg-gray-50 shrink-0">
              <h2 className="text-lg font-bold">รายละเอียดบิล</h2>
              <p className="text-gray-600 mt-1 text-sm min-h-[1.25rem]">&nbsp;</p>
            </div>
            <div className="flex-1 flex items-center justify-center text-gray-500 p-6 text-center">
              กรุณาเลือกบิลจากรายการด้านซ้าย
            </div>
          </div>
        )}
      </div>

      {/* การ์ดขวา - การตรวจสอบ */}
      <div className="bg-white rounded-lg shadow overflow-hidden flex flex-col min-h-0">
        <div className="p-4 border-b bg-gray-50 shrink-0">
          <h2 className="text-lg font-bold">การตรวจสอบ</h2>
          <p className="text-gray-600 mt-1 text-sm min-h-[1.25rem]">&nbsp;</p>
        </div>
        {selectedOrder ? (
          <>
            <div className="flex-1 overflow-y-auto p-4 min-h-0">
              <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg">
                <h3 className="text-sm font-semibold text-amber-900 mb-2">ลงข้อมูลผิด — เลือกรายการที่ผิด</h3>
                <p className="text-xs text-amber-800 mb-3">แสดงกรอบแดงในฟอร์มแก้ไข</p>
                <div className="grid grid-cols-1 gap-2 mb-3">
                  {getVisibleErrorFieldsForOrder(selectedOrder, categoryFieldSettings, productCategoryByProductId).map(({ key, label }) => (
                    <label key={key} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!!rejectErrorFields[key]}
                        onChange={(e) => setRejectErrorFields((prev) => ({ ...prev, [key]: e.target.checked }))}
                        className="rounded border-gray-300 text-red-600 focus:ring-red-500"
                      />
                      <span className="text-gray-800 text-sm">{label}</span>
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
                    className="w-full px-3 py-2 border rounded-lg border-gray-300 focus:ring-2 focus:ring-amber-500 focus:border-amber-500 text-sm"
                  />
                </div>
              </div>
            </div>
            <div className="p-4 border-t bg-gray-50 flex flex-col gap-3 shrink-0">
              <button
                onClick={() => handleRejectSubmit()}
                disabled={updating}
                className="w-full px-6 py-3 bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed font-medium transition-colors"
              >
                {updating ? 'กำลังอัพเดต...' : 'ผิด'}
              </button>
              <button
                onClick={() => handleApproveConfirm()}
                disabled={updating}
                className="w-full px-6 py-3 bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed font-medium transition-colors"
              >
                {updating ? 'กำลังอัพเดต...' : 'ถูกต้อง'}
              </button>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-500 p-6 text-center">
            กรุณาเลือกบิลจากรายการด้านซ้าย
          </div>
        )}
      </div>

      {/* Modal แจ้งเตือน/ผลลัพธ์ (แทน alert) */}
      <Modal
        open={messageModal.open}
        onClose={() => setMessageModal((prev) => ({ ...prev, open: false }))}
        contentClassName="max-w-md"
      >
        <div className="p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-2">{messageModal.title}</h3>
          <p className="text-gray-700 text-sm whitespace-pre-wrap">{messageModal.message}</p>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => setMessageModal((prev) => ({ ...prev, open: false }))}
              className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
            >
              ตกลง
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
