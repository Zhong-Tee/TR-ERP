import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import Modal from '../ui/Modal'
import {
  PROMOTION_RULE_LABELS,
  type PromotionDefinition,
  type PromotionRuleConfig,
  type PromotionRuleGroup,
  type PromotionRuleType,
  type PromotionSelector,
} from '../../lib/promotionRules'

type ProductOption = { id: string; product_code: string; product_name: string; product_category: string | null }
type ChannelOption = { channel_code: string; channel_name: string }
type PromotionRow = PromotionDefinition & { sort_order?: number | null }
type ShippingFeeSettings = {
  id: number
  auto_calculate_enabled: boolean
  charge_promotion_orders: boolean
}
type ShippingFeeRange = {
  id?: string
  min_amount: number
  max_amount: number | null
  shipping_fee: number
  sort_order: number
}

const emptyPromotion = (): PromotionRow => ({
  id: '',
  name: '',
  is_active: true,
  validation_enabled: false,
  rule_type: 'legacy',
  start_date: null,
  end_date: null,
  channel_codes: [],
  rule_config: {},
  allow_stack: true,
  is_featured: false,
  free_shipping: false,
  version: 1,
  sort_order: 0,
})

function sortRows(rows: PromotionRow[]) {
  return [...rows].sort((a, b) =>
    (a.sort_order ?? Number.MAX_SAFE_INTEGER) - (b.sort_order ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name),
  )
}

function formatAmount(value: number | null | undefined) {
  if (value == null || !Number.isFinite(Number(value))) return ''
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 })
}

function parseAmount(value: string) {
  const normalized = value.replace(/,/g, '').replace(/[^0-9.]/g, '')
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
}

function SearchableRuleSelector({
  option,
  onChange,
  categories,
  products,
}: {
  option: PromotionSelector
  onChange: (option: PromotionSelector) => void
  categories: string[]
  products: ProductOption[]
}) {
  const selectedProduct = option.selector_type === 'sku'
    ? products.find((product) => product.id === option.product_id)
    : null
  const selectedLabel = option.selector_type === 'category'
    ? option.category
    : selectedProduct ? `${selectedProduct.product_code} · ${selectedProduct.product_name}` : ''
  const [query, setQuery] = useState(selectedLabel)
  const [open, setOpen] = useState(false)

  useEffect(() => { setQuery(selectedLabel) }, [selectedLabel])

  const keyword = query.trim().toLowerCase()
  const filteredCategories = categories
    .filter((category) => !keyword || category.toLowerCase().includes(keyword))
    .slice(0, 50)
  const filteredProducts = products
    .filter((product) => {
      if (!keyword) return true
      return `${product.product_code} ${product.product_name} ${product.product_category || ''}`.toLowerCase().includes(keyword)
    })
    .slice(0, 50)

  return (
    <div className="relative min-w-[260px] flex-1">
      <input
        type="text"
        value={query}
        onFocus={(event) => { setOpen(true); event.currentTarget.select() }}
        onBlur={() => window.setTimeout(() => { setOpen(false); setQuery(selectedLabel) }, 120)}
        onChange={(event) => { setQuery(event.target.value); setOpen(true) }}
        placeholder={option.selector_type === 'category' ? 'ค้นหาหมวดหมู่...' : 'ค้นหารหัส SKU หรือชื่อสินค้า...'}
        className="w-full rounded-lg border px-3 py-2 pr-9 text-sm"
        role="combobox"
        aria-expanded={open}
      />
      <span className="pointer-events-none absolute right-3 top-2.5 text-xs text-gray-400">▼</span>
      {open && (
        <div className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-xl border bg-white p-1 shadow-xl">
          {option.selector_type === 'category' ? filteredCategories.map((category) => (
            <button
              key={category}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => { onChange({ selector_type: 'category', category }); setQuery(category); setOpen(false) }}
              className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-blue-50"
            >
              {category}
            </button>
          )) : filteredProducts.map((product) => (
            <button
              key={product.id}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => { onChange({ selector_type: 'sku', product_id: product.id }); setQuery(`${product.product_code} · ${product.product_name}`); setOpen(false) }}
              className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-blue-50"
            >
              <span className="font-semibold text-blue-700">{product.product_code}</span>
              <span className="ml-2 text-gray-800">{product.product_name}</span>
              {product.product_category && <span className="ml-2 text-xs text-gray-400">({product.product_category})</span>}
            </button>
          ))}
          {((option.selector_type === 'category' && filteredCategories.length === 0) || (option.selector_type === 'sku' && filteredProducts.length === 0)) && (
            <div className="px-3 py-4 text-center text-sm text-gray-400">ไม่พบรายการที่ค้นหา</div>
          )}
        </div>
      )}
    </div>
  )
}

