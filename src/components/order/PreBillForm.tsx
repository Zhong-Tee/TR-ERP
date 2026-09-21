/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import html2canvas from 'html2canvas'
import { useAuthContext } from '../../contexts/AuthContext'
import { supabase } from '../../lib/supabase'
import { evaluatePromotions, promotionApplicationLimit, promotionMatchesChannel, totalPromotionDiscount, type PromotionDefinition } from '../../lib/promotionRules'
import { calculateShippingCharge, findShippingAreaRule, SHIPPING_AREA_TYPE_LABELS, type ShippingAreaRule } from '../../lib/shippingAreaRules'
import {
  findJumboSharpenerGiftProduct,
  findTubeGiftProduct,
  getJumboSharpenerEligibleQuantity,
  getTubeEligibleQuantity,
  JUMBO_SHARPENER_GIFT_PRODUCT_CODE,
  reconcileJumboSharpenerGiftItems,
  reconcileTubeGiftItems,
  TUBE_GIFT_PRODUCT_CODE,
} from '../../lib/orderAutoGifts'
import { parseAddressText, type SubDistrictOption } from '../../lib/thaiAddress'
import type { CartoonPattern, Product } from '../../types'
import type { PreBillChannelSetting, PreBillDocument, PreBillDocumentType, PreBillItem } from '../../types/prebill'
import { PREBILL_TYPE_LABEL } from '../../types/prebill'
import PreBillPreview, { buildPreBillCustomerText } from './PreBillPreview'

type Props = {
  documentType: PreBillDocumentType
  document?: PreBillDocument | null
  sourceDocument?: PreBillDocument | null
  onSaved: () => void
  onCancel: () => void
  onOpenBill: (document: PreBillDocument) => void
}

type Channel = { channel_code: string; channel_name: string; default_carrier?: string | null }
type FieldMap = Record<string, Record<string, boolean | null | 'required'>>
type AddressParts = { address_line: string; sub_district: string; district: string; province: string; postal_code: string }

const blankItem = (sort = 0): PreBillItem => ({
  sort_order: sort, product_id: null, product_code: null, product_name: '', quantity: 1, unit_price: 0,
  is_free: false, is_detail_row: false, parent_item_id: null, oh_snapshot: 0, ink_color: null, product_type: null, cartoon_pattern: null,
  line_pattern: null, font: null, line_1: null, line_2: null, line_3: null, no_name_line: false,
  notes: null, file_attachment: null, attachment_name: null, field_snapshot: {},
})

const today = () => new Date().toISOString().slice(0, 10)
const thailandBusinessDate = () => new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
const addDays = (days: number) => {
  const value = new Date(); value.setDate(value.getDate() + days); return value.toISOString().slice(0, 10)
}
const money = (value: unknown) => Number(value || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const MANUAL_PRICE_CHANNELS = new Set(['SPTR', 'FSPTR', 'TTTR', 'LZTR', 'WY'])
const PLASTIC_INK_BONUS_MAP: Record<string, string> = {
  'พลาสติกดำ': 'หมึกแฟลชพลาสติก 5 ml. (ดำ)',
  'พลาสติกเขียว': 'หมึกแฟลชพลาสติก 5 ml. (เขียว)',
  'พลาสติกแดง': 'หมึกแฟลชพลาสติก 5 ml. (แดง)',
  'พลาสติกน้ำเงิน': 'หมึกแฟลชพลาสติก 5 ml. (น้ำเงิน)',
}
const PLASTIC_INK_BONUS_NAMES = new Set(Object.values(PLASTIC_INK_BONUS_MAP))
const NATURAL_NAME_COLLATOR = new Intl.Collator(['th', 'en'], { numeric: true, sensitivity: 'base' })

function reconcilePlasticInkGiftItems(items: PreBillItem[], products: Product[], stockMap: Record<string, number>): PreBillItem[] {
  let changed = false
  const next = items.slice()
  const claimedGiftIds = new Set<string>()
  const activeSourceIds = new Set<string>()
  const sourceIndexes = next.reduce<number[]>((indexes, item, index) => {
    if (!item.is_free && PLASTIC_INK_BONUS_MAP[String(item.ink_color || '')]) indexes.push(index)
    return indexes
  }, [])

  sourceIndexes.forEach(sourceIndex => {
    let source = next[sourceIndex]
    const sourceId = source.id || crypto.randomUUID()
    if (!source.id) {
      source = { ...source, id: sourceId }
      next[sourceIndex] = source
      changed = true
    }
    activeSourceIds.add(sourceId)

    const bonusName = PLASTIC_INK_BONUS_MAP[String(source.ink_color || '')]
    const bonusProduct = products.find(product => product.product_name.trim() === bonusName)
    if (!bonusProduct) return

    let giftIndex = next.findIndex(item => item.is_free && String(item.field_snapshot?.auto_gift_source_item_id || '') === sourceId)
    if (giftIndex < 0) {
      giftIndex = next.findIndex(item => item.is_free && item.product_name.trim() === bonusName && (!item.id || !claimedGiftIds.has(item.id)))
    }

    const desiredQuantity = Math.max(1, Number(source.quantity || 1))
    if (giftIndex < 0) {
      const giftId = crypto.randomUUID()
      next.push({
        ...blankItem(next.length),
        id: giftId,
        product_id: bonusProduct.id,
        product_code: bonusProduct.product_code,
        product_name: bonusProduct.product_name,
        quantity: desiredQuantity,
        unit_price: 0,
        is_free: true,
        oh_snapshot: Number(stockMap[bonusProduct.id] || 0),
        field_snapshot: { auto_gift_type: 'plastic_ink', auto_gift_source_item_id: sourceId },
      })
      claimedGiftIds.add(giftId)
      changed = true
      return
    }

    const gift = next[giftIndex]
    const giftId = gift.id || crypto.randomUUID()
    claimedGiftIds.add(giftId)
    const isCorrect = gift.id === giftId && gift.product_id === bonusProduct.id && gift.product_code === bonusProduct.product_code &&
      gift.product_name === bonusProduct.product_name && Number(gift.quantity) === desiredQuantity && Number(gift.unit_price) === 0 &&
      gift.is_free === true && gift.is_detail_row !== true && gift.parent_item_id == null &&
      String(gift.field_snapshot?.auto_gift_source_item_id || '') === sourceId
    if (!isCorrect) {
      next[giftIndex] = {
        ...gift,
        id: giftId,
        product_id: bonusProduct.id,
        product_code: bonusProduct.product_code,
        product_name: bonusProduct.product_name,
        quantity: desiredQuantity,
        unit_price: 0,
        is_free: true,
        is_detail_row: false,
        parent_item_id: null,
        oh_snapshot: Number(stockMap[bonusProduct.id] || 0),
        field_snapshot: { ...gift.field_snapshot, auto_gift_type: 'plastic_ink', auto_gift_source_item_id: sourceId },
      }
      changed = true
    }
  })

  const reconciled = next.filter(item => {
    if (!item.is_free || !PLASTIC_INK_BONUS_NAMES.has(item.product_name.trim())) return true
    const sourceId = String(item.field_snapshot?.auto_gift_source_item_id || '')
    const keep = Boolean(item.id && claimedGiftIds.has(item.id) && sourceId && activeSourceIds.has(sourceId))
    if (!keep) changed = true
    return keep
  })
  return changed ? reconciled : items
}

type LookupInputProps = {
  value: string
  options: string[]
  placeholder: string
  disabled?: boolean
  onChange: (value: string) => void
}

function LookupDropdownInput({ value, options, placeholder, disabled = false, onChange }: LookupInputProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null)

  function syncPosition() {
    const input = inputRef.current
    if (!input) return
    const rect = input.getBoundingClientRect()
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      setOpen(false)
      setPosition(null)
      return
    }
    setPosition({ left: rect.left, top: rect.bottom + 4, width: rect.width, maxHeight: Math.max(140, Math.min(288, window.innerHeight - rect.bottom - 20)) })
  }

  useEffect(() => {
    if (!open) return
    const handlePositionChange = () => syncPosition()
    window.addEventListener('scroll', handlePositionChange, true)
    window.addEventListener('resize', handlePositionChange)
    return () => {
      window.removeEventListener('scroll', handlePositionChange, true)
      window.removeEventListener('resize', handlePositionChange)
    }
  }, [open])

  const normalized = search.trim().toLowerCase()
  const matches = options.filter(option => !normalized || option.toLowerCase().includes(normalized)).slice(0, 50)
  const show = (resetSearch = false) => {
    if (disabled) return
    if (resetSearch) setSearch('')
    syncPosition()
    setOpen(true)
  }

  return <>
    <div className="relative w-full">
      <input ref={inputRef} value={value} disabled={disabled} placeholder={placeholder} onFocus={() => show(true)} onChange={event => { onChange(event.target.value); setSearch(event.target.value); show() }} onBlur={() => window.setTimeout(() => { setOpen(false); setPosition(null) }, 150)} className="w-full rounded border px-1.5 py-1 pr-7 text-xs disabled:bg-slate-100" autoComplete="off" />
      <button type="button" tabIndex={-1} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => open ? (setOpen(false), setPosition(null)) : show(true)} className="absolute right-0 top-0 h-7 w-7 text-slate-500 disabled:text-slate-300">▾</button>
    </div>
    {open && position && createPortal(<div className="fixed z-[300] overflow-y-auto rounded-xl border border-slate-200 bg-white py-1 shadow-2xl" style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }}>{matches.length > 0 ? matches.map(option => <button key={option} type="button" onMouseDown={event => { event.preventDefault(); onChange(option); setOpen(false); setPosition(null) }} className="block w-full px-3 py-2 text-left text-sm font-semibold hover:bg-blue-50">{option}</button>) : <div className="px-3 py-4 text-center text-sm text-slate-500">ไม่พบข้อมูล</div>}</div>, globalThis.document.body)}
  </>
}

