import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../lib/supabase'
import { getPublicUrl } from '../../lib/qcApi'
import { Order } from '../../types'
import { formatDateTime } from '../../lib/utils'
import { useAuthContext } from '../../contexts/AuthContext'
import Modal from '../ui/Modal'

const PRODUCT_IMAGES_BUCKET = 'product-images'

export const ERROR_FIELD_KEYS = [
  { key: 'channel_name', label: 'ชื่อช่องทาง' },
  { key: 'customer_name', label: 'ชื่อลูกค้า' },
  { key: 'address', label: 'ที่อยู่' },
  { key: 'channel_order_no', label: 'เลขคำสั่งซื้อ' },
  { key: 'tracking_number', label: 'เลขพัสดุ' },
  { key: 'product_name', label: 'ชื่อสินค้า' },
  { key: 'ink_color', label: 'สีหมึก' },
  { key: 'layer', label: 'ชั้น' },
  { key: 'cartoon_pattern', label: 'ลายการ์ตูน' },
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
/** ช่องทางที่แสดงเลขคำสั่งซื้อ + เลขพัสดุ แทนที่ ชื่อลูกค้า + ที่อยู่ ในระดับบิล */
const CHANNELS_ORDER_NO = ['SPTR', 'FSPTR', 'LZTR', 'TTTR']

/** แมป ErrorFieldKey ระดับรายการ → ชื่อคอลัมน์ใน pr_category_field_settings */
const ITEM_FIELD_TO_SETTINGS_KEY: Record<Exclude<ErrorFieldKey, 'channel_name' | 'customer_name' | 'address' | 'channel_order_no' | 'tracking_number'>, string> = {
  product_name: 'product_name',
  ink_color: 'ink_color',
  layer: 'layer',
  cartoon_pattern: 'cartoon_pattern',
  line_art: 'line_pattern',
  font: 'font',
  line_1: 'line_1',
  line_2: 'line_2',
  line_3: 'line_3',
  quantity: 'quantity',
  unit_price: 'unit_price',
}

const ITEM_LEVEL_DEF: Array<{ key: ErrorFieldKey; label: string }> = [
  { key: 'product_name', label: 'ชื่อสินค้า' },
  { key: 'ink_color', label: 'สีหมึก' },
  { key: 'layer', label: 'ชั้น' },
  { key: 'cartoon_pattern', label: 'ลายการ์ตูน' },
  { key: 'line_art', label: 'ลายเส้น' },
  { key: 'font', label: 'ฟอนต์' },
  { key: 'line_1', label: 'บรรทัด 1' },
  { key: 'line_2', label: 'บรรทัด 2' },
  { key: 'line_3', label: 'บรรทัด 3' },
  { key: 'quantity', label: 'จำนวน' },
  { key: 'unit_price', label: 'ราคา' },
]

/** คืนฟิลด์ที่แสดงสำหรับ item เดียว โดยดู product override ก่อน แล้ว fallback ไปหมวดหมู่ */
function getVisibleFieldsForItem(
  item: any,
  categoryFieldSettings: Record<string, Record<string, boolean>>,
  productCategoryByProductId: Record<string, string>,
  productFieldOverrides?: Record<string, Record<string, boolean | null>>
): Set<ErrorFieldKey> {
  const enabled = new Set<ErrorFieldKey>()
  const hasSettings = Object.keys(categoryFieldSettings).length > 0
  const hasOverrides = productFieldOverrides && Object.keys(productFieldOverrides).length > 0
  const productId = item.product_id != null ? String(item.product_id) : null

  if (!hasSettings && !hasOverrides) {
    ITEM_LEVEL_DEF.forEach((d) => enabled.add(d.key))
    return enabled
  }

  for (const def of ITEM_LEVEL_DEF) {
    const settingsKey = (ITEM_FIELD_TO_SETTINGS_KEY as Record<ErrorFieldKey, string>)[def.key]

    // 1. ตรวจ product-level override ก่อน
    if (productId && hasOverrides) {
      const overrides = productFieldOverrides![productId]
      if (overrides) {
        const ov = overrides[settingsKey]
        if (ov !== undefined && ov !== null) {
          if (ov === true) enabled.add(def.key)
          continue
        }
      }
    }

    // 2. Fallback ไปดูหมวดหมู่
    const cat = productId ? productCategoryByProductId[productId] : null
    if (!cat || String(cat).trim() === '') {
      enabled.add(def.key)
      continue
    }
    const catSettings = categoryFieldSettings[String(cat).trim()]
    if (!catSettings) {
      enabled.add(def.key)
      continue
    }
    const v = catSettings[settingsKey] as boolean | string | undefined
    if (v === undefined || v === null || v === true || v === 'true') {
      enabled.add(def.key)
    }
  }
  return enabled
}

/** คืนรายการฟิลด์ที่แสดงในตัวเลือก "ลงข้อมูลผิด" ตามฟิลด์ที่ให้กรอก (pr_category_field_settings + product override) เหมือนฟอร์มลงออเดอร์ */
function getVisibleErrorFieldsForOrder(
  order: Order | null,
  categoryFieldSettings: Record<string, Record<string, boolean>>,
  productCategoryByProductId: Record<string, string>,
  productFieldOverrides?: Record<string, Record<string, boolean | null>>
): Array<{ key: ErrorFieldKey; label: string }> {
  if (!order) return []
  const items: any[] = (order as any).order_items || (order as any).or_order_items || []
  const hasItems = items.length > 0

  const channelCode = (order as any).channel_code || ''
  const orderLevel: Array<{ key: ErrorFieldKey; label: string }> = CHANNELS_ORDER_NO.includes(channelCode)
    ? [
        { key: 'channel_order_no', label: 'เลขคำสั่งซื้อ' },
        { key: 'tracking_number', label: 'เลขพัสดุ' },
      ]
    : [
        ...(CHANNELS_SHOW_CHANNEL_NAME.includes(channelCode) ? [{ key: 'channel_name' as const, label: 'ชื่อช่องทาง' }] : []),
        { key: 'customer_name', label: 'ชื่อลูกค้า' },
        { key: 'address', label: 'ที่อยู่' },
      ]

  if (!hasItems) return orderLevel

  // รวมฟิลด์จากทุก item (union) — ใช้สำหรับ order-level aggregation
  const enabledItemFields = new Set<ErrorFieldKey>()
  for (const item of items) {
    const perItem = getVisibleFieldsForItem(item, categoryFieldSettings, productCategoryByProductId, productFieldOverrides)
    perItem.forEach((k) => enabledItemFields.add(k))
  }

  const itemLevel = ITEM_LEVEL_DEF.filter((def) => enabledItemFields.has(def.key))
  return [...orderLevel, ...itemLevel]
}

/** ฟิลด์ระดับบิล (ไม่แยกรายการ) */
const ORDER_LEVEL_KEYS: ErrorFieldKey[] = ['channel_name', 'customer_name', 'address', 'channel_order_no', 'tracking_number']

/** แยกรายการฟิลด์ที่แสดงเป็นระดับบิล vs ระดับรายการ */
function getOrderLevelAndItemLevelErrorFields(
  order: Order | null,
  categoryFieldSettings: Record<string, Record<string, boolean>>,
  productCategoryByProductId: Record<string, string>,
  productFieldOverrides?: Record<string, Record<string, boolean | null>>
): { orderLevel: Array<{ key: ErrorFieldKey; label: string }>; itemLevel: Array<{ key: ErrorFieldKey; label: string }> } {
  const allFields = getVisibleErrorFieldsForOrder(order, categoryFieldSettings, productCategoryByProductId, productFieldOverrides)
  const channelCode = (order as any)?.channel_code || ''
  // สำหรับช่องทาง SPTR, FSPTR, LZTR, TTTR: ย้าย unit_price ไประดับบิล (ไม่ได้กรอกราคา/หน่วยต่อรายการ)
  const effectiveOrderKeys: ErrorFieldKey[] = CHANNELS_ORDER_NO.includes(channelCode)
    ? [...ORDER_LEVEL_KEYS, 'unit_price']
    : ORDER_LEVEL_KEYS
  const orderLevel = allFields.filter((f) => effectiveOrderKeys.includes(f.key))
  const itemLevel = allFields.filter((f) => !effectiveOrderKeys.includes(f.key))
  return { orderLevel, itemLevel }
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
  const [channels, setChannels] = useState<{ channel_code: string; channel_name: string }[]>([])
  const [channelFilter, setChannelFilter] = useState<string>('')
  const [productImageMap, setProductImageMap] = useState<Record<string, { product_code?: string; product_name?: string }>>({})
  const [cartoonPatternImageMap, setCartoonPatternImageMap] = useState<Record<string, { pattern_name?: string; line_count?: number | null }>>({})
  /** ระดับบิล: ชื่อช่องทาง, ชื่อลูกค้า, ที่อยู่ */
  const [rejectErrorFieldsOrder, setRejectErrorFieldsOrder] = useState<Record<string, boolean>>(
    ORDER_LEVEL_KEYS.reduce((acc, key) => ({ ...acc, [key]: false }), {} as Record<string, boolean>)
  )
  /** ระดับรายการ: items[index][fieldKey] = true ถ้าฟิลด์นั้นผิดที่รายการที่ index */
  const [rejectErrorFieldsByItem, setRejectErrorFieldsByItem] = useState<Record<number, Record<string, boolean>>>({})
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
  /** Override ตั้งค่าฟิลด์ระดับสินค้า (product_id → { fieldKey → boolean | null }) */
  const [productFieldOverrides, setProductFieldOverrides] = useState<Record<string, Record<string, boolean | null>>>({})

  useEffect(() => {
    loadOrders()
  }, [channelFilter])

  useEffect(() => {
    ;(async () => {
      const { data } = await supabase.from('channels').select('channel_code, channel_name').order('channel_code')
      if (data) setChannels(data)
    })()
  }, [])

  // โหลด pr_category_field_settings + pr_product_field_overrides ครั้งเดียว
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        function toBool(v: unknown, defaultVal = false): boolean {
          if (v === undefined || v === null) return defaultVal
          return v === true || v === 'true'
        }
        const [catRes, overrideRes] = await Promise.all([
          supabase.from('pr_category_field_settings').select('*'),
          supabase.from('pr_product_field_overrides').select('*'),
        ])
        if (cancelled) return
        if (catRes.error) {
          console.error('Error loading category field settings:', catRes.error)
        } else {
          const settingsMap: Record<string, Record<string, boolean>> = {}
          if (catRes.data && Array.isArray(catRes.data)) {
            catRes.data.forEach((row: any) => {
              const cat = row.category
              if (cat != null && String(cat).trim() !== '') {
                const key = String(cat).trim()
                settingsMap[key] = {
                  product_name: toBool(row.product_name, true),
                  ink_color: toBool(row.ink_color),
                  layer: toBool(row.layer),
                  cartoon_pattern: toBool(row.cartoon_pattern),
                  line_pattern: toBool(row.line_pattern),
                  font: toBool(row.font),
                  line_1: toBool(row.line_1),
                  line_2: toBool(row.line_2),
                  line_3: toBool(row.line_3),
                  quantity: toBool(row.quantity, true),
                  unit_price: toBool(row.unit_price, true),
                  notes: toBool(row.notes),
                  attachment: toBool(row.attachment),
                }
              }
            })
          }
          setCategoryFieldSettings(settingsMap)
        }
        if (overrideRes.error) {
          console.error('Error loading product field overrides:', overrideRes.error)
        } else {
          const overridesMap: Record<string, Record<string, boolean | null>> = {}
          if (overrideRes.data && Array.isArray(overrideRes.data)) {
            overrideRes.data.forEach((row: any) => {
              const pid = row.product_id
              if (!pid) return
              overridesMap[pid] = {
                product_name: row.product_name ?? null,
                ink_color: row.ink_color ?? null,
                layer: row.layer ?? null,
                cartoon_pattern: row.cartoon_pattern ?? null,
                line_pattern: row.line_pattern ?? null,
                font: row.font ?? null,
                line_1: row.line_1 ?? null,
                line_2: row.line_2 ?? null,
                line_3: row.line_3 ?? null,
                quantity: row.quantity ?? null,
                unit_price: row.unit_price ?? null,
                notes: row.notes ?? null,
                attachment: row.attachment ?? null,
              }
            })
          }
          setProductFieldOverrides(overridesMap)
        }
      } catch (e) {
        if (!cancelled) console.error('Error loading field settings:', e)
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
            ? supabase.from('pr_products').select('id, product_name, product_code, product_category').in('id', productIds)
            : Promise.resolve({ data: [] as any[] }),
          cartoonKeys.length > 0
            ? supabase.from('cp_cartoon_patterns').select('id, pattern_name, line_count').in('pattern_name', cartoonKeys)
            : Promise.resolve({ data: [] as any[] }),
        ])

        const nextProductMap: Record<string, { product_code?: string; product_name?: string }> = {}
        const nextCategoryMap: Record<string, string> = {}
        ;(productsRes as any)?.data?.forEach((p: any) => {
          nextProductMap[p.id] = { product_code: p.product_code, product_name: p.product_name }
          const cat = p.product_category
          if (cat != null && String(cat).trim() !== '') {
            nextCategoryMap[String(p.id)] = String(cat).trim()
          }
        })
        setProductImageMap(nextProductMap)
        setProductCategoryByProductId(nextCategoryMap)

        const nextPatternMap: Record<string, { pattern_name?: string; line_count?: number | null }> = {}
        ;((patternsRes as any)?.data || []).forEach((p: any) => {
          if (p.pattern_name) nextPatternMap[p.pattern_name] = { pattern_name: p.pattern_name, line_count: p.line_count ?? null }
        })
        setCartoonPatternImageMap(nextPatternMap)
      } catch (error) {
        console.error('Error loading item images:', error)
      }
    }

    loadItemImages()
  }, [selectedOrder?.id])

  // รีเซ็ตกล่องติ๊กและหมายเหตุเมื่อเปลี่ยนบิลที่เลือก
  useEffect(() => {
    if (selectedOrder) {
      setRejectErrorFieldsOrder(ORDER_LEVEL_KEYS.reduce((acc, key) => ({ ...acc, [key]: false }), {} as Record<string, boolean>))
      setRejectErrorFieldsByItem({})
      setRejectRemarks('')
    }
  }, [selectedOrder?.id])

  // ปุ่มลูกศร ขึ้น/ลง เพื่อเลื่อนรายการบิล
  const navigateOrder = useCallback(
    (direction: 'up' | 'down') => {
      if (orders.length === 0) return
      const currentIdx = selectedOrder ? orders.findIndex((o) => o.id === selectedOrder.id) : -1
      const nextIdx = direction === 'up'
        ? (currentIdx <= 0 ? orders.length - 1 : currentIdx - 1)
        : (currentIdx >= orders.length - 1 ? 0 : currentIdx + 1)
      setSelectedOrder(orders[nextIdx])
      const el = document.getElementById(`order-review-item-${orders[nextIdx].id}`)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    },
    [orders, selectedOrder]
  )

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        navigateOrder('up')
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        navigateOrder('down')
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [navigateOrder])

  async function loadOrders(silent = false): Promise<Order[]> {
    if (!silent) setLoading(true)
    try {
      let query = supabase
        .from('or_orders')
        .select('*, or_order_items(*)')
        .eq('status', 'ตรวจสอบแล้ว')
        .neq('channel_code', 'PUMP')
        .order('created_at', { ascending: false })
      if (channelFilter && channelFilter.trim() !== '') {
        query = query.eq('channel_code', channelFilter.trim())
      }
      const { data, error } = await query

      if (error) throw error
      const list = data || []
      setOrders(list)
      // เลือกบิลแรกถ้ายังไม่มี หรือถ้าบิลที่เลือกไม่อยู่ในรายการที่กรองแล้ว
      const stillInList = selectedOrder && list.some((o: Order) => o.id === selectedOrder.id)
      if (list.length > 0 && (!selectedOrder || !stillInList)) {
        setSelectedOrder(list[0])
      } else if (list.length === 0) {
        setSelectedOrder(null)
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
      const nextStatus = selectedOrder.channel_code === 'PUMP' ? 'รอคอนเฟิร์ม' : 'ใบสั่งงาน'
      const { error } = await supabase
        .from('or_orders')
        .update({ status: nextStatus })
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

    // ตรวจสอบว่ามีติ๊กระดับบิลหรือไม่ — ใช้ทุก key ใน rejectErrorFieldsOrder (รวม unit_price ที่อาจอยู่ระดับบิลสำหรับบางช่องทาง)
    const hasOrderChecked = Object.keys(rejectErrorFieldsOrder).some((key) => !!rejectErrorFieldsOrder[key])
    const items: any[] = (selectedOrder as any).order_items || (selectedOrder as any).or_order_items || []
    const hasItemChecked = items.some((_, i) => {
      const itemFields = rejectErrorFieldsByItem[i]
      return itemFields && Object.keys(itemFields).some((k) => !!itemFields[k])
    })
    const hasRemarks = (rejectRemarks || '').trim().length > 0
    if (!hasOrderChecked && !hasItemChecked && !hasRemarks) {
      setMessageModal({
        open: true,
        title: 'กรุณาระบุรายการที่ผิด',
        message:
          'กรุณาติ๊กเลือกรายการที่ผิด หรือกรอกหมายเหตุ (ข้อความที่ต้องแก้ไข) อย่างน้อยหนึ่งอย่าง',
      })
      return
    }

    const errorFieldsObj: Record<string, unknown> = {}
    Object.keys(rejectErrorFieldsOrder).forEach((key) => {
      if (rejectErrorFieldsOrder[key]) (errorFieldsObj as Record<string, boolean>)[key] = true
    })
    if (items.length > 0) {
      const itemsArray = items.map((_: any, i: number) => {
        const itemFields = rejectErrorFieldsByItem[i]
        if (!itemFields) return {}
        const out: Record<string, boolean> = {}
        Object.keys(itemFields).forEach((k) => {
          if (itemFields[k]) out[k] = true
        })
        return out
      })
      if (itemsArray.some((o) => Object.keys(o).length > 0)) errorFieldsObj.items = itemsArray
    }
    const errorFieldsToSave = Object.keys(errorFieldsObj).length > 0 ? errorFieldsObj : null

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
            error_fields: errorFieldsToSave,
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
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 flex-1 min-h-0 text-[12pt]">
      {/* การ์ดซ้าย - รายการบิล */}
      <div className="bg-white rounded-lg shadow overflow-hidden flex flex-col min-h-0">
        <div className="p-4 border-b bg-gray-50 shrink-0 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold">รายการบิล</h2>
            <span className="text-gray-600 text-sm">{orders.length} รายการ</span>
          </div>
          <div>
            <label htmlFor="admin-qc-channel-filter" className="block text-sm font-medium text-gray-700 mb-1">ช่องทาง</label>
            <select
              id="admin-qc-channel-filter"
              value={channelFilter}
              onChange={(e) => setChannelFilter(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
            >
              <option value="">ทั้งหมด</option>
              {channels.map((ch) => (
                <option key={ch.channel_code} value={ch.channel_code}>
                  {ch.channel_name || ch.channel_code}
                </option>
              ))}
            </select>
          </div>
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
                  id={`order-review-item-${order.id}`}
                  onClick={() => setSelectedOrder(order)}
                  className={`w-full p-4 text-left hover:bg-gray-50 transition-colors focus:outline-none ${
                    selectedOrder?.id === order.id ? 'bg-blue-50 border-l-4 border-blue-500' : ''
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-semibold text-gray-900 flex items-center gap-2">
                      {order.bill_no}
                      {(order.claim_type != null || (order.bill_no || '').startsWith('REQ')) && (
                        <span className="px-1.5 py-0.5 text-xs font-medium rounded bg-amber-100 text-amber-800 border border-amber-200">
                          เคลม
                        </span>
                      )}
                    </div>
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
                  {CHANNELS_ORDER_NO.includes((selectedOrder as any).channel_code || '') ? (
                    <>
                      {(selectedOrder as any).channel_order_no && (
                        <div className="flex items-start gap-3">
                          <div className="w-24 text-gray-600 font-medium text-sm shrink-0">เลขคำสั่งซื้อ</div>
                          <div className="flex-1 text-sm">{(selectedOrder as any).channel_order_no}</div>
                        </div>
                      )}
                      {(selectedOrder as any).tracking_number && (
                        <div className="flex items-start gap-3">
                          <div className="w-24 text-gray-600 font-medium text-sm shrink-0">เลขพัสดุ</div>
                          <div className="flex-1 text-sm">{(selectedOrder as any).tracking_number}</div>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
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
                    </>
                  )}
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
                      {(() => {
                        const orderItems: any[] =
                          (selectedOrder as any).order_items || (selectedOrder as any).or_order_items || []

                        return orderItems.map((item: any) => {
                        const perItemKeys = getVisibleFieldsForItem(item, categoryFieldSettings, productCategoryByProductId, productFieldOverrides)
                        const product = productImageMap[item.product_id] || null
                        const productImageUrl = product?.product_code
                          ? getPublicUrl(PRODUCT_IMAGES_BUCKET, product.product_code, '.jpg')
                          : null
                        const patternKey = item.cartoon_pattern || ''
                        const pattern = patternKey ? cartoonPatternImageMap[patternKey] : null
                        const patternImageUrl = pattern?.pattern_name
                          ? getPublicUrl('cartoon-patterns', pattern.pattern_name, '.jpg')
                          : null

                        const unitPrice = Number(item.unit_price || 0)
                        const qty = Number(item.quantity || 0)
                        const itemLineCount = pattern?.line_count ?? null
                        const detailRows: Array<{ key: ErrorFieldKey; label: string; value: string }> = [
                          { key: 'ink_color' as ErrorFieldKey, label: 'สีหมึก', value: item.ink_color || '-' },
                          { key: 'layer' as ErrorFieldKey, label: 'ชั้น', value: item.product_type || '-' },
                          { key: 'line_art' as ErrorFieldKey, label: 'ลายเส้น', value: item.line_pattern || '-' },
                          { key: 'font' as ErrorFieldKey, label: 'ฟอนต์', value: item.font || '-' },
                          { key: 'line_1' as ErrorFieldKey, label: 'บรรทัด 1', value: item.line_1 || '-' },
                          { key: 'line_2' as ErrorFieldKey, label: 'บรรทัด 2', value: item.line_2 || '-' },
                          { key: 'line_3' as ErrorFieldKey, label: 'บรรทัด 3', value: item.line_3 || '-' },
                        ]
                          .filter((row) => perItemKeys.has(row.key))
                          .filter((row) => {
                            if (itemLineCount == null) return true
                            if (row.key === 'line_1') return itemLineCount >= 1
                            if (row.key === 'line_2') return itemLineCount >= 2
                            if (row.key === 'line_3') return itemLineCount >= 3
                            return true
                          })
                        const showQuantity = perItemKeys.has('quantity')
                        const showUnitPrice = perItemKeys.has('unit_price')

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
                                    <div className="font-semibold text-gray-900 truncate flex items-center gap-1.5">
                                      {item.product_name}
                                      {item.is_free && (
                                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-green-100 text-green-700 border border-green-300 whitespace-nowrap shrink-0">สินค้าแถม</span>
                                      )}
                                    </div>
                                    {item.cartoon_pattern && (
                                      <div className="text-gray-600 mt-1">
                                        ลายการ์ตูน: <span className="font-medium">{item.cartoon_pattern}</span>
                                      </div>
                                    )}
                                    {/* Extra item details for checking */}
                                    {detailRows.length > 0 && (
                                      <div className="mt-3 space-y-1 text-gray-700">
                                        {detailRows.map((row) => (
                                          <div key={row.key} className="flex gap-3">
                                            <div className="w-24 text-gray-600 font-medium">{row.label}</div>
                                            <div className="flex-1">{row.value}</div>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>

                                  <div className="text-right shrink-0">
                                    {showQuantity && (
                                      <div className="text-gray-700">
                                        จำนวน: <span className="font-semibold">{qty || '-'}</span>
                                      </div>
                                    )}
                                    {showUnitPrice && (
                                      <div className="text-gray-700 mt-1">
                                        ราคา/หน่วย:{' '}
                                        <span className="font-semibold">
                                          {unitPrice ? `฿${unitPrice.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '-'}
                                        </span>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        )
                      })
                      })()}
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
              <div className="space-y-4">
                <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg">
                  <h3 className="text-sm font-semibold text-amber-900 mb-2">ระดับบิล — เลือกรายการที่ผิด</h3>
                  <div className="grid grid-cols-1 gap-2">
                    {getOrderLevelAndItemLevelErrorFields(selectedOrder, categoryFieldSettings, productCategoryByProductId, productFieldOverrides).orderLevel.map(({ key, label }) => (
                      <label key={key} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={!!rejectErrorFieldsOrder[key]}
                          onChange={(e) => setRejectErrorFieldsOrder((prev) => ({ ...prev, [key]: e.target.checked }))}
                          className="rounded border-gray-300 text-red-600 focus:ring-red-500"
                        />
                        <span className="text-gray-800 text-sm">{label}</span>
                      </label>
                    ))}
                  </div>
                </div>
                {(() => {
                  const orderItems: any[] = (selectedOrder as any).order_items || (selectedOrder as any).or_order_items || []
                  if (orderItems.length === 0) return null

                  const channelCode = (selectedOrder as any)?.channel_code || ''
                  const effectiveOrderKeys: ErrorFieldKey[] = CHANNELS_ORDER_NO.includes(channelCode)
                    ? [...ORDER_LEVEL_KEYS, 'unit_price']
                    : ORDER_LEVEL_KEYS

                  return (
                    <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg">
                      <h3 className="text-sm font-semibold text-amber-900 mb-2">ระดับรายการ — เลือกรายการที่ผิดต่อรายการ</h3>
                      <div className="space-y-4">
                        {orderItems.map((item: any, index: number) => {
                          const perItemKeys = getVisibleFieldsForItem(item, categoryFieldSettings, productCategoryByProductId, productFieldOverrides)
                          const perItemLevel = ITEM_LEVEL_DEF
                            .filter((d) => perItemKeys.has(d.key) && !effectiveOrderKeys.includes(d.key))
                          if (perItemLevel.length === 0) return null
                          return (
                          <div key={item.id || index} className="border border-amber-200 rounded-lg p-3 bg-white/60">
                            <div className="text-sm font-medium text-amber-900 mb-2">
                              รายการที่ {index + 1}: {(item.product_name || '').trim() || '(ไม่มีชื่อสินค้า)'}
                              {item.is_free && (
                                <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-green-100 text-green-700 border border-green-300">สินค้าแถม</span>
                              )}
                            </div>
                            <div className="grid grid-cols-1 gap-1.5">
                              {perItemLevel
                                .filter(({ key }) => {
                                  const pk = item.cartoon_pattern || ''
                                  const lc = pk ? cartoonPatternImageMap[pk]?.line_count : null
                                  if (lc == null) return true
                                  if (key === 'line_1') return lc >= 1
                                  if (key === 'line_2') return lc >= 2
                                  if (key === 'line_3') return lc >= 3
                                  return true
                                })
                                .map(({ key, label }) => (
                                <label key={key} className="flex items-center gap-2 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={!!(rejectErrorFieldsByItem[index] || {})[key]}
                                    onChange={(e) => {
                                      setRejectErrorFieldsByItem((prev) => ({
                                        ...prev,
                                        [index]: { ...(prev[index] || {}), [key]: e.target.checked },
                                      }))
                                    }}
                                    className="rounded border-gray-300 text-red-600 focus:ring-red-500"
                                  />
                                  <span className="text-gray-800 text-sm">{label}</span>
                                </label>
                              ))}
                            </div>
                          </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })()}
                <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg">
                  <label className="block text-sm font-medium text-gray-700 mb-1">หมายเหตุ (ข้อความที่ต้องแก้ไข)</label>
                  <textarea
                    value={rejectRemarks}
                    onChange={(e) => setRejectRemarks(e.target.value)}
                    placeholder="ระบุรายละเอียดที่ต้องแก้ไข..."
                    rows={3}
                    className="w-full px-3 py-2 border rounded-lg border-gray-300 focus:outline-none focus:ring-0 focus:border-gray-300 text-sm"
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