function RuleGroupsEditor({
  title,
  groups,
  onChange,
  categories,
  products,
}: {
  title: string
  groups: PromotionRuleGroup[]
  onChange: (groups: PromotionRuleGroup[]) => void
  categories: string[]
  products: ProductOption[]
}) {
  const addGroup = () => onChange([
    ...groups,
    { id: `${title} ${groups.length + 1}`, quantity: 1, options: [{ selector_type: 'category', category: '' }] },
  ])
  const updateGroup = (index: number, next: PromotionRuleGroup) => onChange(groups.map((group, i) => i === index ? next : group))

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="font-bold text-slate-800">{title}</h4>
          <p className="text-xs text-slate-500">แต่ละกลุ่มต้องผ่านทั้งหมด (AND) · ตัวเลือกในกลุ่มผ่านอย่างใดอย่างหนึ่ง (OR)</p>
        </div>
        <button type="button" onClick={addGroup} className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700">+ เพิ่มกลุ่ม</button>
      </div>
      {groups.length === 0 && <div className="rounded-lg border border-dashed bg-white p-4 text-center text-sm text-slate-400">ยังไม่มีกลุ่ม</div>}
      {groups.map((group, groupIndex) => (
        <div key={`${title}-${groupIndex}`} className="rounded-xl border bg-white p-3 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex-1 min-w-[180px] text-sm font-medium text-slate-700">
              ชื่อกลุ่ม
              <input value={group.id} onChange={(e) => updateGroup(groupIndex, { ...group, id: e.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2" />
            </label>
            <label className="w-28 text-sm font-medium text-slate-700">
              จำนวน
              <input type="number" min="1" value={group.quantity} onChange={(e) => updateGroup(groupIndex, { ...group, quantity: Math.max(1, Number(e.target.value) || 1) })} className="mt-1 w-full rounded-lg border px-3 py-2" />
            </label>
            <button type="button" onClick={() => onChange(groups.filter((_, i) => i !== groupIndex))} className="rounded-lg border border-red-200 px-3 py-2 text-sm font-semibold text-red-600 hover:bg-red-50">ลบกลุ่ม</button>
          </div>
          <div className="space-y-2">
            {group.options.map((option, optionIndex) => (
              <div key={optionIndex} className="flex flex-wrap items-center gap-2">
                {optionIndex > 0 && <span className="w-8 text-center text-xs font-bold text-blue-600">OR</span>}
                {optionIndex === 0 && <span className="w-8" />}
                <select
                  value={option.selector_type}
                  onChange={(e) => {
                    const selector: PromotionSelector = e.target.value === 'sku'
                      ? { selector_type: 'sku', product_id: '' }
                      : { selector_type: 'category', category: '' }
                    updateGroup(groupIndex, { ...group, options: group.options.map((item, i) => i === optionIndex ? selector : item) })
                  }}
                  className="rounded-lg border px-3 py-2 text-sm"
                >
                  <option value="category">ทั้งหมวดหมู่</option>
                  <option value="sku">เฉพาะ SKU</option>
                </select>
                <SearchableRuleSelector
                  option={option}
                  categories={categories}
                  products={products}
                  onChange={(selector) => updateGroup(groupIndex, { ...group, options: group.options.map((item, i) => i === optionIndex ? selector : item) })}
                />
                <button type="button" onClick={() => updateGroup(groupIndex, { ...group, options: group.options.filter((_, i) => i !== optionIndex) })} disabled={group.options.length <= 1} className="rounded-lg px-2 py-2 text-red-500 hover:bg-red-50 disabled:opacity-30">✕</button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => updateGroup(groupIndex, { ...group, options: [...group.options, { selector_type: 'category', category: '' }] })}
              className="ml-10 text-sm font-semibold text-blue-600 hover:text-blue-800"
            >
              + เพิ่มตัวเลือก OR
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

export default function PromotionSettingsPanel() {
  const [rows, setRows] = useState<PromotionRow[]>([])
  const [channels, setChannels] = useState<ChannelOption[]>([])
  const [products, setProducts] = useState<ProductOption[]>([])
  const [editor, setEditor] = useState<PromotionRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [shippingSettings, setShippingSettings] = useState<ShippingFeeSettings>({
    id: 1,
    auto_calculate_enabled: false,
    charge_promotion_orders: true,
  })
  const [shippingRanges, setShippingRanges] = useState<ShippingFeeRange[]>([])
  const [savingShipping, setSavingShipping] = useState(false)

  const categories = useMemo(() => [...new Set(products.map((p) => p.product_category || '').filter(Boolean))].sort(), [products])

  async function load() {
    setLoading(true)
    setError('')
    try {
      const [promotionRes, channelRes, productRes, shippingSettingsRes, shippingRangesRes] = await Promise.all([
        supabase.from('promotion').select('*'),
        supabase.from('channels').select('channel_code, channel_name').order('channel_name'),
        supabase.from('pr_products').select('id, product_code, product_name, product_category').eq('is_active', true).in('product_type', ['FG', 'PP']).order('product_name'),
        supabase.from('or_shipping_fee_settings').select('*').eq('id', 1).maybeSingle(),
        supabase.from('or_shipping_fee_ranges').select('*').order('sort_order').order('min_amount'),
      ])
      if (promotionRes.error) throw promotionRes.error
      if (channelRes.error) throw channelRes.error
      if (productRes.error) throw productRes.error
      if (shippingSettingsRes.error) throw shippingSettingsRes.error
      if (shippingRangesRes.error) throw shippingRangesRes.error
      setRows(sortRows((promotionRes.data || []) as PromotionRow[]))
      setChannels(channelRes.data || [])
      setProducts(productRes.data || [])
      if (shippingSettingsRes.data) setShippingSettings(shippingSettingsRes.data as ShippingFeeSettings)
      setShippingRanges((shippingRangesRes.data || []).map((row) => ({
        ...row,
        min_amount: Number(row.min_amount || 0),
        max_amount: row.max_amount == null ? null : Number(row.max_amount),
        shipping_fee: Number(row.shipping_fee || 0),
      })) as ShippingFeeRange[])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'โหลดข้อมูลโปรโมชั่นไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function save() {
    if (!editor || !editor.name.trim()) {
      setError('กรุณากรอกชื่อโปรโมชั่น')
      return
    }
    const config = editor.rule_config || {}
    const requiredGroups = editor.rule_type === 'bundle_fixed_price' || editor.rule_type === 'buy_get' || editor.rule_type === 'quantity_get' || editor.rule_type === 'quantity_fixed'
    const requiredRewards = editor.rule_type === 'buy_get' || editor.rule_type === 'spend_get' || editor.rule_type === 'quantity_get'
    if (requiredGroups && !(config.condition_groups || []).length) {
      setError('กรุณาเพิ่มกลุ่มสินค้าฝั่งซื้ออย่างน้อย 1 กลุ่ม')
      return
    }
    if (requiredRewards && !(config.reward_groups || []).length) {
      setError('กรุณาเพิ่มกลุ่มของแถมอย่างน้อย 1 กลุ่ม')
      return
    }
    const invalidSelector = [...(config.condition_groups || []), ...(config.reward_groups || [])]
      .some((group) => !group.options.length || group.options.some((option) => option.selector_type === 'sku' ? !option.product_id : !option.category))
    if (editor.rule_type !== 'legacy' && invalidSelector) {
      setError('กรุณาเลือกหมวดหมู่หรือ SKU ให้ครบทุกตัวเลือกในกติกา')
      return
    }
    if (['spend_percent', 'spend_fixed', 'spend_get'].includes(editor.rule_type) && Number(config.threshold_amount || 0) <= 0) {
      setError('กรุณากำหนดยอดซื้อขั้นต่ำให้มากกว่า 0 บาท')
      return
    }
    if (['spend_percent', 'spend_fixed', 'quantity_fixed'].includes(editor.rule_type) && Number(config.discount_value || 0) <= 0) {
      setError('กรุณากำหนดส่วนลดให้มากกว่า 0')
      return
    }
    if (editor.rule_type === 'spend_percent' && Number(config.discount_value || 0) > 100) {
      setError('ส่วนลดเปอร์เซ็นต์ต้องไม่เกิน 100%')
      return
    }
    setSaving(true)
    setError('')
    try {
      const payload = {
        name: editor.name.trim(),
        is_active: editor.is_active,
        validation_enabled: editor.rule_type === 'legacy' ? false : editor.validation_enabled,
        rule_type: editor.rule_type,
        start_date: editor.start_date || null,
        end_date: editor.end_date || null,
        channel_codes: editor.channel_codes || [],
        rule_config: editor.rule_config || {},
        allow_stack: editor.allow_stack !== false,
        is_featured: editor.is_featured === true,
        free_shipping: editor.free_shipping === true,
        version: editor.id ? Number(editor.version || 1) + 1 : 1,
        sort_order: editor.id ? editor.sort_order : rows.length + 1,
      }
      const result = editor.id
        ? await supabase.from('promotion').update(payload).eq('id', editor.id)
        : await supabase.from('promotion').insert(payload)
      if (result.error) throw result.error
      setEditor(null)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'บันทึกโปรโมชั่นไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  async function toggleActive(row: PromotionRow) {
    const { error: updateError } = await supabase.from('promotion').update({ is_active: !row.is_active, version: Number(row.version || 1) + 1 }).eq('id', row.id)
    if (updateError) setError(updateError.message)
    else setRows((current) => current.map((item) => item.id === row.id ? { ...item, is_active: !item.is_active, version: Number(item.version || 1) + 1 } : item))
  }

  async function saveShippingSettings() {
    const normalized = shippingRanges
      .map((row) => ({
        min_amount: Math.max(0, Number(row.min_amount) || 0),
        max_amount: row.max_amount == null ? null : Math.max(0, Number(row.max_amount) || 0),
        shipping_fee: Math.max(0, Number(row.shipping_fee) || 0),
      }))
      .sort((a, b) => a.min_amount - b.min_amount)
    for (let index = 0; index < normalized.length; index += 1) {
      const row = normalized[index]
      if (row.max_amount != null && row.max_amount < row.min_amount) {
        setError(`ช่วงค่าส่งลำดับที่ ${index + 1}: ยอดสิ้นสุดต้องไม่น้อยกว่ายอดเริ่มต้น`)
        return
      }
      const previous = normalized[index - 1]
      if (previous && (previous.max_amount == null || row.min_amount <= previous.max_amount)) {
        setError(`ช่วงค่าส่งลำดับที่ ${index + 1} ซ้อนทับกับช่วงก่อนหน้า`)
        return
      }
    }
    setSavingShipping(true)
    setError('')
    try {
      const settingsResult = await supabase.from('or_shipping_fee_settings').upsert({
        id: 1,
        auto_calculate_enabled: shippingSettings.auto_calculate_enabled,
        charge_promotion_orders: shippingSettings.charge_promotion_orders,
        updated_at: new Date().toISOString(),
      })
      if (settingsResult.error) throw settingsResult.error
      const deleteResult = await supabase.from('or_shipping_fee_ranges').delete().gte('min_amount', 0)
      if (deleteResult.error) throw deleteResult.error
      if (normalized.length) {
        const insertResult = await supabase.from('or_shipping_fee_ranges').insert(
          normalized.map((row, index) => ({ ...row, sort_order: index + 1, updated_at: new Date().toISOString() })),
        )
        if (insertResult.error) throw insertResult.error
      }
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'บันทึกการตั้งค่าค่าขนส่งไม่สำเร็จ')
    } finally {
      setSavingShipping(false)
    }
  }

  async function move(from: number, to: number) {
    if (from === to) return
    const previous = rows
    const next = [...rows]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setRows(next)
    const results = await Promise.all(next.map((row, index) => supabase.from('promotion').update({ sort_order: index + 1 }).eq('id', row.id)))
    const failed = results.find((result) => result.error)
    if (failed?.error) {
      setRows(previous)
      setError(failed.error.message)
    }
  }

  const updateConfig = (updates: Partial<PromotionRuleConfig>) => setEditor((current) => current ? ({ ...current, rule_config: { ...(current.rule_config || {}), ...updates } }) : current)
  const config = editor?.rule_config || {}
  const needsThreshold = editor && ['spend_percent', 'spend_fixed', 'spend_get'].includes(editor.rule_type)
  const needsDiscount = editor && ['spend_percent', 'spend_fixed', 'quantity_fixed'].includes(editor.rule_type)
  const needsConditions = editor && ['bundle_fixed_price', 'buy_get', 'quantity_get', 'quantity_fixed'].includes(editor.rule_type)
  const needsRewards = editor && ['buy_get', 'spend_get', 'quantity_get'].includes(editor.rule_type)

  return (
    <div className="bg-white p-6 rounded-lg shadow space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">จัดการโปรโมชั่น/ค่าส่ง</h2>
          <p className="mt-1 text-sm text-gray-500">กำหนดโปรโมชั่นและช่วงค่าขนส่งที่ระบบคำนวณให้อัตโนมัติเมื่อเปิดบิล</p>
        </div>
        <button type="button" onClick={() => { setError(''); setEditor(emptyPromotion()) }} className="rounded-xl bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700">+ เพิ่มโปรโมชั่น</button>
      </div>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      <section className="rounded-xl border border-sky-200 bg-sky-50/40 p-4 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-bold text-slate-900">ตั้งค่าค่าขนส่งอัตโนมัติ</h3>
            <p className="mt-1 text-xs text-slate-500">คำนวณจากราคาสินค้ารวมก่อนหักส่วนลด และค่าขนส่ง 0 บาทหมายถึงส่งฟรี</p>
          </div>
          <button type="button" onClick={saveShippingSettings} disabled={savingShipping} className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50">{savingShipping ? 'กำลังบันทึก...' : 'บันทึกค่าขนส่ง'}</button>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="flex items-center gap-3 rounded-xl border bg-white p-3"><input type="checkbox" checked={shippingSettings.auto_calculate_enabled} onChange={(event) => setShippingSettings({ ...shippingSettings, auto_calculate_enabled: event.target.checked })} className="h-5 w-5" /><span><b className="block text-sm">คำนวณค่าขนส่งอัตโนมัติ</b><small className="text-gray-500">เลือกค่าขนส่งจากช่วงยอดซื้อด้านล่าง</small></span></label>
          <label className="flex items-center gap-3 rounded-xl border bg-white p-3"><input type="checkbox" checked={shippingSettings.charge_promotion_orders} onChange={(event) => setShippingSettings({ ...shippingSettings, charge_promotion_orders: event.target.checked })} className="h-5 w-5" /><span><b className="block text-sm">นับรวมบิลที่มีโปรโมชั่น</b><small className="text-gray-500">หากปิด บิลที่เลือกโปรโมชั่นจะไม่คิดค่าขนส่ง</small></span></label>
        </div>
        <div className="space-y-2">
          {shippingRanges.map((range, index) => <div key={range.id || index} className="grid gap-2 rounded-xl border bg-white p-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
            <label className="text-xs font-semibold text-gray-600">ยอดซื้อตั้งแต่ (บาท)<input type="number" min="0" step="0.01" value={range.min_amount} onChange={(event) => setShippingRanges((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, min_amount: Number(event.target.value) || 0 } : item))} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" /></label>
            <label className="text-xs font-semibold text-gray-600">ถึงยอด (บาท)<input type="number" min="0" step="0.01" value={range.max_amount ?? ''} onChange={(event) => setShippingRanges((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, max_amount: event.target.value === '' ? null : Number(event.target.value) || 0 } : item))} placeholder="ไม่จำกัด" className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" /></label>
            <label className="text-xs font-semibold text-gray-600">ค่าขนส่ง (บาท)<input type="number" min="0" step="0.01" value={range.shipping_fee} onChange={(event) => setShippingRanges((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, shipping_fee: Number(event.target.value) || 0 } : item))} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" /></label>
            <button type="button" onClick={() => setShippingRanges((current) => current.filter((_, itemIndex) => itemIndex !== index))} className="rounded-lg border border-red-200 px-3 py-2 text-sm font-semibold text-red-600 hover:bg-red-50">ลบ</button>
          </div>)}
          <button type="button" onClick={() => setShippingRanges((current) => [...current, { min_amount: 0, max_amount: null, shipping_fee: 0, sort_order: current.length + 1 }])} className="rounded-lg border border-dashed border-sky-400 px-4 py-2 text-sm font-semibold text-sky-700 hover:bg-sky-50">+ เพิ่มช่วงค่าขนส่ง</button>
        </div>
      </section>
      {loading ? <div className="py-10 text-center text-gray-400">กำลังโหลด...</div> : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[850px] text-sm">
            <thead className="bg-blue-600 text-white"><tr>
              <th className="w-10 px-2 py-3" /><th className="w-12 px-3 py-3 text-left">#</th>
              <th className="px-3 py-3 text-left">ชื่อโปรโมชั่น</th><th className="px-3 py-3 text-left">รูปแบบ</th>
              <th className="px-3 py-3 text-left">ช่วงเวลา</th><th className="px-3 py-3 text-center">ตรวจบิล</th>
              <th className="px-3 py-3 text-center">สถานะ</th><th className="px-3 py-3 text-right">จัดการ</th>
            </tr></thead>
            <tbody>{rows.map((row, index) => (
              <tr key={row.id} onDragOver={(e) => { if (draggedIndex != null) e.preventDefault() }} onDrop={(e) => { e.preventDefault(); if (draggedIndex != null) move(draggedIndex, index); setDraggedIndex(null) }} className="border-t hover:bg-blue-50">
                <td className="px-2 py-3 text-center"><button type="button" draggable onDragStart={() => setDraggedIndex(index)} onDragEnd={() => setDraggedIndex(null)} className="cursor-grab text-lg text-gray-400">☰</button></td>
                <td className="px-3 py-3 text-gray-400">{index + 1}</td>
                <td className="px-3 py-3 font-semibold text-gray-900">{row.is_featured && <span className="mr-1.5 text-amber-500" title="โปรโมชั่นติดดาว">★</span>}{row.name}{row.allow_stack === false && <span className="ml-2 rounded bg-amber-100 px-2 py-0.5 text-[10px] text-amber-700">ใช้เดี่ยว</span>}{row.free_shipping && <span className="ml-2 rounded bg-emerald-100 px-2 py-0.5 text-[10px] text-emerald-700">ฟรีค่าส่ง</span>}</td>
                <td className="px-3 py-3 text-gray-600">{PROMOTION_RULE_LABELS[row.rule_type] || row.rule_type}</td>
                <td className="px-3 py-3 text-gray-600">{row.start_date || 'ไม่จำกัด'} – {row.end_date || 'ไม่จำกัด'}</td>
                <td className="px-3 py-3 text-center"><span className={`rounded-full px-2 py-1 text-xs font-semibold ${row.validation_enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>{row.validation_enabled ? 'เปิด' : 'ปิด'}</span></td>
                <td className="px-3 py-3 text-center"><button type="button" onClick={() => toggleActive(row)} className={`rounded-full px-3 py-1 text-xs font-semibold ${row.is_active ? 'bg-blue-100 text-blue-700' : 'bg-red-100 text-red-600'}`}>{row.is_active ? 'ใช้งาน' : 'ซ่อน'}</button></td>
                <td className="px-3 py-3 text-right"><button type="button" onClick={() => { setError(''); setEditor({ ...row, channel_codes: row.channel_codes || [], rule_config: row.rule_config || {} }) }} className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700">แก้ไข</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}

      <Modal open={editor != null} onClose={() => !saving && setEditor(null)} contentClassName="max-w-5xl w-full max-h-[92vh] overflow-y-auto">
        {editor && <div className="p-5 md:p-6 space-y-5">
          <div><h3 className="text-xl font-bold text-gray-900">{editor.id ? 'แก้ไขโปรโมชั่น' : 'เพิ่มโปรโมชั่น'}</h3><p className="text-sm text-gray-500">กติกาที่แก้ใหม่จะเพิ่มเวอร์ชัน โดยประวัติบิลเก่ายังคงใช้ Snapshot เดิม</p></div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="text-sm font-semibold text-gray-700">ชื่อโปรโมชั่น<input value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value })} className="mt-1 w-full rounded-xl border px-3 py-2" /></label>
            <label className="text-sm font-semibold text-gray-700">รูปแบบโปรโมชั่น<select value={editor.rule_type} onChange={(e) => setEditor({ ...editor, rule_type: e.target.value as PromotionRuleType, validation_enabled: e.target.value === 'legacy' ? false : editor.validation_enabled })} className="mt-1 w-full rounded-xl border px-3 py-2">{Object.entries(PROMOTION_RULE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="text-sm font-semibold text-gray-700">วันที่เริ่มต้น<input type="date" value={editor.start_date || ''} onChange={(e) => setEditor({ ...editor, start_date: e.target.value || null })} className="mt-1 w-full rounded-xl border px-3 py-2" /></label>
            <label className="text-sm font-semibold text-gray-700">วันที่สิ้นสุด<input type="date" value={editor.end_date || ''} onChange={(e) => setEditor({ ...editor, end_date: e.target.value || null })} className="mt-1 w-full rounded-xl border px-3 py-2" /></label>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[auto_repeat(4,minmax(0,1fr))]">
            <label className="inline-flex w-fit cursor-pointer flex-col items-start gap-2 self-center"><b className="text-sm text-gray-800">ใช้งาน</b><span className="relative inline-flex shrink-0"><input type="checkbox" checked={editor.is_active} onChange={(e) => setEditor({ ...editor, is_active: e.target.checked })} className="peer sr-only" role="switch" /><span className="h-6 w-11 rounded-full bg-gray-300 transition-colors peer-checked:bg-blue-600 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-400 peer-focus-visible:ring-offset-2 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-5" /></span></label>
            <label className="flex items-center gap-3 rounded-xl border p-3"><input type="checkbox" checked={editor.validation_enabled} disabled={editor.rule_type === 'legacy'} onChange={(e) => setEditor({ ...editor, validation_enabled: e.target.checked })} className="h-5 w-5" /><span><b className="block text-sm">ตรวจสอบเมื่อเปิดบิล</b><small className="text-gray-500">แจ้ง Popup เมื่อไม่ผ่าน</small></span></label>
            <label className="flex items-center gap-3 rounded-xl border p-3"><input type="checkbox" checked={editor.allow_stack !== false} onChange={(e) => setEditor({ ...editor, allow_stack: e.target.checked })} className="h-5 w-5" /><b className="block text-sm">ใช้ร่วมกับโปรฯ อื่น</b></label>
            <label className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50/50 p-3"><input type="checkbox" checked={editor.is_featured === true} onChange={(e) => setEditor({ ...editor, is_featured: e.target.checked })} className="h-5 w-5 accent-amber-500" /><b className="block text-sm text-amber-900">★ โปรฯ ติดดาว</b></label>
            <label className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50/50 p-3"><input type="checkbox" checked={editor.free_shipping === true} onChange={(e) => setEditor({ ...editor, free_shipping: e.target.checked })} className="h-5 w-5 accent-emerald-600" /><b className="block text-sm text-emerald-900">ฟรีค่าส่ง</b></label>
          </div>
          <div><h4 className="mb-2 font-bold text-gray-800">ช่องทางที่ร่วมรายการ</h4><p className="mb-2 text-xs text-gray-500">ไม่เลือกช่องทาง = ใช้ได้ทุกช่องทาง</p><div className="grid gap-2 sm:grid-cols-2 md:grid-cols-4">{channels.map((channel) => <label key={channel.channel_code} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"><input type="checkbox" checked={(editor.channel_codes || []).includes(channel.channel_code)} onChange={(e) => setEditor({ ...editor, channel_codes: e.target.checked ? [...(editor.channel_codes || []), channel.channel_code] : (editor.channel_codes || []).filter((code) => code !== channel.channel_code) })} />{channel.channel_code} · {channel.channel_name}</label>)}</div></div>
          {(needsThreshold || needsDiscount || editor.rule_type === 'bundle_fixed_price') && <div className="grid gap-4 md:grid-cols-3">
            {needsThreshold && <label className="text-sm font-semibold text-gray-700">ยอดซื้อขั้นต่ำ (บาท)<input type="number" min="0" value={config.threshold_amount ?? ''} onChange={(e) => updateConfig({ threshold_amount: Number(e.target.value) || 0 })} className="mt-1 w-full rounded-xl border px-3 py-2" /></label>}
            {needsDiscount && <label className="text-sm font-semibold text-gray-700">{editor.rule_type === 'spend_percent' ? 'ส่วนลด (%)' : 'ส่วนลด (บาท)'}<input type="number" min="0" max={editor.rule_type === 'spend_percent' ? 100 : undefined} value={config.discount_value ?? ''} onChange={(e) => updateConfig({ discount_value: Number(e.target.value) || 0 })} className="mt-1 w-full rounded-xl border px-3 py-2" /></label>}
            {editor.rule_type === 'bundle_fixed_price' && <label className="text-sm font-semibold text-gray-700">ราคาเซ็ต (บาท)<input type="text" inputMode="decimal" value={formatAmount(config.set_price)} onChange={(e) => updateConfig({ set_price: parseAmount(e.target.value) })} placeholder="0" className="mt-1 w-full rounded-xl border px-3 py-2 text-right tabular-nums" /></label>}
          </div>}
          {needsConditions && <RuleGroupsEditor title="สินค้าฝั่งซื้อ" groups={config.condition_groups || []} onChange={(condition_groups) => updateConfig({ condition_groups })} categories={categories} products={products} />}
          {needsRewards && <RuleGroupsEditor title="ของแถม" groups={config.reward_groups || []} onChange={(reward_groups) => updateConfig({ reward_groups })} categories={categories} products={products} />}
          {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
          <div className="flex justify-end gap-3 border-t pt-4"><button type="button" onClick={() => setEditor(null)} disabled={saving} className="rounded-xl border px-4 py-2 font-semibold hover:bg-gray-50">ยกเลิก</button><button type="button" onClick={save} disabled={saving} className="rounded-xl bg-blue-600 px-5 py-2 font-semibold text-white hover:bg-blue-700 disabled:opacity-50">{saving ? 'กำลังบันทึก...' : 'บันทึกโปรโมชั่น'}</button></div>
        </div>}
      </Modal>
    </div>
  )
}