export default function PreBillForm({ documentType, document, sourceDocument, onSaved, onCancel, onOpenBill }: Props) {
  const { user } = useAuthContext()
  const seed = document || sourceDocument
  const isRenewal = !document && !!sourceDocument
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [channels, setChannels] = useState<Channel[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [stockMap, setStockMap] = useState<Record<string, number>>({})
  const [priceMap, setPriceMap] = useState<Record<string, number>>({})
  const [settings, setSettings] = useState<PreBillChannelSetting[]>([])
  const [sellerName, setSellerName] = useState(user?.seller_name?.trim() || '')
  const [promotions, setPromotions] = useState<PromotionDefinition[]>([])
  const [selectedPromotionIds, setSelectedPromotionIds] = useState<string[]>(seed?.promotion_ids || [])
  const [promotionApplicationCounts, setPromotionApplicationCounts] = useState<Record<string, number>>(() => Object.fromEntries((seed?.promotion_snapshot || []).map(snapshot => {
    const evaluation = snapshot.evaluation as { application_count?: number } | undefined
    return [String(snapshot.id || ''), Math.max(1, Number(evaluation?.application_count || 1))]
  }).filter(([id]) => id)))
  const [categoryFields, setCategoryFields] = useState<FieldMap>({})
  const [productFields, setProductFields] = useState<FieldMap>({})
  const [activeCategories, setActiveCategories] = useState<Record<string, boolean>>({})
  const [inkTypes, setInkTypes] = useState<string[]>([])
  const [fonts, setFonts] = useState<string[]>([])
  const [patterns, setPatterns] = useState<CartoonPattern[]>([])
  const [shippingSettings, setShippingSettings] = useState({ auto_calculate_enabled: false, charge_promotion_orders: true, special_area_enabled: false })
  const [shippingRanges, setShippingRanges] = useState<Array<{ min_amount: number; max_amount: number | null; shipping_fee: number }>>([])
  const [areaRules, setAreaRules] = useState<ShippingAreaRule[]>([])
  const [items, setItems] = useState<PreBillItem[]>(() => {
    const sourceItems = seed?.or_prebill_items
    if (!sourceItems?.length) return [blankItem()]
    if (document) return sourceItems.map((item, index) => ({ ...item, document_id: undefined, sort_order: index }))
    const renewedIds = new Map(sourceItems.map(item => [String(item.id || ''), crypto.randomUUID()]))
    return sourceItems.map((item, index) => ({
      ...item,
      id: renewedIds.get(String(item.id || '')) || crypto.randomUUID(),
      document_id: undefined,
      parent_item_id: item.parent_item_id ? renewedIds.get(String(item.parent_item_id)) || null : null,
      sort_order: index,
    }))
  })
  const [form, setForm] = useState({
    channel_code: seed?.channel_code || '', customer_name: seed?.customer_name || 'ลูกค้า',
    customer_address: seed?.customer_address || '', recipient_name: seed?.recipient_name || '', customer_phone: seed?.customer_phone || '',
    delivery_term: seed?.delivery_term || '1-3 วัน', delivery_custom: '', valid_until: isRenewal ? addDays(7) : seed?.valid_until || addDays(7),
    payment_method: seed?.payment_method || 'โอน', internal_note: seed?.internal_note || '',
  })
  const seedAddress = (seed?.billing_details || {}) as Partial<AddressParts>
  const [address, setAddress] = useState<AddressParts>({
    address_line: seedAddress.address_line || '', sub_district: seedAddress.sub_district || '', district: seedAddress.district || '',
    province: seedAddress.province || '', postal_code: seedAddress.postal_code || '',
  })
  const [subDistrictOptions, setSubDistrictOptions] = useState<SubDistrictOption[]>([])
  const [autoFillAddressLoading, setAutoFillAddressLoading] = useState(false)
  const [manualShipping, setManualShipping] = useState<number | null>(seed && !isRenewal ? Number(seed.shipping_cost || 0) : null)
  const [message, setMessage] = useState('')
  const [toast, setToast] = useState('')
  const [discountModal, setDiscountModal] = useState(false)
  const [discountRequest, setDiscountRequest] = useState({
    type: seed?.special_discount_type || 'amount' as 'amount' | 'percent',
    value: seed?.special_discount_value ? String(seed.special_discount_value) : '',
    note: seed?.discount_request_note || '',
  })
  const [previewOpen, setPreviewOpen] = useState(false)
  const [openProductIndex, setOpenProductIndex] = useState<number | null>(null)
  const [productSearchTerms, setProductSearchTerms] = useState<Record<number, string>>({})
  const [productDropdownPosition, setProductDropdownPosition] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null)
  const productInputRefs = useRef<Record<number, HTMLInputElement | null>>({})
  const previewRef = useRef<HTMLDivElement>(null)
  const toastTimerRef = useRef<number | null>(null)
  const priceRefreshChannelRef = useRef<string | null>(isRenewal && seed?.channel_code ? seed.channel_code : null)

  const permanentlyLocked = !!document && ['converted', 'cancelled'].includes(document.status)
  const approvalLocked = !!document && ['pending_discount', 'approved'].includes(document.status) && user?.role !== 'superadmin'
  const locked = permanentlyLocked || approvalLocked
  const expired = !!document && document.valid_until < today() && document.status !== 'converted'

  useEffect(() => {
    const sellerUserId = document?.owner_id || user?.id
    if (!sellerUserId) return
    let alive = true
    supabase.from('us_users').select('seller_name').eq('id', sellerUserId).maybeSingle().then(({ data }) => {
      if (alive) setSellerName(String(data?.seller_name || '').trim())
    })
    return () => { alive = false }
  }, [document?.owner_id, user?.id])

  function showToast(text: string) {
    if (toastTimerRef.current != null) window.clearTimeout(toastTimerRef.current)
    setToast(text)
    toastTimerRef.current = window.setTimeout(() => {
      setToast('')
      toastTimerRef.current = null
    }, 2200)
  }

  useEffect(() => () => {
    if (toastTimerRef.current != null) window.clearTimeout(toastTimerRef.current)
  }, [])

  async function handleAutoFillAddress(addressText?: string) {
    const rawAddress = String(addressText ?? form.customer_address ?? '').trim()
    if (!rawAddress) { setMessage('กรุณากรอกหรือวางที่อยู่ก่อน Auto fill'); return }
    setAutoFillAddressLoading(true)
    setMessage('')
    try {
      const parsed = await parseAddressText(rawAddress, supabase)
      setSubDistrictOptions(parsed.subDistrictOptions || [])
      setAddress({
        address_line: parsed.addressLine,
        sub_district: parsed.subDistrict,
        district: parsed.district,
        province: parsed.province,
        postal_code: parsed.postalCode,
      })
      setForm(current => ({
        ...current,
        recipient_name: parsed.recipientName?.trim() || current.recipient_name,
        customer_phone: parsed.mobilePhone || current.customer_phone,
      }))
      setManualShipping(null)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'ไม่สามารถแยกข้อมูลที่อยู่ได้')
    } finally {
      setAutoFillAddressLoading(false)
    }
  }

  useEffect(() => {
    if (openProductIndex == null) return

    const syncDropdownPosition = () => {
      const input = productInputRefs.current[openProductIndex]
      if (!input) return
      const rect = input.getBoundingClientRect()
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        setOpenProductIndex(null)
        setProductDropdownPosition(null)
        return
      }
      const dropdownWidth = Math.min(Math.max(rect.width, 520), window.innerWidth - 24)
      setProductDropdownPosition({
        left: Math.max(12, Math.min(rect.left, window.innerWidth - dropdownWidth - 12)),
        top: rect.bottom + 4,
        width: dropdownWidth,
        maxHeight: Math.max(140, Math.min(288, window.innerHeight - rect.bottom - 20)),
      })
    }

    window.addEventListener('scroll', syncDropdownPosition, true)
    window.addEventListener('resize', syncDropdownPosition)
    return () => {
      window.removeEventListener('scroll', syncDropdownPosition, true)
      window.removeEventListener('resize', syncDropdownPosition)
    }
  }, [openProductIndex])

  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true)
      const [channelRes, productRes, stockRes, settingsRes, promotionRes, categoryRes, overrideRes, inkRes, fontRes, patternRes, shipSettingRes, shipRangeRes, areaRes] = await Promise.all([
        supabase.from('channels').select('channel_code, channel_name, default_carrier').order('channel_code'),
        supabase.from('pr_products').select('*').eq('is_active', true).in('product_type', ['FG', 'PP']).order('product_name'),
        supabase.from('inv_stock_balances').select('product_id, on_hand, reserved'),
        supabase.from('or_prebill_channel_settings').select('*'),
        supabase.from('promotion').select('*').eq('is_active', true).order('sort_order'),
        supabase.from('pr_category_field_settings').select('*'),
        supabase.from('pr_product_field_overrides').select('*'),
        supabase.from('ink_types').select('ink_name').order('ink_name'),
        supabase.from('fonts').select('font_name').eq('is_active', true).order('font_code'),
        supabase.from('cp_cartoon_patterns').select('*').eq('is_active', true).order('id'),
        supabase.from('or_shipping_fee_settings').select('auto_calculate_enabled, charge_promotion_orders, special_area_enabled').eq('id', 1).maybeSingle(),
        supabase.from('or_shipping_fee_ranges').select('min_amount, max_amount, shipping_fee').order('sort_order'),
        supabase.from('or_shipping_area_rules').select('*').eq('is_active', true),
      ])
      if (!alive) return
      const criticalErrors = [
        ['ช่องทาง', channelRes.error], ['สินค้า', productRes.error], ['โปรโมชั่น', promotionRes.error],
        ['ตั้งค่าค่าส่ง', shipSettingRes.error], ['ช่วงค่าส่ง', shipRangeRes.error], ['พื้นที่ห่างไกล', areaRes.error],
      ].filter((entry): entry is [string, NonNullable<typeof channelRes.error>] => Boolean(entry[1]))
      if (criticalErrors.length > 0) throw new Error(`โหลดข้อมูลไม่สำเร็จ: ${criticalErrors.map(([name, error]) => `${name} (${error.message})`).join(', ')}`)
      setChannels((channelRes.data || []) as Channel[])
      setProducts((productRes.data || []) as Product[])
      setStockMap(Object.fromEntries((stockRes.data || []).map((r: any) => [String(r.product_id), Number(r.on_hand || 0) - Number(r.reserved || 0)])))
      setSettings((settingsRes.data || []) as PreBillChannelSetting[])
      setPromotions((promotionRes.data || []) as PromotionDefinition[])
      const categoryMap: FieldMap = {}; const activeMap: Record<string, boolean> = {}
      ;(categoryRes.data || []).forEach((r: any) => {
        const key = String(r.category || '').trim(); if (!key) return
        categoryMap[key] = r; activeMap[key] = r.is_active_for_sales !== false
      })
      const overrideMap: FieldMap = {}
      ;(overrideRes.data || []).forEach((r: any) => {
        const required = new Set<string>(Array.isArray(r.required_fields) ? r.required_fields : [])
        overrideMap[String(r.product_id)] = {
          ...Object.fromEntries(['ink_color','cartoon_pattern','line_pattern','font','line_1','line_2','line_3','quantity','unit_price','notes','attachment'].map(k => [k, required.has(k) ? 'required' : r[k] ?? null])),
          product_type: required.has('layer') ? 'required' : r.layer ?? null,
        }
      })
      setCategoryFields(categoryMap); setProductFields(overrideMap); setActiveCategories(activeMap)
      setInkTypes((inkRes.data || []).map((r: any) => String(r.ink_name || '')).filter(Boolean))
      setFonts((fontRes.data || []).map((r: any) => String(r.font_name || '')).filter(Boolean))
      setPatterns((patternRes.data || []) as CartoonPattern[])
      if (shipSettingRes.data) setShippingSettings({
        auto_calculate_enabled: shipSettingRes.data.auto_calculate_enabled === true,
        charge_promotion_orders: shipSettingRes.data.charge_promotion_orders !== false,
        special_area_enabled: shipSettingRes.data.special_area_enabled === true,
      })
      setShippingRanges((shipRangeRes.data || []).map((r: any) => ({ min_amount: Number(r.min_amount || 0), max_amount: r.max_amount == null ? null : Number(r.max_amount), shipping_fee: Number(r.shipping_fee || 0) })))
      setAreaRules((areaRes.data || []).map((row: any) => ({ ...row, surcharge: Number(row.surcharge || 0) })) as ShippingAreaRule[])
      setLoading(false)
    })().catch((error) => { if (alive) { setMessage(error.message || String(error)); setLoading(false) } })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    const code = form.channel_code.trim()
    if (!code || MANUAL_PRICE_CHANNELS.has(code)) {
      setPriceMap({})
      if (priceRefreshChannelRef.current === code) priceRefreshChannelRef.current = null
      return
    }
    let alive = true
    supabase.from('pr_product_channel_prices').select('product_id, sale_price').eq('channel_code', code).then(({ data, error }) => {
      if (!alive) return
      if (error) {
        setMessage(`โหลดราคาช่องทาง ${code} ไม่สำเร็จ: ${error.message}`)
        return
      }
      const nextPriceMap = Object.fromEntries((data || []).map((row: any) => [String(row.product_id), Number(row.sale_price || 0)]))
      setPriceMap(nextPriceMap)
      if (priceRefreshChannelRef.current !== code) return
      setItems(current => current.map(item => {
        if (!item.product_id) return item
        if (item.is_free || item.is_detail_row) return Number(item.unit_price || 0) === 0 ? item : { ...item, unit_price: 0 }
        const nextPrice = Number(nextPriceMap[String(item.product_id)] || 0)
        return Number(item.unit_price || 0) === nextPrice ? item : { ...item, unit_price: nextPrice }
      }))
      priceRefreshChannelRef.current = null
    })
    return () => { alive = false }
  }, [form.channel_code])

  useEffect(() => {
    if (!isRenewal || promotions.length === 0) return
    const available = new Set(promotions.filter(p => promotionMatchesChannel(p, form.channel_code)).map(p => p.id))
    setSelectedPromotionIds((sourceDocument?.promotion_ids || []).filter(id => available.has(id)))
  }, [isRenewal, promotions, form.channel_code, sourceDocument?.id, sourceDocument?.promotion_ids])

  useEffect(() => {
    if (!form.channel_code || promotions.length === 0) return
    const allowed = new Set(promotions.filter(promotion => promotionMatchesChannel(promotion, form.channel_code)).map(promotion => promotion.id))
    setSelectedPromotionIds(current => current.filter(id => allowed.has(id)))
    setPromotionApplicationCounts(current => Object.fromEntries(Object.entries(current).filter(([id]) => allowed.has(id))))
  }, [form.channel_code, promotions])

  useEffect(() => {
    if (products.length === 0) return
    // Keep automatic gifts at the bottom so condo/detail rows always stay together.
    setItems(current => {
      const plasticReconciled = reconcilePlasticInkGiftItems(current, products, stockMap)
      const tubeReconciled = reconcileTubeGiftItems(plasticReconciled, products)
      const reconciled = reconcileJumboSharpenerGiftItems(tubeReconciled, products)
      const firstFreeIndex = reconciled.findIndex(item => item.is_free)
      const needsGiftReorder = firstFreeIndex >= 0 && reconciled.slice(firstFreeIndex + 1).some(item => !item.is_free)
      const ordered = needsGiftReorder
        ? [...reconciled.filter(item => !item.is_free), ...reconciled.filter(item => item.is_free)]
        : reconciled
      if (ordered === current) return current
      return ordered.map((item, index) => ({ ...blankItem(index), ...item, sort_order: index }))
    })
  }, [items, products, stockMap])

  const selectableProducts = useMemo(() => products.filter(p => !p.product_category || activeCategories[p.product_category] !== false), [products, activeCategories])
  const subtotal = useMemo(() => items.reduce((sum, item) => sum + (item.is_free || item.is_detail_row ? 0 : Number(item.quantity || 0) * Number(item.unit_price || 0)), 0), [items])
  const promotionItems = useMemo(() => items.filter(item => !item.is_detail_row), [items])
  const tubeGiftMissing = useMemo(() => getTubeEligibleQuantity(items, products) > 0 && !findTubeGiftProduct(products), [items, products])
  const jumboSharpenerGiftMissing = useMemo(() => getJumboSharpenerEligibleQuantity(items, products) > 0 && !findJumboSharpenerGiftProduct(products), [items, products])
  const missingPlasticGiftNames = useMemo(() => Array.from(new Set(items
    .map(item => PLASTIC_INK_BONUS_MAP[String(item.ink_color || '')])
    .filter((name): name is string => Boolean(name) && !products.some(product => product.product_name.trim() === name)))), [items, products])
  const promotionsForSelection = useMemo(() => promotions
    .filter(promotion => promotionMatchesChannel(promotion, form.channel_code))
    .sort((left, right) => Number(selectedPromotionIds.includes(right.id)) - Number(selectedPromotionIds.includes(left.id))), [promotions, selectedPromotionIds, form.channel_code])
  const featuredPromotions = useMemo(() => promotionsForSelection.filter(promotion => promotion.is_featured === true), [promotionsForSelection])
  const selectedPromotions = useMemo(() => promotions.filter(p => selectedPromotionIds.includes(p.id) && promotionMatchesChannel(p, form.channel_code)), [promotions, selectedPromotionIds, form.channel_code])
  const promoResults = useMemo(() => evaluatePromotions(selectedPromotions, promotionItems.map(item => ({
    product_id: item.product_id, product_name: item.product_name,
    product_category: products.find(p => p.id === item.product_id)?.product_category,
    quantity: item.quantity, unit_price: item.unit_price, is_free: item.is_free,
  })), {
    channel_code: form.channel_code,
    order_date: thailandBusinessDate(),
    order_subtotal: subtotal,
    application_counts: promotionApplicationCounts,
  }), [selectedPromotions, promotionItems, products, form.channel_code, subtotal, promotionApplicationCounts])
  const promotionDiscount = totalPromotionDiscount(promoResults)
  const hasFreeShipping = selectedPromotions.some(p => p.free_shipping === true && promoResults.some(result => result.promotion_id === p.id && result.passed))
  const standardShipping = shippingRanges.find(r => subtotal >= r.min_amount && (r.max_amount == null || subtotal <= r.max_amount))?.shipping_fee || 0
  const channel = channels.find(c => c.channel_code === form.channel_code)
  const matchedArea = findShippingAreaRule(areaRules, { carrier: channel?.default_carrier || '', channel_code: form.channel_code, order_date: thailandBusinessDate(), ...address })
  const specialAreaSurcharge = shippingSettings.special_area_enabled && matchedArea ? Number(matchedArea.surcharge || 0) : 0
  const baseShippingWaived = hasFreeShipping || (selectedPromotionIds.length > 0 && !shippingSettings.charge_promotion_orders)
  const shippingCharge = calculateShippingCharge(standardShipping, specialAreaSurcharge, baseShippingWaived)
  const automaticShippingActive = hasFreeShipping || shippingSettings.auto_calculate_enabled || shippingSettings.special_area_enabled
  const automaticShipping = shippingSettings.auto_calculate_enabled || baseShippingWaived
    ? shippingCharge.total_shipping_fee
    : shippingCharge.special_area_surcharge
  const chargedStandardShipping = shippingSettings.auto_calculate_enabled ? shippingCharge.charged_standard_fee : 0
  const shippingCost = document && !isRenewal
    ? Number(document.shipping_cost || 0)
    : automaticShippingActive ? automaticShipping : Number(manualShipping || 0)
  const specialDiscount = Number(document?.special_discount || 0)
  const totalAmount = Math.max(0, subtotal + shippingCost - promotionDiscount - specialDiscount)
  const selectedSetting = settings.find(s => s.channel_code === form.channel_code && s.document_type === documentType)
  const headerName = selectedSetting?.header_name || PREBILL_TYPE_LABEL[documentType]
  const deliveryTerm = form.delivery_term === 'custom' ? form.delivery_custom.trim() : form.delivery_term
  const areaMatchMessage = !shippingSettings.special_area_enabled
    ? 'การคิดค่าพื้นที่ห่างไกลยังไม่ได้เปิดใช้งานในการตั้งค่าค่าส่ง'
    : !form.channel_code
      ? 'กรุณาเลือกช่องทางก่อนตรวจพื้นที่'
      : !channel?.default_carrier
        ? `ช่องทาง ${form.channel_code} ยังไม่ได้กำหนดบริษัทขนส่งเริ่มต้น`
        : !address.province.trim() || !address.district.trim()
          ? 'กรุณากรอกจังหวัดและอำเภอ/เขต หรือใช้ Auto fill'
          : areaRules.length === 0
            ? 'ยังไม่มีกฎพื้นที่ห่างไกลที่เปิดใช้งาน'
            : 'ไม่มีเก็บค่าพื้นที่ห่างไกลเพิ่ม'

  useEffect(() => {
    if (document || sourceDocument || !selectedSetting) return
    setForm(current => ({ ...current, valid_until: addDays(Number(selectedSetting.default_valid_days || 7)) }))
  }, [document, sourceDocument, selectedSetting])

  function fieldState(index: number, key: string): boolean | 'required' {
    const product = products.find(p => p.id === items[index]?.product_id)
    if (!product) return true
    const override = productFields[product.id]?.[key]
    if (override != null) return override === 'required' ? 'required' : override === true
    const category = product.product_category ? categoryFields[product.product_category] : undefined
    const value = category?.[key === 'product_type' ? 'layer' : key]
    return value === 'required' ? 'required' : value !== false
  }

  function updateItem(index: number, values: Partial<PreBillItem>) {
    setItems(current => {
      const source = current[index]
      const sourceId = source?.id
      return current.map((item, itemIndex) => {
        if (itemIndex === index) return { ...item, ...values }
        if (sourceId && values.quantity != null && String(item.field_snapshot?.auto_gift_source_item_id || '') === sourceId) {
          return { ...item, quantity: Math.max(1, Number(values.quantity || 1)) }
        }
        return item
      })
    })
  }

  function condoLayerCount(product?: Product | null): number {
    const category = String(product?.product_category || '').trim().toUpperCase()
    if (category === 'CONDO STAMP 2FL') return 2
    if (category === 'CONDO STAMP 3FL') return 3
    if (category === 'CONDO STAMP 5FL') return 5
    return 0
  }

  function isCondoItem(item: PreBillItem): boolean {
    const product = products.find(candidate => String(candidate.id) === String(item.product_id || ''))
    return condoLayerCount(product) > 0
  }

  function itemGroupNumber(targetIndex: number): number {
    let group = 0
    for (let index = 0; index <= targetIndex; index += 1) {
      const row = items[index]
      if (!isCondoItem(row) || !(row.is_detail_row || row.parent_item_id)) group += 1
    }
    return group
  }

  function itemDisplayNumber(targetIndex: number): string {
    const item = items[targetIndex]
    const group = itemGroupNumber(targetIndex)
    if (!isCondoItem(item)) return String(group)
    const isDetail = item.is_detail_row === true || Boolean(item.parent_item_id)
    const hasDetails = !isDetail && items.some(candidate => candidate.parent_item_id === item.id)
    if (!isDetail && !hasDetails) return String(group)
    const layer = Number(String(item.product_type || 'ชั้น1').replace(/\D/g, '')) || 1
    return `${group}-${layer}`
  }

  function itemGroupRowClass(index: number): string {
    if (!isCondoItem(items[index])) return ''
    const palettes = ['bg-sky-50/80', 'bg-violet-50/80', 'bg-amber-50/80', 'bg-emerald-50/80']
    const group = itemGroupNumber(index)
    const previousSameGroup = index > 0 && itemGroupNumber(index - 1) === group
    const nextSameGroup = index < items.length - 1 && itemGroupNumber(index + 1) === group
    return `${palettes[(group - 1) % palettes.length]} ${previousSameGroup ? '' : 'border-t-2 border-t-slate-400'} ${nextSameGroup ? '' : 'border-b-2 border-b-slate-400'}`
  }

  function withoutCondoDetailRows(source: PreBillItem[], parentIndex: number): PreBillItem[] {
    const parent = source[parentIndex]
    if (!parent) return source
    return source.filter((row, rowIndex) => {
      if (rowIndex === parentIndex) return true
      if (parent.id && row.parent_item_id === parent.id) return false
      return !(rowIndex > parentIndex && rowIndex <= parentIndex + 5 && row.is_detail_row && String(row.product_id || '') === String(parent.product_id || ''))
    })
  }

  function updateInkColor(index: number, inkColor: string) {
    setItems(current => {
      const sourceId = current[index]?.id || crypto.randomUUID()
      return current.map((item, itemIndex) => itemIndex === index ? { ...item, id: sourceId, ink_color: inkColor } : item)
    })
  }

  function removeItem(index: number) {
    setItems(current => {
      const selected = current[index]
      const parentId = selected?.is_detail_row ? selected.parent_item_id : selected?.id
      const removeIndexes = new Set<number>()
      current.forEach((row, rowIndex) => {
        if (rowIndex === index || (parentId && (row.id === parentId || row.parent_item_id === parentId))) removeIndexes.add(rowIndex)
        if (parentId && String(row.field_snapshot?.auto_gift_source_item_id || '') === String(parentId)) removeIndexes.add(rowIndex)
      })
      const lastRemoved = Math.max(...removeIndexes)
      const following = current[lastRemoved + 1]
      if (following?.is_free && PLASTIC_INK_BONUS_NAMES.has(following.product_name.trim())) removeIndexes.add(lastRemoved + 1)
      return current.filter((_, itemIndex) => !removeIndexes.has(itemIndex)).map((item, itemIndex) => ({ ...item, sort_order: itemIndex }))
    })
  }

  function selectProduct(index: number, value: string) {
    const normalized = value.trim().toLowerCase()
    const product = selectableProducts.find(p => p.id === value || String(p.product_code || '').toLowerCase() === normalized || p.product_name.toLowerCase() === normalized)
    setItems(current => {
      const pruned = withoutCondoDetailRows(current, index)
      const oldItem = pruned[index] || blankItem(index)
      if (!product) {
        pruned[index] = { ...oldItem, product_id: null, product_code: null, product_name: value, product_type: null, is_detail_row: false, parent_item_id: null }
        return pruned.map((item, itemIndex) => ({ ...item, sort_order: itemIndex }))
      }
      const layerCount = documentType === 'production_confirmation' ? condoLayerCount(product) : 0
      const parentId = oldItem.id || crypto.randomUUID()
      const parent: PreBillItem = {
        ...oldItem,
        id: parentId,
        product_id: product.id,
        product_code: product.product_code,
        product_name: product.product_name,
        product_type: layerCount > 0 ? 'ชั้น1' : oldItem.product_type,
        unit_price: MANUAL_PRICE_CHANNELS.has(form.channel_code) ? oldItem.unit_price : Number(priceMap[product.id] || 0),
        oh_snapshot: Number(stockMap[product.id] || 0),
        field_snapshot: { category: product.product_category },
        is_detail_row: false,
        parent_item_id: null,
      }
      pruned[index] = parent
      if (layerCount > 1) {
        const detailRows = Array.from({ length: layerCount - 1 }, (_, layerIndex): PreBillItem => ({
          ...blankItem(index + layerIndex + 1),
          id: crypto.randomUUID(),
          product_id: product.id,
          product_code: product.product_code,
          product_name: product.product_name,
          product_type: `ชั้น${layerIndex + 2}`,
          quantity: 1,
          unit_price: 0,
          oh_snapshot: Number(stockMap[product.id] || 0),
          field_snapshot: { category: product.product_category },
          is_detail_row: true,
          parent_item_id: parentId,
        }))
        pruned.splice(index + 1, 0, ...detailRows)
      }
      return pruned.map((item, itemIndex) => ({ ...item, sort_order: itemIndex }))
    })
  }

  function matchingProducts(search: string) {
    const normalized = search.trim().toLowerCase()
    const matches = selectableProducts.filter(product => !normalized ||
      product.product_name.toLowerCase().includes(normalized) ||
      String(product.product_code || '').toLowerCase().includes(normalized))
    return matches.sort((a, b) => {
      if (normalized) {
        const rank = (product: Product) => {
          const name = product.product_name.toLowerCase()
          const code = String(product.product_code || '').toLowerCase()
          if (name === normalized || code === normalized) return 0
          if (name.startsWith(normalized)) return 1
          if (code.startsWith(normalized)) return 2
          return 3
        }
        const rankDifference = rank(a) - rank(b)
        if (rankDifference !== 0) return rankDifference
      }
      return NATURAL_NAME_COLLATOR.compare(a.product_name, b.product_name)
    }).slice(0, 50)
  }

  function filteredPatternNames(index: number): string[] {
    const product = products.find(candidate => String(candidate.id) === String(items[index]?.product_id || ''))
    const category = product?.product_category?.trim() || null
    let available = patterns
    if (category) {
      available = available.filter(pattern => {
        if (Array.isArray(pattern.product_categories) && pattern.product_categories.length > 0) {
          return pattern.product_categories.some(patternCategory => String(patternCategory || '').trim() === category)
        }
        return String(pattern.product_category || '').trim() === category
      })
    }
    return available
      .slice()
      .sort((left, right) => NATURAL_NAME_COLLATOR.compare(left.pattern_name || '', right.pattern_name || ''))
      .map(pattern => pattern.pattern_name)
      .filter(Boolean)
  }

  function updatePattern(index: number, value: string) {
    const matched = patterns.find(pattern => pattern.pattern_name.trim().toLowerCase() === value.trim().toLowerCase())
    const updates: Partial<PreBillItem> = { cartoon_pattern: matched?.pattern_name || value }
    const lineCount = matched?.line_count
    if (lineCount === 0) {
      updates.line_1 = ''; updates.line_2 = ''; updates.line_3 = ''
    } else if (lineCount === 1) {
      updates.line_2 = ''; updates.line_3 = ''
    } else if (lineCount === 2) {
      updates.line_3 = ''
    }
    updateItem(index, updates)
  }

  function togglePromotion(promotion: PromotionDefinition, checked: boolean) {
    setSelectedPromotionIds(current => checked ? [...new Set([...current, promotion.id])] : current.filter(id => id !== promotion.id))
    setPromotionApplicationCounts(current => {
      if (!checked) {
        const next = { ...current }; delete next[promotion.id]; return next
      }
      return { ...current, [promotion.id]: current[promotion.id] || 1 }
    })
  }

  function updatePromotionCount(promotion: PromotionDefinition, value: number) {
    const limit = promotionApplicationLimit(promotion)
    setPromotionApplicationCounts(current => ({ ...current, [promotion.id]: Math.min(limit, Math.max(1, Math.floor(value || 1))) }))
  }

  function renderPromotionChoice(promotion: PromotionDefinition, showStar = false) {
    const selected = selectedPromotionIds.includes(promotion.id)
    const result = promoResults.find(item => item.promotion_id === promotion.id)
    const limit = promotionApplicationLimit(promotion)
    return (
      <div key={promotion.id} className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-blue-50">
        <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2">
          <input type="checkbox" checked={selected} onChange={event => togglePromotion(promotion, event.target.checked)} className="mt-0.5 h-4 w-4 rounded border-gray-300 accent-blue-600" />
          <span className="min-w-0 flex-1"><span className="font-medium">{showStar && <span className="mr-1 text-amber-500">★</span>}{promotion.name}</span>{selected && result?.checked && <span className={`ml-2 text-xs font-semibold ${result.passed ? 'text-emerald-600' : 'text-red-600'}`}>{result.passed ? 'ผ่าน' : 'ไม่ผ่าน'}</span>}</span>
        </label>
        {limit > 1 && <input type="number" inputMode="numeric" min="1" max={limit} step="1" value={promotionApplicationCounts[promotion.id] || 1} disabled={!selected} onWheel={event => event.currentTarget.blur()} onChange={event => updatePromotionCount(promotion, Number(event.target.value))} aria-label={`จำนวน ${promotion.name} ต่อเอกสาร`} title={`ระบุจำนวนที่ใช้ (สูงสุด ${limit})`} className="w-14 shrink-0 appearance-none rounded-md border px-2 py-1 text-center text-xs tabular-nums [appearance:textfield] disabled:bg-gray-100 disabled:text-gray-400 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />}
      </div>
    )
  }

  function openProductDropdown(index: number, input: HTMLInputElement, resetSearch = false) {
    const rect = input.getBoundingClientRect()
    const dropdownWidth = Math.min(Math.max(rect.width, 520), window.innerWidth - 24)
    setProductDropdownPosition({
      left: Math.max(12, Math.min(rect.left, window.innerWidth - dropdownWidth - 12)),
      top: rect.bottom + 4,
      width: dropdownWidth,
      maxHeight: Math.max(140, Math.min(288, window.innerHeight - rect.bottom - 20)),
    })
    if (resetSearch) setProductSearchTerms(current => ({ ...current, [index]: '' }))
    setOpenProductIndex(index)
  }

  function validationError(status: 'draft' | 'active'): string | null {
    if (!form.channel_code) return 'กรุณาเลือกช่องทาง'
    if (!form.customer_name.trim()) return 'กรุณากรอกชื่อลูกค้า'
    if (!deliveryTerm) return 'กรุณาระบุระยะเวลาจัดส่ง'
    if (!form.valid_until) return 'กรุณาระบุวันที่ยืนราคา'
    if (!items.length || items.some(item => !item.product_id || !item.product_name.trim())) return 'กรุณาเลือกสินค้าให้ครบทุกรายการ'
    for (let i = 0; i < items.length; i++) {
      for (const key of ['ink_color','product_type','cartoon_pattern','font','line_1','line_2','line_3','notes']) {
        if (fieldState(i, key) === 'required' && !String((items[i] as any)[key] || '').trim()) return `รายการ ${i + 1}: กรุณากรอก ${key}`
      }
    }
    const failed = status === 'active' ? promoResults.find(r => r.checked && !r.passed) : undefined
    if (failed) return `${failed.promotion_name}: ${failed.messages.join(', ')}`
    return null
  }

  async function save(status: 'draft' | 'active' = 'active', closeAfterSave = true): Promise<PreBillDocument | null> {
    if (locked || expired) return null
    const error = validationError(status)
    if (error) { setMessage(error); return null }
    setSaving(true); setMessage('')
    try {
      let id = document?.id
      let documentNo = document?.document_no
      if (!id) {
        const noResult = await supabase.rpc('rpc_next_prebill_document_no', { p_channel_code: form.channel_code, p_document_type: documentType })
        if (noResult.error) throw noResult.error
        documentNo = String(noResult.data)
      }
      const ownerName = sellerName || document?.owner_name || user?.username || user?.email || '-'
      const payload = {
        document_type: documentType, document_no: documentNo!, status,
        channel_code: form.channel_code, header_name: headerName, customer_name: form.customer_name.trim(),
        customer_address: form.customer_address.trim() || [address.address_line, address.sub_district, address.district, address.province, address.postal_code].filter(Boolean).join(' ') || null,
        recipient_name: form.recipient_name.trim() || null, customer_phone: form.customer_phone.trim() || null,
        billing_details: { ...address, mobile_phone: form.customer_phone.trim() || null }, delivery_term: deliveryTerm, valid_until: form.valid_until,
        payment_method: form.payment_method || null, subtotal, shipping_cost: shippingCost,
        promotion_discount: promotionDiscount, special_discount: document?.special_discount || 0,
        total_amount: totalAmount, promotion_ids: selectedPromotionIds,
        promotion_snapshot: selectedPromotions.map(p => ({ ...p, evaluation: promoResults.find(r => r.promotion_id === p.id) })),
        shipping_snapshot: {
          matched_area: matchedArea,
          standard_shipping: standardShipping,
          special_area_surcharge: specialAreaSurcharge,
          base_shipping_waived: baseShippingWaived,
          automatic_shipping: automaticShipping,
          automatic_shipping_active: automaticShippingActive,
          charged_standard_shipping: chargedStandardShipping,
        },
        internal_note: form.internal_note.trim() || null, owner_id: document?.owner_id || user!.id,
        owner_name: ownerName, source_document_id: isRenewal ? sourceDocument!.id : document?.source_document_id || null,
      }
      if (id) {
        const result = await supabase.from('or_prebill_documents').update(payload).eq('id', id).select().single()
        if (result.error) throw result.error
      } else {
        const result = await supabase.from('or_prebill_documents').insert(payload).select().single()
        if (result.error) throw result.error
        id = result.data.id
      }
      const del = await supabase.from('or_prebill_items').delete().eq('document_id', id)
      if (del.error) throw del.error
      const rows = items.map((item, index) => ({
        id: item.id || crypto.randomUUID(), document_id: id, sort_order: index, product_id: item.product_id, product_code: item.product_code,
        product_name: item.product_name, quantity: Number(item.quantity || 1), unit_price: item.is_free ? 0 : Number(item.unit_price || 0),
        is_free: item.is_free, is_detail_row: item.is_detail_row === true, parent_item_id: item.parent_item_id || null,
        oh_snapshot: Number(stockMap[String(item.product_id)] ?? item.oh_snapshot ?? 0),
        ink_color: item.ink_color || null, product_type: item.product_type || null, cartoon_pattern: item.cartoon_pattern || null,
        line_pattern: item.line_pattern || null, font: item.font || null, line_1: item.line_1 || null, line_2: item.line_2 || null,
        line_3: item.line_3 || null, no_name_line: item.no_name_line, notes: item.notes || null,
        file_attachment: item.file_attachment || null, attachment_name: item.attachment_name || null, field_snapshot: item.field_snapshot || {},
      }))
      const itemResult = await supabase.from('or_prebill_items').insert(rows)
      if (itemResult.error) throw itemResult.error
      setMessage(status === 'draft' ? 'บันทึกร่างแล้ว' : 'บันทึกเอกสารแล้ว')
      if (closeAfterSave) onSaved()
      return { ...payload, id, document_no: documentNo!, created_at: document?.created_at || new Date().toISOString(), updated_at: new Date().toISOString(), or_prebill_items: rows } as unknown as PreBillDocument
    } catch (error: any) {
      setMessage(error.message || String(error)); return null
    } finally { setSaving(false) }
  }

  async function requestDiscount() {
    const target = await save('active', false)
    if (!target) return
    const result = await supabase.rpc('rpc_request_prebill_discount', {
      p_document_id: target.id, p_discount_type: discountRequest.type,
      p_discount_value: Number(discountRequest.value), p_note: discountRequest.note,
    })
    if (result.error) { setMessage(result.error.message); return }
    setDiscountModal(false); onSaved()
  }

  const previewDocument: Partial<PreBillDocument> = {
    ...document, document_type: documentType, document_no: document?.document_no || '', channel_code: form.channel_code,
    owner_name: sellerName || document?.owner_name || user?.username || user?.email || '-',
    header_name: headerName, customer_name: form.customer_name,
    customer_address: form.customer_address || [address.address_line, address.sub_district, address.district, address.province, address.postal_code].filter(Boolean).join(' '),
    recipient_name: form.recipient_name, customer_phone: form.customer_phone, delivery_term: deliveryTerm, valid_until: form.valid_until,
    payment_method: form.payment_method, subtotal, shipping_cost: shippingCost, promotion_discount: promotionDiscount,
    special_discount: specialDiscount, total_amount: totalAmount,
    shipping_snapshot: {
      matched_area: matchedArea,
      standard_shipping: standardShipping,
      charged_standard_shipping: chargedStandardShipping,
      special_area_surcharge: specialAreaSurcharge,
      base_shipping_waived: baseShippingWaived,
      automatic_shipping_active: automaticShippingActive,
    },
  }

  async function captureCanvas() {
    if (!previewRef.current) throw new Error('ไม่พบตัวอย่างเอกสาร')
    return html2canvas(previewRef.current, { scale: 2, backgroundColor: '#ffffff', logging: false })
  }
  async function copyImage() {
    try {
      const canvas = await captureCanvas(); const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('สร้างรูปไม่สำเร็จ')
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); showToast('คัดลอกรูปสำเร็จ')
    } catch (error: any) { setMessage(`คัดลอกรูปไม่สำเร็จ: ${error.message || error}`) }
  }
  async function downloadImage() {
    const canvas = await captureCanvas(); const link = window.document.createElement('a')
    link.download = `${document?.document_no || documentType}.png`; link.href = canvas.toDataURL('image/png'); link.click()
  }
  async function downloadPdf() {
    const html2pdf = (await import('html2pdf.js')).default
    await html2pdf().set({ margin: 0, filename: `${document?.document_no || documentType}.pdf`, image: { type: 'jpeg', quality: 0.98 }, html2canvas: { scale: 2 }, jsPDF: { unit: 'px', format: [794, 1123], orientation: 'portrait' } }).from(previewRef.current!).save()
  }
  async function copyText() {
    try {
      await navigator.clipboard.writeText(buildPreBillCustomerText(previewDocument, items))
      showToast('คัดลอกข้อความสำเร็จ')
    } catch (error: any) {
      setMessage(`คัดลอกข้อความไม่สำเร็จ: ${error.message || error}`)
    }
  }

  if (loading) return <div className="p-10 text-center text-slate-500">กำลังโหลดข้อมูล...</div>

  return (
    <div className="space-y-5 pb-12">
      {toast && <div role="status" className="fixed bottom-6 left-1/2 z-[400] -translate-x-1/2 rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-2xl">{toast}</div>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold">{document ? `${permanentlyLocked ? 'ดู' : 'แก้ไข'} ${document.document_no}` : `สร้าง${PREBILL_TYPE_LABEL[documentType]}`}</h2>
          {isRenewal && <p className="text-sm text-blue-600">สร้างใหม่จาก {sourceDocument?.document_no} โดยใช้ราคาและโปรโมชั่นปัจจุบัน</p>}
          {(locked || expired) && <p className="mt-1 text-sm font-semibold text-amber-700">{expired ? 'เอกสารหมดอายุแล้ว กรุณาสร้างใหม่จากข้อมูลเดิม' : permanentlyLocked ? 'เอกสารที่เปิดบิลหรือยกเลิกแล้วเป็นแบบอ่านอย่างเดียว' : 'เอกสารถูกล็อกระหว่าง/หลังการอนุมัติ'}</p>}
        </div>
        <button type="button" onClick={onCancel} className="rounded-xl border px-4 py-2 font-semibold">กลับรายการ</button>
      </div>

      {message && <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-blue-800">{message}</div>}

      <fieldset disabled={locked || expired || saving} className="space-y-5 disabled:opacity-75">
        <section className="grid grid-cols-1 gap-4 rounded-2xl bg-white p-5 shadow-sm md:grid-cols-2 lg:grid-cols-4">
          <label className="text-sm font-semibold">ช่องทาง *
            <select value={form.channel_code} onChange={e => { priceRefreshChannelRef.current = e.target.value; setForm(v => ({ ...v, channel_code: e.target.value })); setManualShipping(null) }} className="mt-1 w-full rounded-xl border p-2.5 bg-white">
              <option value="">เลือกช่องทาง</option>{channels.map(c => <option key={c.channel_code} value={c.channel_code}>{c.channel_code} — {c.channel_name}</option>)}
            </select>
          </label>
          <label className="text-sm font-semibold">ชื่อลูกค้า *<input value={form.customer_name} onChange={e => setForm(v => ({ ...v, customer_name: e.target.value }))} className="mt-1 w-full rounded-xl border p-2.5" /></label>
          <label className="text-sm font-semibold">ชื่อผู้รับ<input value={form.recipient_name} onChange={e => setForm(v => ({ ...v, recipient_name: e.target.value }))} className="mt-1 w-full rounded-xl border p-2.5" /></label>
          <label className="text-sm font-semibold">เบอร์โทร<input value={form.customer_phone} onChange={e => setForm(v => ({ ...v, customer_phone: e.target.value }))} className="mt-1 w-full rounded-xl border p-2.5" /></label>
          <div className="text-sm font-semibold lg:col-span-2"><div className="flex items-center justify-between gap-2"><span>ที่อยู่ (ไม่บังคับ)</span><button type="button" disabled={autoFillAddressLoading || !form.customer_address.trim()} onClick={() => void handleAutoFillAddress()} className="rounded-lg bg-blue-100 px-2.5 py-1 text-xs text-blue-700 disabled:opacity-50">{autoFillAddressLoading ? 'กำลังแยก...' : 'Auto fill'}</button></div><textarea value={form.customer_address} onChange={e => setForm(v => ({ ...v, customer_address: e.target.value }))} onPaste={e => { const pasted = e.clipboardData.getData('text'); if (!pasted.trim()) return; const target = e.currentTarget; const next = target.value.slice(0, target.selectionStart ?? target.value.length) + pasted + target.value.slice(target.selectionEnd ?? target.value.length); window.setTimeout(() => void handleAutoFillAddress(next), 0) }} className="mt-1 min-h-36 w-full resize-y rounded-xl border p-2.5 font-normal" rows={5} placeholder="วางที่อยู่พร้อมรหัสไปรษณีย์ แล้วกด Auto fill" /></div>
          <label className="text-sm font-semibold">ระยะเวลาจัดส่ง *
            <select value={form.delivery_term} onChange={e => setForm(v => ({ ...v, delivery_term: e.target.value }))} className="mt-1 w-full rounded-xl border p-2.5 bg-white">
              {['1-3 วัน','7 วัน','14 วัน','30 วัน'].map(v => <option key={v}>{v}</option>)}<option value="custom">ระบุเอง</option>
            </select>
            {form.delivery_term === 'custom' && <input value={form.delivery_custom} onChange={e => setForm(v => ({ ...v, delivery_custom: e.target.value }))} placeholder="เช่น 45 วัน" className="mt-2 w-full rounded-xl border p-2.5" />}
          </label>
          <label className="text-sm font-semibold">ยืนราคาถึงวันที่ *<input type="date" min={today()} value={form.valid_until} onChange={e => setForm(v => ({ ...v, valid_until: e.target.value }))} className="mt-1 w-full rounded-xl border p-2.5" /></label>
        </section>

        <details className="rounded-2xl bg-white p-5 shadow-sm" open={!!form.customer_address}>
          <summary className="cursor-pointer font-bold">ข้อมูลที่อยู่สำหรับตรวจพื้นที่ห่างไกล</summary>
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-5">
            <label className="text-xs font-semibold">ที่อยู่<input value={address.address_line} onChange={e => { setAddress(v => ({ ...v, address_line: e.target.value })); setManualShipping(null) }} className="mt-1 w-full rounded-lg border p-2" /></label>
            <label className="text-xs font-semibold">ตำบล/แขวง{subDistrictOptions.length > 0 ? <select value={subDistrictOptions.findIndex(option => option.subDistrict === address.sub_district)} onChange={e => { const option = subDistrictOptions[Number(e.target.value)]; if (option) { setAddress(v => ({ ...v, sub_district: option.subDistrict, district: option.district })); setManualShipping(null) } }} className="mt-1 w-full rounded-lg border bg-white p-2"><option value={-1}>เลือกตำบล/แขวง</option>{subDistrictOptions.map((option, optionIndex) => <option key={`${option.subDistrict}-${option.district}`} value={optionIndex}>{option.subDistrict}</option>)}</select> : <input value={address.sub_district} onChange={e => { setAddress(v => ({ ...v, sub_district: e.target.value })); setManualShipping(null) }} className="mt-1 w-full rounded-lg border p-2" />}</label>
            <label className="text-xs font-semibold">อำเภอ/เขต<input value={address.district} onChange={e => { setAddress(v => ({ ...v, district: e.target.value })); setManualShipping(null) }} className="mt-1 w-full rounded-lg border p-2" /></label>
            <label className="text-xs font-semibold">จังหวัด<input value={address.province} onChange={e => { setAddress(v => ({ ...v, province: e.target.value })); setManualShipping(null) }} className="mt-1 w-full rounded-lg border p-2" /></label>
            <label className="text-xs font-semibold">รหัสไปรษณีย์<input value={address.postal_code} onChange={e => { setAddress(v => ({ ...v, postal_code: e.target.value })); setManualShipping(null) }} className="mt-1 w-full rounded-lg border p-2" /></label>
          </div>
          {matchedArea ? <p className="mt-3 font-semibold text-violet-700">พบ{SHIPPING_AREA_TYPE_LABELS[matchedArea.area_type]}: เพิ่ม {money(matchedArea.surcharge)} บาท · {channel?.default_carrier}</p> : <p className="mt-3 text-sm text-amber-700">{areaMatchMessage}</p>}
        </details>

        <section className="overflow-x-auto rounded-2xl bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between"><h3 className="text-lg font-bold">รายการสินค้า</h3></div>
          <table className={`${documentType === 'production_confirmation' ? 'min-w-[1720px]' : 'min-w-[980px]'} w-full border-collapse text-sm`}>
            <thead><tr className="bg-slate-100"><th className="w-10 border p-1 text-center text-[10px]">ฟรี</th><th className="w-10 border p-1 text-center text-[10px]">#</th><th className={`${documentType === 'production_confirmation' ? 'min-w-[240px]' : 'min-w-[360px]'} border p-1.5`}>ชื่อสินค้า</th><th className="w-14 border p-1 text-center text-[10px]">OH</th>{documentType === 'production_confirmation' && <><th className="w-32 border p-1.5">สีหมึก</th><th className="w-16 border p-1.5">ชั้น</th><th className="w-28 border p-1.5">ลาย</th><th className="w-24 border p-1.5">ฟอนต์</th><th className="w-14 border p-1 text-center text-[10px] whitespace-nowrap">ไม่รับชื่อ</th><th className="min-w-[150px] border p-1.5">บรรทัด 1</th><th className="min-w-[150px] border p-1.5">บรรทัด 2</th><th className="min-w-[150px] border p-1.5">บรรทัด 3</th></>}<th className="w-20 border p-1.5">จำนวน</th><th className="w-24 border p-1 text-[10px] whitespace-nowrap">ราคา/หน่วย</th><th className="min-w-[150px] border p-1.5">หมายเหตุ</th>{documentType === 'production_confirmation' && <th className="min-w-[140px] border p-1.5">ไฟล์แนบ</th>}<th className="w-10 border p-1.5" /></tr></thead>
            <tbody>{items.map((item, index) => (
              <tr key={item.id || index} className={`align-middle ${itemGroupRowClass(index)} ${item.is_free ? 'bg-green-50' : ''}`}>
                <td className="border p-1 text-center">{item.is_detail_row ? <span className="text-slate-400">-</span> : <input type="checkbox" checked={item.is_free} onChange={e => updateItem(index, { is_free: e.target.checked, unit_price: e.target.checked ? 0 : item.unit_price })} className="h-4 w-4 align-middle" />}</td>
                <td className="border p-1 text-center text-xs font-semibold text-slate-600">{itemDisplayNumber(index)}</td>
                <td className="border p-1.5"><div className="relative w-full"><input ref={element => { productInputRefs.current[index] = element }} value={item.product_name} disabled={item.is_detail_row} placeholder="ค้นหาหรือเลือกสินค้า..." onFocus={event => { if (!item.is_detail_row) openProductDropdown(index, event.currentTarget, true) }} onChange={event => { selectProduct(index, event.target.value); setProductSearchTerms(current => ({ ...current, [index]: event.target.value })); openProductDropdown(index, event.currentTarget) }} onBlur={() => window.setTimeout(() => { setOpenProductIndex(current => current === index ? null : current); setProductDropdownPosition(null) }, 150)} className="w-full rounded border px-1.5 py-1 pr-7 text-xs disabled:bg-slate-100" autoComplete="off" />{!item.is_detail_row && <button type="button" tabIndex={-1} onMouseDown={event => event.preventDefault()} onClick={() => { const input = productInputRefs.current[index]; if (!input) return; if (openProductIndex === index) { setOpenProductIndex(null); setProductDropdownPosition(null) } else openProductDropdown(index, input, true) }} className="absolute right-0 top-0 h-7 w-7 text-slate-500">▾</button>}</div></td>
                <td className="border p-1 text-center align-middle text-xs font-semibold">{item.product_id ? Number(stockMap[String(item.product_id)] ?? item.oh_snapshot).toLocaleString() : <span className="text-slate-400">-</span>}</td>
                {documentType === 'production_confirmation' && <>
                  <td className="border p-1.5">{fieldState(index,'ink_color') ? <select value={item.ink_color || ''} onChange={e => updateInkColor(index, e.target.value)} className="w-full rounded border px-1.5 py-1 text-xs"><option value="">เลือกสี</option>{inkTypes.map(value => <option key={value} value={value}>{value}</option>)}</select> : '-'}</td>
                  <td className="border p-1.5">{fieldState(index,'product_type') ? <input value={item.product_type || ''} placeholder="ชั้น1" onChange={e => updateItem(index, { product_type: e.target.value })} className="w-full rounded border px-1.5 py-1 text-xs" /> : '-'}</td>
                  <td className="border p-1.5">{fieldState(index,'cartoon_pattern') ? <LookupDropdownInput value={item.cartoon_pattern || ''} options={filteredPatternNames(index)} placeholder="ลาย" onChange={value => updatePattern(index, value)} /> : '-'}</td>
                  <td className="border p-1.5">{fieldState(index,'font') ? <LookupDropdownInput value={item.font || ''} options={fonts} placeholder="F01" onChange={value => updateItem(index, { font: value })} /> : '-'}</td>
                  <td className="border p-1 text-center"><input type="checkbox" checked={item.no_name_line} onChange={e => updateItem(index, { no_name_line: e.target.checked })} className="h-4 w-4 align-middle" /></td>
                  {(['line_1','line_2','line_3'] as const).map((key, lineIndex) => <td key={key} className="border p-1.5">{fieldState(index,key) ? <input value={item[key] || ''} disabled={item.no_name_line} placeholder={`บรรทัด ${lineIndex + 1}`} onChange={e => updateItem(index, { [key]: e.target.value })} className="w-full rounded border px-1.5 py-1 text-xs disabled:bg-slate-100" /> : '-'}</td>)}
                </>}
                <td className="border p-1.5"><input type="number" min="1" value={item.quantity} disabled={item.is_detail_row} onChange={e => updateItem(index, { quantity: Math.max(1, Number(e.target.value)) })} className="w-full rounded border px-1.5 py-1 text-xs disabled:bg-slate-100" /></td>
                <td className="border p-1.5"><input type="number" min="0" value={item.unit_price} placeholder="0.00" disabled={item.is_detail_row || item.is_free || (!MANUAL_PRICE_CHANNELS.has(form.channel_code) && !!item.product_id)} onChange={e => updateItem(index, { unit_price: Number(e.target.value) })} className="w-full rounded border px-1.5 py-1 text-xs disabled:bg-slate-100 disabled:text-slate-500" /></td>
                <td className="border p-1.5">{fieldState(index,'notes') ? <input value={item.notes || ''} placeholder="หมายเหตุเพิ่มเติม" onChange={e => updateItem(index, { notes: e.target.value })} className="w-full rounded border px-1.5 py-1 text-xs" /> : '-'}</td>
                {documentType === 'production_confirmation' && <td className="border p-1.5"><div className="space-y-1"><input value={item.attachment_name || ''} disabled={!fieldState(index,'attachment')} placeholder="ชื่อกำกับ" onChange={e => updateItem(index, { attachment_name: e.target.value })} className="w-full rounded border px-1.5 py-1 text-xs disabled:bg-slate-100" /><input value={item.file_attachment || ''} disabled={!fieldState(index,'attachment')} placeholder="ไฟล์แนบ (URL)" onChange={e => updateItem(index, { file_attachment: e.target.value })} className="w-full rounded border px-1.5 py-1 text-xs disabled:bg-slate-100" /></div></td>}
                <td className="border p-1 text-center"><button type="button" disabled={items.length === 1} onClick={() => removeItem(index)} className="h-7 w-7 rounded bg-red-500 font-bold text-white hover:bg-red-600 disabled:bg-slate-200">×</button></td>
              </tr>
            ))}</tbody>
          </table>
          {tubeGiftMissing && <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-2 text-sm font-semibold text-amber-800">พบสินค้า TUBE แต่ไม่พบสินค้าของแถมรหัส {TUBE_GIFT_PRODUCT_CODE} ที่เปิดใช้งาน จึงยังไม่สามารถเพิ่มเชือกอัตโนมัติได้</p>}
          {jumboSharpenerGiftMissing && <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-2 text-sm font-semibold text-amber-800">พบสินค้าที่ร่วมรายการ แต่ไม่พบสินค้าของแถมรหัส {JUMBO_SHARPENER_GIFT_PRODUCT_CODE} ที่เปิดใช้งาน จึงยังไม่สามารถเพิ่มกบเหลา JUMBO อัตโนมัติได้</p>}
          {missingPlasticGiftNames.length > 0 && <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-2 text-sm font-semibold text-amber-800">ไม่พบสินค้าหมึกพลาสติกของแถมที่เปิดใช้งาน: {missingPlasticGiftNames.join(', ')}</p>}
          <button type="button" onClick={() => setItems(current => [...current, blankItem(current.length)])} className="mt-4 rounded bg-slate-600 px-4 py-2 text-sm font-bold text-white hover:bg-slate-700">+ เพิ่มแถว</button>
        </section>

        {openProductIndex !== null && productDropdownPosition && createPortal(<div className="fixed z-[300] overflow-auto rounded-xl border border-slate-200 bg-white py-1 shadow-2xl" style={{ left: productDropdownPosition.left, top: productDropdownPosition.top, width: productDropdownPosition.width, maxHeight: productDropdownPosition.maxHeight }}>{matchingProducts(productSearchTerms[openProductIndex] ?? '').length > 0 ? matchingProducts(productSearchTerms[openProductIndex] ?? '').map(product => <button key={product.id} type="button" onMouseDown={event => { event.preventDefault(); selectProduct(openProductIndex, product.id); setOpenProductIndex(null); setProductDropdownPosition(null) }} className="block w-full whitespace-nowrap px-3 py-2 text-left hover:bg-blue-50"><span className="block font-semibold">{product.product_name}</span><span className="block text-xs text-slate-500">{product.product_code}</span></button>) : <div className="px-3 py-4 text-center text-slate-500">ไม่พบสินค้า</div>}</div>, globalThis.document.body)}

        <section className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div className="rounded-2xl bg-white p-5 shadow-sm space-y-4">
            <h3 className="text-lg font-bold">โปรโมชั่นและการชำระเงิน</h3>
            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-semibold">โปรโมชั่น</span><span className={`rounded-full px-3 py-1 text-xs font-bold ${selectedPromotionIds.length > 0 ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500'}`}>เลือกแล้ว {selectedPromotionIds.length} โปรฯ</span></div>
              <div className="rounded-xl border bg-white p-3">
                <div className="mb-3">
                  <p className="mb-1.5 text-xs font-semibold text-gray-500">โปรโมชั่นที่เลือก</p>
                  {selectedPromotions.length === 0 ? <p className="rounded-lg border border-dashed px-3 py-2 text-sm text-gray-400">ยังไม่ได้เลือกโปรโมชั่น</p> : <div className="flex flex-wrap gap-2">{selectedPromotions.map(promotion => {
                    const result = promoResults.find(item => item.promotion_id === promotion.id)
                    return <span key={promotion.id} className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold ${result?.checked && !result.passed ? 'border-red-200 bg-red-50 text-red-700' : 'border-blue-200 bg-blue-50 text-blue-700'}`}>{promotion.name}{promotionApplicationLimit(promotion) > 1 && ` ×${promotionApplicationCounts[promotion.id] || 1}`}<button type="button" onClick={() => togglePromotion(promotion, false)} className="ml-0.5 rounded-full px-1 text-sm leading-none hover:bg-white/80" aria-label={`ยกเลิกโปรโมชั่น ${promotion.name}`} title="ยกเลิกโปรโมชั่นนี้">×</button></span>
                  })}</div>}
                </div>
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <div className="min-w-0"><div className="mb-1 flex items-center justify-between gap-2"><p className="text-xs font-bold text-amber-700">★ โปรฯ ติดดาว</p><span className="text-[10px] text-amber-600">{featuredPromotions.length} รายการ</span></div><div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-amber-200 bg-amber-50/40 p-1">{featuredPromotions.length === 0 ? <p className="px-2 py-4 text-center text-xs text-gray-400">ยังไม่มีโปรฯ ติดดาว</p> : featuredPromotions.map(promotion => renderPromotionChoice(promotion, true))}</div></div>
                  <div className="min-w-0"><div className="mb-1 flex items-center justify-between gap-2"><p className="text-xs font-bold text-gray-600">รายการโปรฯ ทั้งหมด</p><span className="text-[10px] text-gray-400">{promotionsForSelection.length} รายการ</span></div><div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border bg-white p-1">{promotionsForSelection.length === 0 ? <p className="px-2 py-4 text-center text-xs text-gray-400">ยังไม่มีโปรโมชั่นที่เปิดใช้งาน</p> : promotionsForSelection.map(promotion => renderPromotionChoice(promotion, promotion.is_featured === true))}</div></div>
                </div>
              </div>
              {selectedPromotionIds.length > 0 && <div className="mt-2 space-y-1">{promoResults.filter(result => result.checked).map(result => <p key={result.promotion_id} className={`text-xs ${result.passed ? 'text-emerald-600' : 'text-red-600'}`}>{result.promotion_name}: {result.passed ? `ผ่าน${result.expected_discount > 0 ? ` · ส่วนลด ${money(result.expected_discount)} บาท` : ''}${selectedPromotions.find(promotion => promotion.id === result.promotion_id)?.free_shipping ? ' · ส่งฟรี' : ''}` : result.messages.join(' · ')}</p>)}</div>}
            </div>
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3"><div className="mb-2 text-sm font-semibold text-amber-900">ส่วนลดที่ต้องการขออนุมัติ</div><div className="grid grid-cols-3 gap-2"><select value={discountRequest.type} onChange={e => setDiscountRequest(current => ({ ...current, type: e.target.value as 'amount' | 'percent' }))} className="rounded-lg border bg-white p-2 text-sm"><option value="amount">บาท</option><option value="percent">เปอร์เซ็นต์</option></select><input type="number" min="0" value={discountRequest.value} onChange={e => setDiscountRequest(current => ({ ...current, value: e.target.value }))} placeholder="ส่วนลด" className="col-span-2 rounded-lg border p-2 text-sm" /></div><textarea value={discountRequest.note} onChange={e => setDiscountRequest(current => ({ ...current, note: e.target.value }))} placeholder="หมายเหตุคำขอส่วนลด" rows={2} className="mt-2 w-full rounded-lg border p-2 text-sm" /></div>
          </div>
          <div className="rounded-2xl bg-white p-5 shadow-sm">
            <h3 className="text-lg font-bold">สรุปยอด</h3>
            <div className="mt-4 space-y-3">
              <div className="flex justify-between"><span>ยอดสินค้า</span><b>{money(subtotal)}</b></div>
              <div className="flex justify-between text-emerald-700"><span>ส่วนลดโปรโมชั่น</span><b>-{money(promotionDiscount)}</b></div>
              {specialDiscount > 0 && <div className="flex justify-between text-emerald-700"><span>ส่วนลดพิเศษที่อนุมัติ</span><b>-{money(specialDiscount)}</b></div>}
              {automaticShippingActive ? <div className="space-y-2 rounded-xl border bg-slate-50 p-3 text-sm"><div className="flex justify-between text-sky-700"><span>ค่าจัดส่งปกติ{baseShippingWaived ? ' (ยกเว้น)' : ''}</span><b>{money(chargedStandardShipping)} บาท</b></div><div className="flex justify-between text-violet-700"><span>ค่าพื้นที่ห่างไกล/พิเศษ</span><b>{money(specialAreaSurcharge)} บาท</b></div><label className="flex items-center justify-between gap-4 border-t pt-2 font-semibold"><span>ค่าจัดส่งรวม</span><input type="number" min="0" value={shippingCost} disabled className="w-32 rounded-lg border bg-slate-100 p-2 text-right" /></label>{baseShippingWaived && standardShipping > 0 && <p className="text-xs text-slate-500">ค่าจัดส่งปกติก่อนยกเว้น {money(standardShipping)} บาท</p>}</div> : <label className="flex items-center justify-between gap-4"><span>ค่าจัดส่ง</span><input type="number" min="0" value={shippingCost} disabled={!!document} onChange={e => setManualShipping(Number(e.target.value))} className="w-32 rounded-lg border p-2 text-right disabled:bg-slate-100" /></label>}
              <div className="flex justify-between border-t-2 pt-4 text-xl text-blue-700"><b>ยอดสุทธิ</b><b>{money(totalAmount)} บาท</b></div>
              <label className="block pt-2 text-sm font-semibold text-slate-800">วิธีการชำระเงิน<select value={form.payment_method} onChange={e => setForm(v => ({ ...v, payment_method: e.target.value }))} className="mt-1 w-full rounded-xl border bg-white p-2.5"><option>โอน</option><option>เงินสด</option><option>เก็บเงินปลายทาง</option><option>เครดิต</option></select></label>
              <label className="block text-sm font-semibold text-slate-800">หมายเหตุภายใน<textarea value={form.internal_note} onChange={e => setForm(v => ({ ...v, internal_note: e.target.value }))} rows={3} className="mt-1 w-full rounded-xl border p-2.5" /></label>
            </div>
          </div>
        </section>
      </fieldset>

      <div className="flex flex-wrap gap-2 rounded-2xl bg-white p-4 shadow-sm">
        {!locked && !expired && <><button disabled={saving} onClick={() => save('draft')} className="rounded-xl border px-4 py-2 font-bold">บันทึกร่าง</button><button disabled={saving} onClick={() => save('active')} className="rounded-xl bg-blue-600 px-4 py-2 font-bold text-white">บันทึก</button><button disabled={saving} onClick={() => setDiscountModal(true)} className="rounded-xl bg-amber-500 px-4 py-2 font-bold text-white">ขอส่วนลด</button></>}
        <button onClick={() => setPreviewOpen(true)} className="rounded-xl border px-4 py-2 font-bold">ตัวอย่าง</button>
        <button onClick={copyImage} className="rounded-xl border px-4 py-2 font-bold">คัดลอกรูป</button>
        <button onClick={downloadImage} className="rounded-xl border px-4 py-2 font-bold">ดาวน์โหลดรูป</button>
        <button onClick={downloadPdf} className="rounded-xl border px-4 py-2 font-bold">ดาวน์โหลด PDF</button>
        {documentType === 'production_confirmation' && <button onClick={copyText} className="rounded-xl border px-4 py-2 font-bold">คัดลอกข้อความ</button>}
        {document && !expired && ['active','approved'].includes(document.status) && !document.converted_order_id && <button onClick={() => onOpenBill(document)} className="ml-auto rounded-xl bg-emerald-600 px-5 py-2 font-bold text-white">เปิดบิล</button>}
      </div>

      {discountModal && <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"><div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"><h3 className="text-xl font-bold">ขออนุมัติส่วนลด</h3><div className="mt-4 grid grid-cols-3 gap-2"><select value={discountRequest.type} onChange={e => setDiscountRequest(v => ({ ...v, type: e.target.value as 'amount' | 'percent' }))} className="rounded-xl border p-2"><option value="amount">บาท</option><option value="percent">เปอร์เซ็นต์</option></select><input type="number" min="0" value={discountRequest.value} onChange={e => setDiscountRequest(v => ({ ...v, value: e.target.value }))} className="col-span-2 rounded-xl border p-2" placeholder="จำนวนที่ขอ" /></div><div className="mt-3 rounded-xl bg-amber-50 p-3 text-sm"><div className="flex justify-between"><span>ยอดสินค้า</span><b>{money(subtotal)}</b></div><div className="mt-1 flex justify-between"><span>ส่วนลดที่ขอ</span><b>{money(discountRequest.type === 'percent' ? subtotal * Math.min(100, Number(discountRequest.value || 0)) / 100 : Math.min(subtotal, Number(discountRequest.value || 0)))}</b></div></div><textarea value={discountRequest.note} onChange={e => setDiscountRequest(v => ({ ...v, note: e.target.value }))} rows={4} placeholder="หมายเหตุคำขอ (บังคับ)" className="mt-3 w-full rounded-xl border p-3" /><div className="mt-4 flex justify-end gap-2"><button onClick={() => setDiscountModal(false)} className="rounded-xl border px-4 py-2">ยกเลิก</button><button disabled={!discountRequest.value || !discountRequest.note.trim()} onClick={requestDiscount} className="rounded-xl bg-amber-500 px-4 py-2 font-bold text-white disabled:opacity-50">ส่งคำขอ</button></div></div></div>}

      {previewOpen && createPortal(<div className="fixed inset-0 z-[200] overflow-auto bg-black/60 p-4 pt-16 pr-24"><div className="relative mx-auto w-[794px]"><button type="button" onClick={() => setPreviewOpen(false)} className="absolute -right-20 top-0 z-[210] rounded-xl bg-white px-5 py-2 font-bold shadow-lg">ปิด</button><PreBillPreview ref={previewRef} document={previewDocument} items={items} /></div></div>, globalThis.document.body)}
      {!previewOpen && <div className="fixed left-[-10000px] top-0"><PreBillPreview ref={previewRef} document={previewDocument} items={items} /></div>}
    </div>
  )
}
