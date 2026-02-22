import { useState, useEffect, useRef } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import { getPublicUrl } from '../lib/qcApi'
import Modal from '../components/ui/Modal'
import { Product, ProductType } from '../types'
import { useAuthContext } from '../contexts/AuthContext'

const COST_VISIBLE_ROLES = ['superadmin', 'account']

const SEARCH_DEBOUNCE_MS = 400
const PAGE_SIZE = 50

const BUCKET_PRODUCT_IMAGES = 'product-images'
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || ''

function getProductImageUrl(productCode: string | null | undefined, ext: string = '.jpg'): string {
  return getPublicUrl(BUCKET_PRODUCT_IMAGES, productCode, ext)
}

const PRODUCT_TEMPLATE_HEADERS = [
  'product_code',
  'product_name',
  'seller_name',
  'product_name_cn',
  'order_point',
  'product_category',
  'product_type',
  'rubber_code',
  'storage_location',
] as const

const INIT_IMPORT_HEADERS = [
  'product_code',
  'product_name',
  'product_category',
  'product_type',
  'seller_name',
  'unit_cost',
  'initial_stock',
  'safety_stock',
  'order_point',
  'storage_location',
] as const

interface InitImportRow {
  product_code: string
  product_name: string
  product_category: string
  product_type: string
  seller_name: string
  unit_cost: number
  initial_stock: number
  safety_stock: number
  order_point: string
  storage_location: string
}

/** อัปโหลดไฟล์รูปไป bucket product-images ชื่อไฟล์ = productCode + นามสกุล จากไฟล์ */
async function uploadProductImage(file: File, productCode: string): Promise<string> {
  const ext = file.name.includes('.') ? '.' + file.name.split('.').pop() : '.jpg'
  const fileName = productCode.trim() + ext
  const { data, error } = await supabase.storage
    .from(BUCKET_PRODUCT_IMAGES)
    .upload(fileName, file, {
      cacheControl: '3600',
      upsert: true,
      contentType: file.type || `image/${ext.replace('.', '')}`,
    })
  if (error) throw error
  return `${supabaseUrl}/storage/v1/object/public/${BUCKET_PRODUCT_IMAGES}/${encodeURIComponent(data.path)}`
}

/** อัปโหลดรูปเดียวไป bucket ด้วยชื่อไฟล์เดิม (ใช้สำหรับอัปโหลดหลายรูป) */
async function uploadImageToBucket(file: File): Promise<void> {
  const fileName = file.name || `image-${Date.now()}.jpg`
  const { error } = await supabase.storage
    .from(BUCKET_PRODUCT_IMAGES)
    .upload(fileName, file, {
      cacheControl: '3600',
      upsert: true,
      contentType: file.type || 'image/jpeg',
    })
  if (error) throw error
}

const PRODUCT_TYPE_OPTIONS: { value: ProductType; label: string }[] = [
  { value: 'FG', label: 'FG - สินค้าสำเร็จรูป' },
  { value: 'RM', label: 'RM - วัตถุดิบ' },
  { value: 'PP', label: 'PP - สินค้าแปรรูป' },
]

const UNIT_PRESETS = ['ชิ้น', 'คู่', 'แพ็ค', 'กล่อง', 'ชุด', 'ม้วน']

const emptyForm = () => ({
  product_code: '',
  product_name: '',
  seller_name: '',
  product_name_cn: '',
  order_point: '',
  product_category: '',
  product_type: 'FG' as ProductType,
  rubber_code: '',
  storage_location: '',
  unit_cost: '',
  safety_stock: '',
  unit_name: 'ชิ้น',
  unit_multiplier: '1',
})

export default function Products() {
  const { user } = useAuthContext()
  const _canSeeCost = COST_VISIBLE_ROLES.includes(user?.role || '')
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [searchInput, setSearchInput] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [productTypeFilter, setProductTypeFilter] = useState<'' | ProductType>('')
  const [categories, setCategories] = useState<string[]>([])
  const [modalMode, setModalMode] = useState<'add' | 'edit' | null>(null)
  const [editingProduct, setEditingProduct] = useState<Product | null>(null)
  const [form, setForm] = useState(emptyForm())
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [productToDelete, setProductToDelete] = useState<Product | null>(null)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadPreview, setUploadPreview] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [uploadingImages, setUploadingImages] = useState(false)
  const [sellerOptions, setSellerOptions] = useState<string[]>([])
  const [page, setPage] = useState(1)
  const [totalCount, setTotalCount] = useState(0)

  // Notification modal
  const [notifyModal, setNotifyModal] = useState<{ open: boolean; type: 'success' | 'error' | 'warning'; title: string; message: string }>({
    open: false, type: 'success', title: '', message: '',
  })
  function showNotify(type: 'success' | 'error' | 'warning', title: string, message: string = '') {
    setNotifyModal({ open: true, type, title, message })
  }

  const isSuperAdmin = user?.role === 'superadmin'

  // Init import state
  const [initImportOpen, setInitImportOpen] = useState(false)
  const [initImportRows, setInitImportRows] = useState<InitImportRow[]>([])
  const [initImportDupCodes, setInitImportDupCodes] = useState<Set<string>>(new Set())
  const [initImportErrors, setInitImportErrors] = useState<string[]>([])
  const [initImporting, setInitImporting] = useState(false)
  const initImportInputRef = useRef<HTMLInputElement>(null)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const importInputRef = useRef<HTMLInputElement>(null)
  const uploadImagesInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    debounceRef.current = setTimeout(() => {
      setAppliedSearch(searchInput.trim())
      setPage(1)
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [searchInput])

  useEffect(() => {
    setPage(1)
  }, [categoryFilter, productTypeFilter])

  useEffect(() => {
    loadProducts()
  }, [appliedSearch, categoryFilter, productTypeFilter, page])

  useEffect(() => {
    loadCategories()
    loadSellerOptions()
  }, [])

  async function loadCategories() {
    try {
      const { data, error } = await supabase
        .from('pr_products')
        .select('product_category')
        .eq('is_active', true)
        .not('product_category', 'is', null)
      if (error) throw error
      const list = (data || [])
        .map((r: { product_category: string | null }) => r.product_category)
        .filter(Boolean) as string[]
      setCategories([...new Set(list)].sort())
    } catch (e) {
      console.error('Error loading categories:', e)
    }
  }

  async function loadSellerOptions() {
    try {
      const { data, error } = await supabase
        .from('pr_sellers')
        .select('name')
        .eq('is_active', true)
        .order('name')
      if (error) throw error
      setSellerOptions((data || []).map((s: { name: string }) => s.name))
    } catch (e) {
      console.error('Error loading sellers:', e)
    }
  }

  async function loadProducts() {
    setLoading(true)
    try {
      const from = (page - 1) * PAGE_SIZE
      const to = from + PAGE_SIZE - 1

      let query = supabase
        .from('pr_products')
        .select('*', { count: 'exact' })
        .eq('is_active', true)
        .order('product_code', { ascending: true })
        .range(from, to)

      if (appliedSearch) {
        query = query.or(
          `product_code.ilike.%${appliedSearch}%,product_name.ilike.%${appliedSearch}%`
        )
      }
      if (categoryFilter) {
        query = query.eq('product_category', categoryFilter)
      }
      if (productTypeFilter) {
        query = query.eq('product_type', productTypeFilter)
      }

      const { data, error, count } = await query

      if (error) throw error
      setProducts(data || [])
      setTotalCount(count || 0)
    } catch (error: any) {
      console.error('Error loading products:', error)
      showNotify('error', 'เกิดข้อผิดพลาดในการโหลดข้อมูล', error.message)
    } finally {
      setLoading(false)
    }
  }

  function openAdd() {
    setForm(emptyForm())
    setEditingProduct(null)
    setUploadFile(null)
    setUploadPreview(null)
    setModalMode('add')
  }

  function openEdit(product: Product) {
    setEditingProduct(product)
    setForm({
      product_code: product.product_code,
      product_name: product.product_name,
      seller_name: product.seller_name || '',
      product_name_cn: product.product_name_cn || '',
      order_point: product.order_point || '',
      product_category: product.product_category || '',
      product_type: product.product_type || 'FG',
      rubber_code: product.rubber_code || '',
      storage_location: product.storage_location || '',
      unit_cost: product.unit_cost != null ? String(product.unit_cost) : '',
      safety_stock: product.safety_stock != null ? String(product.safety_stock) : '',
      unit_name: product.unit_name || 'ชิ้น',
      unit_multiplier: product.unit_multiplier != null ? String(product.unit_multiplier) : '1',
    })
    setUploadFile(null)
    setUploadPreview(null)
    setModalMode('edit')
  }

  function closeModal() {
    if (uploadPreview) URL.revokeObjectURL(uploadPreview)
    setModalMode(null)
    setEditingProduct(null)
    setForm(emptyForm())
    setUploadFile(null)
    setUploadPreview(null)
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (uploadPreview) URL.revokeObjectURL(uploadPreview)
    setUploadPreview(null)
    setUploadFile(file || null)
    if (file) setUploadPreview(URL.createObjectURL(file))
    e.target.value = ''
  }

  async function handleSave() {
    const code = form.product_code.trim()
    const name = form.product_name.trim()
    if (!code || !name) {
      showNotify('warning', 'กรุณากรอกรหัสสินค้าและชื่อสินค้า')
      return
    }

    setSaving(true)
    try {
      if (uploadFile) {
        await uploadProductImage(uploadFile, code)
      }
      const parsedMultiplier = parseFloat(form.unit_multiplier) || 1
      const unitMultiplier = parsedMultiplier > 0 ? parsedMultiplier : 1

      if (modalMode === 'add') {
        const { error } = await supabase.from('pr_products').insert({
          product_code: code,
          product_name: name,
          seller_name: form.seller_name.trim() || null,
          product_name_cn: form.product_name_cn.trim() || null,
          order_point: form.order_point.trim() || null,
          product_category: form.product_category.trim() || null,
          product_type: form.product_type || 'FG',
          rubber_code: form.rubber_code.trim() || null,
          storage_location: form.storage_location.trim() || null,
          unit_cost: form.unit_cost.trim() ? Number(form.unit_cost.trim()) : 0,
          safety_stock: form.safety_stock.trim() ? Number(form.safety_stock.trim()) : 0,
          unit_name: form.unit_name.trim() || 'ชิ้น',
          unit_multiplier: unitMultiplier,
          is_active: true,
        })
        if (error) throw error
        showNotify('success', 'เพิ่มสินค้าเรียบร้อย')
      } else if (modalMode === 'edit' && editingProduct) {
        const { error } = await supabase
          .from('pr_products')
          .update({
            product_code: code,
            product_name: name,
            seller_name: form.seller_name.trim() || null,
            product_name_cn: form.product_name_cn.trim() || null,
            order_point: form.order_point.trim() || null,
            product_category: form.product_category.trim() || null,
            product_type: form.product_type || 'FG',
            rubber_code: form.rubber_code.trim() || null,
            storage_location: form.storage_location.trim() || null,
            unit_cost: form.unit_cost.trim() ? Number(form.unit_cost.trim()) : 0,
            safety_stock: form.safety_stock.trim() ? Number(form.safety_stock.trim()) : 0,
            unit_name: form.unit_name.trim() || 'ชิ้น',
            unit_multiplier: unitMultiplier,
          })
          .eq('id', editingProduct.id)
        if (error) throw error
        showNotify('success', 'แก้ไขสินค้าเรียบร้อย')
      }
      closeModal()
      loadProducts()
      loadCategories()
    } catch (error: any) {
      console.error('Error saving product:', error)
      showNotify('error', 'เกิดข้อผิดพลาด', error.message)
    } finally {
      setSaving(false)
    }
  }

  function openDeleteConfirm(product: Product) {
    setProductToDelete(product)
  }

  async function confirmDelete() {
    if (!productToDelete) return
    setDeletingId(productToDelete.id)
    try {
      const { error } = await supabase
        .from('pr_products')
        .update({ is_active: false })
        .eq('id', productToDelete.id)
      if (error) throw error
      setProductToDelete(null)
      loadProducts()
    } catch (error: any) {
      console.error('Error deactivating product:', error)
      showNotify('error', 'เกิดข้อผิดพลาด', error.message)
    } finally {
      setDeletingId(null)
    }
  }

  function downloadTemplate() {
    const ws = XLSX.utils.aoa_to_sheet([
      PRODUCT_TEMPLATE_HEADERS as unknown as string[],
      ['P001', 'สินค้าตัวอย่าง', 'ผู้ขายA', '样品', 'จุดA', 'หมวดA', 'FG', 'R001', 'A-1'],
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'สินค้า')
    XLSX.writeFile(wb, 'Template_สินค้า.xlsx')
  }

  async function downloadProductsExcel() {
    try {
      const { data, error } = await supabase
        .from('pr_products')
        .select(
          'product_code, product_name, seller_name, product_name_cn, order_point, product_category, product_type, rubber_code, storage_location'
        )
        .eq('is_active', true)
        .order('product_code', { ascending: true })
      if (error) throw error
      const headers = [...PRODUCT_TEMPLATE_HEADERS]
      const rows = (data || []).map((p) =>
        headers.map((h) => (p as Record<string, unknown>)[h] ?? '')
      )
      const wb = XLSX.utils.book_new()
      const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
      XLSX.utils.book_append_sheet(wb, ws, 'สินค้า')
      XLSX.writeFile(wb, 'ข้อมูลสินค้าทั้งหมด.xlsx')
    } catch (e: any) {
      console.error(e)
      showNotify('error', 'ดาวน์โหลดไม่สำเร็จ', e?.message || String(e))
    }
  }

  async function handleImport(file: File) {
    setImporting(true)
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(new Uint8Array(buf), { type: 'array' })
      const firstSheet = wb.SheetNames[0]
      if (!firstSheet) throw new Error('ไม่มีชีตในไฟล์')
      const sheet = wb.Sheets[firstSheet]
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })
      if (!rows.length) throw new Error('ไม่มีข้อมูลในไฟล์')

      const validTypes: ProductType[] = ['FG', 'RM', 'PP']
      const toInsert: Array<{
        product_code: string
        product_name: string
        seller_name: string | null
        product_name_cn: string | null
        order_point: string | null
        product_category: string | null
        product_type: ProductType
        rubber_code: string | null
        storage_location: string | null
        is_active: boolean
      }> = []
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        const code = String(row.product_code ?? '').trim()
        const name = String(row.product_name ?? '').trim()
        if (!code || !name) continue
        const rawType = String(row.product_type ?? '').trim().toUpperCase()
        const productType: ProductType = validTypes.includes(rawType as ProductType) ? (rawType as ProductType) : 'FG'
        toInsert.push({
          product_code: code,
          product_name: name,
          seller_name: (row.seller_name != null && String(row.seller_name).trim()) || null,
          product_name_cn: (row.product_name_cn != null && String(row.product_name_cn).trim()) || null,
          order_point: (row.order_point != null && String(row.order_point).trim()) || null,
          product_category: (row.product_category != null && String(row.product_category).trim()) || null,
          product_type: productType,
          rubber_code: (row.rubber_code != null && String(row.rubber_code).trim()) || null,
          storage_location: (row.storage_location != null && String(row.storage_location).trim()) || null,
          is_active: true,
        })
      }
      if (!toInsert.length) throw new Error('ไม่มีแถวที่ valid (ต้องมี product_code และ product_name)')

      // ตรวจสอบรหัสสินค้าซ้ำในไฟล์ที่นำเข้า
      const uniqueCodes = new Set<string>()
      const deduped = toInsert.filter((item) => {
        const key = item.product_code.toLowerCase()
        if (uniqueCodes.has(key)) return false
        uniqueCodes.add(key)
        return true
      })
      const dupInFile = toInsert.length - deduped.length

      // ตรวจสอบรหัสสินค้าซ้ำกับข้อมูลในระบบ
      const { data: existingProducts } = await supabase
        .from('pr_products')
        .select('product_code')
        .eq('is_active', true)
      const existingCodes = new Set(
        (existingProducts || []).map((p: { product_code: string }) => p.product_code.toLowerCase())
      )
      const newItems = deduped.filter((item) => !existingCodes.has(item.product_code.toLowerCase()))
      const dupInDb = deduped.length - newItems.length

      if (!newItems.length) {
        const msgs: string[] = []
        if (dupInFile > 0) msgs.push(`ซ้ำในไฟล์ ${dupInFile} รายการ`)
        if (dupInDb > 0) msgs.push(`ซ้ำกับข้อมูลในระบบ ${dupInDb} รายการ`)
        showNotify('warning', 'ไม่มีสินค้าใหม่ที่จะนำเข้า', msgs.join(', '))
        loadProducts()
        loadCategories()
        return
      }

      const { error } = await supabase.from('pr_products').insert(newItems)
      if (error) throw error

      const msgs: string[] = [`นำเข้าสินค้าใหม่ ${newItems.length} รายการเรียบร้อย`]
      if (dupInFile > 0) msgs.push(`ข้ามรายการซ้ำในไฟล์ ${dupInFile} รายการ`)
      if (dupInDb > 0) msgs.push(`ข้ามรายการที่มีอยู่แล้วในระบบ ${dupInDb} รายการ`)
      showNotify('success', 'นำเข้าสินค้าสำเร็จ', msgs.join(', '))
      loadProducts()
      loadCategories()
    } catch (err: any) {
      console.error('Import error:', err)
      showNotify('error', 'นำเข้าสินค้าล้มเหลว', err?.message || String(err))
    } finally {
      setImporting(false)
      importInputRef.current && (importInputRef.current.value = '')
    }
  }

  async function handleUploadImages(files: FileList | null) {
    if (!files?.length) return
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'))
    if (!imageFiles.length) {
      showNotify('warning', 'กรุณาเลือกไฟล์รูปภาพเท่านั้น')
      return
    }
    setUploadingImages(true)
    try {
      let ok = 0
      let fail = 0
      for (const file of imageFiles) {
        try {
          await uploadImageToBucket(file)
          ok++
        } catch (e) {
          console.error('Upload fail:', file.name, e)
          fail++
        }
      }
      if (ok) {
        showNotify('success', 'อัปโหลดรูปสำเร็จ', `${ok} ไฟล์${fail ? ` ล้มเหลว ${fail} ไฟล์` : ''}`)
      }
      if (fail && !ok) showNotify('error', 'อัปโหลดรูปล้มเหลว', fail === 1 ? imageFiles[0].name : `${fail} ไฟล์`)
    } finally {
      setUploadingImages(false)
      uploadImagesInputRef.current && (uploadImagesInputRef.current.value = '')
    }
  }

  // ── Init Import: Download Template ──

  function downloadInitTemplate() {
    const ws = XLSX.utils.aoa_to_sheet([
      [...INIT_IMPORT_HEADERS],
      ['110000001', 'CK02-SET สีแดง', 'CALENDAR', 'FG', 'ผู้ขาย A', 25.50, 500, 20, '25', 'ชั้น A'],
      ['110000002', 'สินค้า B', 'STICKER', 'RM', '', 10.00, 1000, 50, '30', ''],
    ])
    ws['!cols'] = [
      { wch: 14 }, { wch: 28 }, { wch: 14 }, { wch: 12 },
      { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 12 },
      { wch: 12 }, { wch: 14 },
    ]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'สินค้า+สต๊อค')
    XLSX.writeFile(wb, 'Template_สินค้า_สต๊อคเริ่มต้น.xlsx')
  }

  // ── Init Import: Parse Excel → preview ──

  async function handleInitImportFile(file: File) {
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(new Uint8Array(buf), { type: 'array' })
      const firstSheet = wb.SheetNames[0]
      if (!firstSheet) throw new Error('ไม่มีชีตในไฟล์')
      const sheet = wb.Sheets[firstSheet]
      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })
      if (!rawRows.length) throw new Error('ไม่มีข้อมูลในไฟล์')

      const validTypes: ProductType[] = ['FG', 'RM', 'PP']
      const errors: string[] = []
      const parsed: InitImportRow[] = []
      const seenCodes = new Set<string>()

      for (let i = 0; i < rawRows.length; i++) {
        const row = rawRows[i]
        const rowNum = i + 2
        const code = String(row.product_code ?? '').trim()
        const name = String(row.product_name ?? '').trim()
        if (!code) { errors.push(`แถว ${rowNum}: ไม่มี product_code`); continue }
        if (!name) { errors.push(`แถว ${rowNum}: ไม่มี product_name`); continue }
        if (seenCodes.has(code.toLowerCase())) {
          errors.push(`แถว ${rowNum}: product_code "${code}" ซ้ำในไฟล์`)
          continue
        }
        seenCodes.add(code.toLowerCase())

        const rawType = String(row.product_type ?? '').trim().toUpperCase()
        const unitCost = Number(row.unit_cost ?? 0)
        const initialStock = Number(row.initial_stock ?? 0)
        const safetyStock = Number(row.safety_stock ?? 0)

        if (isNaN(unitCost) || unitCost < 0) { errors.push(`แถว ${rowNum}: unit_cost ไม่ถูกต้อง`); continue }
        if (isNaN(initialStock) || initialStock < 0) { errors.push(`แถว ${rowNum}: initial_stock ไม่ถูกต้อง`); continue }
        if (isNaN(safetyStock) || safetyStock < 0) { errors.push(`แถว ${rowNum}: safety_stock ไม่ถูกต้อง`); continue }

        parsed.push({
          product_code: code,
          product_name: name,
          product_category: String(row.product_category ?? '').trim(),
          product_type: validTypes.includes(rawType as ProductType) ? rawType : 'FG',
          seller_name: String(row.seller_name ?? '').trim(),
          unit_cost: unitCost,
          initial_stock: initialStock,
          safety_stock: Math.min(safetyStock, initialStock),
          order_point: String(row.order_point ?? '').trim(),
          storage_location: String(row.storage_location ?? '').trim(),
        })
      }

      if (!parsed.length && errors.length) {
        showNotify('error', 'ไม่มีข้อมูลที่ถูกต้อง', errors.slice(0, 5).join('\n'))
        return
      }

      // Check against existing products
      const { data: existing } = await supabase
        .from('pr_products')
        .select('product_code')
        .eq('is_active', true)
      const existingCodes = new Set(
        (existing || []).map((p: { product_code: string }) => p.product_code.toLowerCase())
      )
      const dupCodes = new Set<string>()
      parsed.forEach((r) => { if (existingCodes.has(r.product_code.toLowerCase())) dupCodes.add(r.product_code) })

      setInitImportRows(parsed)
      setInitImportDupCodes(dupCodes)
      setInitImportErrors(errors)
      setInitImportOpen(true)
    } catch (err: any) {
      console.error('Init import parse error:', err)
      showNotify('error', 'อ่านไฟล์ไม่สำเร็จ', err?.message || String(err))
    } finally {
      if (initImportInputRef.current) initImportInputRef.current.value = ''
    }
  }

  // ── Init Import: Confirm → RPC ──

  async function confirmInitImport() {
    const newRows = initImportRows.filter((r) => !initImportDupCodes.has(r.product_code))
    if (!newRows.length) {
      showNotify('warning', 'ไม่มีสินค้าใหม่ที่จะนำเข้า', 'สินค้าทั้งหมดมีอยู่ในระบบแล้ว')
      return
    }

    setInitImporting(true)
    try {
      const payload = newRows.map((r) => ({
        product_code: r.product_code,
        product_name: r.product_name,
        product_category: r.product_category || null,
        product_type: r.product_type || 'FG',
        seller_name: r.seller_name || null,
        product_name_cn: null,
        unit_cost: r.unit_cost,
        initial_stock: r.initial_stock,
        safety_stock: r.safety_stock,
        order_point: r.order_point || null,
        rubber_code: null,
        storage_location: r.storage_location || null,
      }))

      const { data, error } = await supabase.rpc('rpc_bulk_import_products_with_stock', {
        items: payload,
      })
      if (error) throw error

      const result = data as { imported: number; skipped: number; errors: Array<{ product_code: string; error: string }> }
      const msgs: string[] = []
      msgs.push(`นำเข้าสำเร็จ ${result.imported} รายการ`)
      if (result.skipped > 0) msgs.push(`ข้าม ${result.skipped} รายการ (มีอยู่แล้ว)`)
      if (result.errors?.length > 0) msgs.push(`ผิดพลาด ${result.errors.length} รายการ`)

      showNotify(
        result.errors?.length ? 'warning' : 'success',
        'ผลการนำเข้าสินค้า + สต๊อค',
        msgs.join(', ')
      )

      setInitImportOpen(false)
      setInitImportRows([])
      setInitImportDupCodes(new Set())
      setInitImportErrors([])
      loadProducts()
      loadCategories()
    } catch (err: any) {
      console.error('Init import error:', err)
      showNotify('error', 'นำเข้าล้มเหลว', err?.message || String(err))
    } finally {
      setInitImporting(false)
    }
  }

  return (
    <div className="space-y-6 mt-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={downloadProductsExcel}
            className="px-3 py-2 rounded-xl bg-green-600 text-white hover:bg-green-700 text-sm font-semibold"
          >
            ดาวน์โหลด (Excel)
          </button>
          <button
            type="button"
            onClick={downloadTemplate}
            className="px-3 py-2 rounded-xl bg-gray-500 text-white hover:bg-gray-600 text-sm font-semibold"
          >
            Download Template
          </button>
          <label className="px-3 py-2 rounded-xl bg-yellow-500 text-white hover:bg-yellow-600 text-sm font-semibold cursor-pointer inline-block">
            {importing ? 'กำลังนำเข้า...' : 'Import สินค้า'}
            <input
              ref={importInputRef}
              type="file"
              accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
              className="hidden"
              disabled={importing}
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) handleImport(file)
              }}
            />
          </label>
          {isSuperAdmin && (
            <>
              <button
                type="button"
                onClick={downloadInitTemplate}
                className="px-3 py-2 rounded-xl bg-teal-600 text-white hover:bg-teal-700 text-sm font-semibold"
              >
                Template สต๊อคเริ่มต้น
              </button>
              <label className="px-3 py-2 rounded-xl bg-orange-600 text-white hover:bg-orange-700 text-sm font-semibold cursor-pointer inline-block">
                Import สินค้า + สต๊อคเริ่มต้น
                <input
                  ref={initImportInputRef}
                  type="file"
                  accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) handleInitImportFile(file)
                  }}
                />
              </label>
            </>
          )}
          <label className="px-3 py-2 rounded-xl bg-purple-600 text-white hover:bg-purple-700 text-sm font-semibold cursor-pointer inline-block">
            {uploadingImages ? 'กำลังอัปโหลด...' : 'อัปโหลดรูป'}
            <input
              ref={uploadImagesInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              disabled={uploadingImages}
              onChange={(e) => {
                const files = e.target.files
                e.target.value = ''
                if (files?.length) handleUploadImages(files)
              }}
            />
          </label>
          <button
            type="button"
            onClick={openAdd}
            className="px-4 py-2 rounded-xl bg-blue-600 text-white hover:bg-blue-700 font-semibold"
          >
            + เพิ่มสินค้า
          </button>
      </div>

      <div className="bg-surface-50 p-6 rounded-2xl shadow-soft border border-surface-200">
        <div className="flex flex-wrap gap-4 mb-4">
          <div className="flex-1 min-w-[200px]">
            <label htmlFor="products-search" className="sr-only">ค้นหาสินค้า</label>
            <input
              id="products-search"
              type="text"
              autoComplete="off"
              tabIndex={0}
              placeholder="ค้นหารหัสสินค้าหรือชื่อสินค้า..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-surface-50 text-base"
            />
          </div>
          <div className="w-full sm:w-auto sm:min-w-[150px]">
            <label htmlFor="products-type" className="sr-only">ประเภทสินค้า</label>
            <select
              id="products-type"
              value={productTypeFilter}
              onChange={(e) => setProductTypeFilter(e.target.value as '' | ProductType)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-surface-50 text-base"
            >
              <option value="">ทุกประเภท</option>
              {PRODUCT_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div className="w-full sm:w-auto sm:min-w-[180px]">
            <label htmlFor="products-category" className="sr-only">หมวดหมู่</label>
            <select
              id="products-category"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-surface-50 text-base"
            >
              <option value="">ทุกหมวดหมู่</option>
              {categories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center items-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
          </div>
        ) : products.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            ไม่พบข้อมูลสินค้า
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-blue-600 text-white">
                  <th className="px-3 py-2.5 text-left font-semibold rounded-tl-xl">รูป</th>
                  <th className="px-3 py-2.5 text-left font-semibold">รหัสสินค้า</th>
                  <th className="px-3 py-2.5 text-left font-semibold">ชื่อสินค้า</th>
                  <th className="px-3 py-2.5 text-center font-semibold">ประเภท</th>
                  <th className="px-3 py-2.5 text-left font-semibold">ชื่อผู้ขาย</th>
                  <th className="px-3 py-2.5 text-left font-semibold">ชื่อภาษาจีน</th>
                  <th className="px-3 py-2.5 text-left font-semibold">จุดจัดเก็บ</th>
                  <th className="px-3 py-2.5 text-left font-semibold">รหัสหน้ายาง</th>
                  <th className="px-3 py-2.5 text-left font-semibold">หมวดหมู่</th>
                  <th className="px-3 py-2.5 text-center font-semibold">จุดสั่งซื้อ</th>
                  <th className="px-3 py-2.5 text-center font-semibold">หน่วย</th>
                  <th className="px-3 py-2.5 text-right font-semibold rounded-tr-xl">การจัดการ</th>
                </tr>
              </thead>
              <tbody>
                {products.map((product, idx) => (
                  <tr key={product.id} className={`border-t border-surface-200 hover:bg-blue-50 transition-colors ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                    <td className="px-3 py-2">
                      <ProductImage
                        code={product.product_code}
                        name={product.product_name}
                      />
                    </td>
                    <td className="px-3 py-2 font-semibold text-surface-900">{product.product_code}</td>
                    <td className="px-3 py-2 text-surface-800">{product.product_name}</td>
                    <td className="px-3 py-2 text-center">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-bold ${product.product_type === 'RM' ? 'bg-orange-100 text-orange-700' : product.product_type === 'PP' ? 'bg-purple-100 text-purple-700' : 'bg-green-100 text-green-700'}`}>
                        {product.product_type}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-surface-700">{product.seller_name || '-'}</td>
                    <td className="px-3 py-2 text-surface-700">{product.product_name_cn || '-'}</td>
                    <td className="px-3 py-2 text-surface-700">{product.storage_location || '-'}</td>
                    <td className="px-3 py-2 text-surface-700">{product.rubber_code || '-'}</td>
                    <td className="px-3 py-2 text-surface-700">{product.product_category || '-'}</td>
                    <td className="px-3 py-2 text-center text-surface-700">{product.order_point || '-'}</td>
                    <td className="px-3 py-2 text-center text-surface-700">
                      {product.unit_name || 'ชิ้น'}
                      {product.unit_multiplier != null && product.unit_multiplier > 1 && (
                        <span className="text-xs text-gray-400 ml-1">(x{product.unit_multiplier})</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex gap-2 justify-end">
                        <button
                          type="button"
                          onClick={() => openEdit(product)}
                          className="px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-semibold"
                        >
                          แก้ไข
                        </button>
                        <button
                          type="button"
                          onClick={() => openDeleteConfirm(product)}
                          disabled={deletingId === product.id}
                          className="px-3 py-1.5 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm font-semibold disabled:opacity-50"
                        >
                          {deletingId === product.id ? 'กำลังลบ...' : 'ลบ'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {totalCount > PAGE_SIZE && (
          <div className="flex items-center justify-between mt-4 pt-4 border-t text-sm text-gray-600">
            <span>
              แสดง {Math.min((page - 1) * PAGE_SIZE + 1, totalCount)}–{Math.min(page * PAGE_SIZE, totalCount)} จาก {totalCount} รายการ
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage(1)}
                disabled={page <= 1}
                className="px-2.5 py-1 border rounded-lg hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                «
              </button>
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="px-2.5 py-1 border rounded-lg hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                ‹ ก่อนหน้า
              </button>
              <span className="px-3 py-1 font-medium">
                หน้า {page} / {Math.ceil(totalCount / PAGE_SIZE)}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(Math.ceil(totalCount / PAGE_SIZE), p + 1))}
                disabled={page >= Math.ceil(totalCount / PAGE_SIZE)}
                className="px-2.5 py-1 border rounded-lg hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                ถัดไป ›
              </button>
              <button
                type="button"
                onClick={() => setPage(Math.ceil(totalCount / PAGE_SIZE))}
                disabled={page >= Math.ceil(totalCount / PAGE_SIZE)}
                className="px-2.5 py-1 border rounded-lg hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                »
              </button>
            </div>
          </div>
        )}
      </div>

      <Modal
        open={modalMode !== null}
        onClose={closeModal}
        closeOnBackdropClick={false}
        contentClassName="max-w-2xl !overflow-hidden flex flex-col"
      >
        {/* Sticky Header */}
        <div className="px-6 pt-6 pb-3 border-b border-surface-200 shrink-0">
          <h2 className="text-2xl font-semibold">
            {modalMode === 'add' ? 'เพิ่มสินค้า' : 'แก้ไขสินค้า'}
          </h2>
        </div>
        {/* Scrollable Body */}
        <div className="px-6 py-4 overflow-y-auto flex-1">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
            {/* รหัสสินค้า */}
            <div className="sm:col-span-2">
              <label className="block text-sm font-semibold text-surface-700 mb-1">รหัสสินค้า *</label>
              <input
                type="text"
                value={form.product_code}
                onChange={(e) => setForm((f) => ({ ...f, product_code: e.target.value }))}
                placeholder="รหัสสินค้า"
                className="w-full px-3 py-2 border border-surface-300 rounded-xl text-base"
                readOnly={modalMode === 'edit'}
              />
              {modalMode === 'edit' && (
                <p className="text-xs text-surface-500 mt-1">ไม่สามารถแก้ไขรหัสสินค้าได้</p>
              )}
            </div>
            {/* ชื่อสินค้า */}
            <div className="sm:col-span-2">
              <label className="block text-sm font-semibold text-surface-700 mb-1">ชื่อสินค้า *</label>
              <input
                type="text"
                value={form.product_name}
                onChange={(e) => setForm((f) => ({ ...f, product_name: e.target.value }))}
                placeholder="ชื่อสินค้า"
                className="w-full px-3 py-2 border border-surface-300 rounded-xl text-base"
              />
            </div>
            {/* ชื่อผู้ขาย */}
            <div>
              <label className="block text-sm font-semibold text-surface-700 mb-1">ชื่อผู้ขาย</label>
              <SearchableSelect
                options={sellerOptions}
                value={form.seller_name}
                onChange={(v) => setForm((f) => ({ ...f, seller_name: v }))}
                placeholder="ค้นหาหรือเลือกผู้ขาย..."
              />
            </div>
            {/* ชื่อภาษาจีน */}
            <div>
              <label className="block text-sm font-semibold text-surface-700 mb-1">ชื่อภาษาจีน</label>
              <input
                type="text"
                value={form.product_name_cn}
                onChange={(e) => setForm((f) => ({ ...f, product_name_cn: e.target.value }))}
                placeholder="ชื่อภาษาจีน"
                className="w-full px-3 py-2 border border-surface-300 rounded-xl text-base"
              />
            </div>
            {/* จุดสั่งซื้อ */}
            <div>
              <label className="block text-sm font-semibold text-surface-700 mb-1">จุดสั่งซื้อ</label>
              <input
                type="text"
                value={form.order_point}
                onChange={(e) => setForm((f) => ({ ...f, order_point: e.target.value }))}
                placeholder="จุดสั่งซื้อ"
                className="w-full px-3 py-2 border border-surface-300 rounded-xl text-base"
              />
            </div>
            {/* จุดจัดเก็บ */}
            <div>
              <label className="block text-sm font-semibold text-surface-700 mb-1">จุดจัดเก็บ</label>
              <input
                type="text"
                value={form.storage_location}
                onChange={(e) => setForm((f) => ({ ...f, storage_location: e.target.value }))}
                placeholder="จุดจัดเก็บ"
                className="w-full px-3 py-2 border border-surface-300 rounded-xl text-base"
              />
            </div>
            {/* หมวดหมู่ */}
            <div>
              <label className="block text-sm font-semibold text-surface-700 mb-1">หมวดหมู่</label>
              <input
                type="text"
                value={form.product_category}
                onChange={(e) => setForm((f) => ({ ...f, product_category: e.target.value }))}
                placeholder="หมวดหมู่สินค้า"
                className="w-full px-3 py-2 border border-surface-300 rounded-xl text-base"
              />
            </div>
            {/* ประเภทสินค้า */}
            <div>
              <label className="block text-sm font-semibold text-surface-700 mb-1">ประเภทสินค้า</label>
              <select
                value={form.product_type}
                onChange={(e) => setForm((f) => ({ ...f, product_type: e.target.value as ProductType }))}
                className="w-full px-3 py-2 border border-surface-300 rounded-xl text-base"
              >
                {PRODUCT_TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            {/* รหัสหน้ายาง */}
            <div>
              <label className="block text-sm font-semibold text-surface-700 mb-1">รหัสหน้ายาง</label>
              <input
                type="text"
                value={form.rubber_code}
                onChange={(e) => setForm((f) => ({ ...f, rubber_code: e.target.value }))}
                placeholder="รหัสหน้ายาง"
                className="w-full px-3 py-2 border border-surface-300 rounded-xl text-base"
              />
            </div>
            {/* ต้นทุนสินค้า — ซ่อนฟิลด์นี้เพราะ landed_cost คำนวณจาก Lot อัตโนมัติ */}
            {/* Safety Stock — ปรับผ่านหน้า คลัง > ปรับสต๊อค เท่านั้น (โยก lot จริงผ่าน FIFO) */}
            {/* ─── หน่วยสินค้า (2 ช่องบรรทัดเดียวกัน) ─── */}
            <div>
              <label className="block text-sm font-semibold text-surface-700 mb-1">หน่วย</label>
              <div className="flex gap-2">
                <select
                  value={UNIT_PRESETS.includes(form.unit_name) ? form.unit_name : '__custom__'}
                  onChange={(e) => {
                    if (e.target.value === '__custom__') {
                      setForm((f) => ({ ...f, unit_name: '' }))
                    } else {
                      setForm((f) => ({ ...f, unit_name: e.target.value }))
                    }
                  }}
                  className="w-full px-3 py-2 border border-surface-300 rounded-xl text-base"
                >
                  {UNIT_PRESETS.map((u) => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                  <option value="__custom__">อื่นๆ...</option>
                </select>
                {!UNIT_PRESETS.includes(form.unit_name) && (
                  <input
                    type="text"
                    value={form.unit_name}
                    onChange={(e) => setForm((f) => ({ ...f, unit_name: e.target.value }))}
                    placeholder="พิมพ์ชื่อหน่วย"
                    className="flex-1 px-3 py-2 border border-surface-300 rounded-xl text-base"
                  />
                )}
              </div>
            </div>
            <div>
              <label className="block text-sm font-semibold text-surface-700 mb-1">ชิ้น/หน่วย</label>
              <input
                type="number"
                min={1}
                step="any"
                value={form.unit_multiplier}
                onChange={(e) => setForm((f) => ({ ...f, unit_multiplier: e.target.value }))}
                onBlur={() => {
                  const v = parseFloat(form.unit_multiplier)
                  if (!v || v <= 0) setForm((f) => ({ ...f, unit_multiplier: '1' }))
                }}
                placeholder="1"
                className="w-full px-3 py-2 border border-surface-300 rounded-xl text-base"
              />
              <p className="text-xs text-surface-500 mt-1">
                เช่น คู่ = 2, แพ็ค 12 ชิ้น = 12
              </p>
            </div>
            {/* รูปสินค้า */}
            <div className="sm:col-span-2">
              <label className="block text-sm font-semibold text-surface-700 mb-1">รูปสินค้า</label>
              <p className="text-xs text-surface-500 mb-1">
                อัปโหลดรูปจะเก็บใน Bucket {BUCKET_PRODUCT_IMAGES} ชื่อไฟล์ = รหัสสินค้า
                {modalMode === 'edit' && ' — อัปโหลดรูปใหม่จะแทนที่รูปเก่า'}
              </p>
              <input
                type="file"
                accept="image/*"
                onChange={onFileChange}
                className="w-full text-sm text-surface-600 file:mr-2 file:py-2 file:px-3 file:rounded file:border-0 file:bg-primary-50 file:text-primary-700 hover:file:bg-primary-100"
              />
              {(uploadPreview || (form.product_code.trim() && !uploadFile)) && (
                <div className="mt-2">
                  <span className="text-xs text-surface-500 block mb-1">พรีวิว</span>
                  {uploadPreview ? (
                    <img
                      src={uploadPreview}
                      alt="พรีวิว"
                      className="w-24 h-24 object-cover rounded border"
                    />
                  ) : (
                    <ProductImage code={form.product_code.trim()} name={form.product_name} />
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
        {/* Sticky Footer */}
        <div className="px-6 py-4 border-t border-surface-200 flex gap-2 justify-end shrink-0">
          <button
            type="button"
            onClick={closeModal}
            className="px-4 py-2 border border-surface-300 rounded-xl hover:bg-surface-100"
          >
            ยกเลิก
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-primary-200 text-primary-900 rounded-xl hover:bg-primary-300 disabled:opacity-50 font-semibold"
          >
            {saving ? 'กำลังบันทึก...' : modalMode === 'add' ? 'เพิ่มสินค้า' : 'บันทึก'}
          </button>
        </div>
      </Modal>

      <Modal
        open={productToDelete !== null}
        onClose={() => setProductToDelete(null)}
        closeOnBackdropClick={true}
        contentClassName="max-w-md"
      >
        <div className="p-6">
          <h2 className="text-2xl font-semibold mb-3 text-surface-900">ยืนยันปิดการใช้งานสินค้า</h2>
          {productToDelete && (
            <p className="text-surface-700 mb-4">
              ต้องการปิดการใช้งานสินค้า <strong>"{productToDelete.product_name}"</strong> (รหัส {productToDelete.product_code}) ใช่หรือไม่?
              <br />
              <span className="text-sm text-surface-500">สินค้าจะไม่แสดงในรายการแต่ยังอยู่ในระบบ</span>
            </p>
          )}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => setProductToDelete(null)}
              className="px-4 py-2 border border-surface-300 rounded-xl hover:bg-surface-100"
            >
              ยกเลิก
            </button>
            <button
              type="button"
              onClick={confirmDelete}
              disabled={deletingId === productToDelete?.id}
              className="px-4 py-2 bg-accent-200 text-surface-900 rounded-xl hover:bg-accent-300 disabled:opacity-50 font-semibold"
            >
              {deletingId === productToDelete?.id ? 'กำลังลบ...' : 'ปิดการใช้งาน'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Init Import Preview Modal */}
      <Modal
        open={initImportOpen}
        onClose={() => { if (!initImporting) { setInitImportOpen(false); setInitImportRows([]); setInitImportDupCodes(new Set()); setInitImportErrors([]) } }}
        closeOnBackdropClick={false}
        contentClassName="max-w-5xl !overflow-hidden flex flex-col"
      >
        <div className="px-6 pt-6 pb-3 border-b border-surface-200 shrink-0">
          <h2 className="text-2xl font-semibold">ตรวจสอบข้อมูลก่อนนำเข้า</h2>
          <p className="text-sm text-surface-500 mt-1">กรุณาตรวจสอบข้อมูลด้านล่างให้ถูกต้อง แล้วกด "ยืนยันนำเข้า"</p>
        </div>

        <div className="flex-1 overflow-auto px-6 py-4 space-y-4">
          {/* Summary */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-blue-50 rounded-xl p-3 text-center">
              <div className="text-2xl font-bold text-blue-700">{initImportRows.length}</div>
              <div className="text-xs text-blue-600">ทั้งหมดในไฟล์</div>
            </div>
            <div className="bg-green-50 rounded-xl p-3 text-center">
              <div className="text-2xl font-bold text-green-700">{initImportRows.length - initImportDupCodes.size}</div>
              <div className="text-xs text-green-600">สินค้าใหม่ (จะนำเข้า)</div>
            </div>
            <div className="bg-amber-50 rounded-xl p-3 text-center">
              <div className="text-2xl font-bold text-amber-700">{initImportDupCodes.size}</div>
              <div className="text-xs text-amber-600">ซ้ำกับในระบบ (ข้าม)</div>
            </div>
            <div className="bg-red-50 rounded-xl p-3 text-center">
              <div className="text-2xl font-bold text-red-700">{initImportErrors.length}</div>
              <div className="text-xs text-red-600">แถวที่มีปัญหา</div>
            </div>
          </div>

          {/* Errors */}
          {initImportErrors.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-3">
              <h4 className="text-sm font-semibold text-red-700 mb-1">แถวที่มีปัญหา (ไม่ถูกนำเข้า)</h4>
              <ul className="text-xs text-red-600 space-y-0.5 max-h-24 overflow-y-auto">
                {initImportErrors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </div>
          )}

          {/* Data Table */}
          {initImportRows.length > 0 && (
            <div className="overflow-x-auto border border-surface-200 rounded-xl">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-surface-100">
                    <th className="px-2 py-2 text-left font-semibold">สถานะ</th>
                    <th className="px-2 py-2 text-left font-semibold">รหัสสินค้า</th>
                    <th className="px-2 py-2 text-left font-semibold">ชื่อสินค้า</th>
                    <th className="px-2 py-2 text-left font-semibold">หมวดหมู่</th>
                    <th className="px-2 py-2 text-center font-semibold">ประเภท</th>
                    <th className="px-2 py-2 text-right font-semibold">ต้นทุน</th>
                    <th className="px-2 py-2 text-right font-semibold">สต๊อครวม</th>
                    <th className="px-2 py-2 text-right font-semibold">Safety</th>
                    <th className="px-2 py-2 text-right font-semibold">On Hand</th>
                    <th className="px-2 py-2 text-left font-semibold">จุดสั่งซื้อ</th>
                  </tr>
                </thead>
                <tbody>
                  {initImportRows.map((row, idx) => {
                    const isDup = initImportDupCodes.has(row.product_code)
                    const onHand = row.initial_stock - row.safety_stock
                    return (
                      <tr key={idx} className={`border-t ${isDup ? 'bg-amber-50 text-amber-700 line-through opacity-60' : idx % 2 === 0 ? 'bg-white' : 'bg-surface-50'}`}>
                        <td className="px-2 py-1.5">
                          {isDup ? (
                            <span className="inline-block px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-200 text-amber-800">ข้าม</span>
                          ) : (
                            <span className="inline-block px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-green-200 text-green-800">ใหม่</span>
                          )}
                        </td>
                        <td className="px-2 py-1.5 font-mono font-semibold">{row.product_code}</td>
                        <td className="px-2 py-1.5 max-w-[200px] truncate">{row.product_name}</td>
                        <td className="px-2 py-1.5">{row.product_category || '-'}</td>
                        <td className="px-2 py-1.5 text-center">
                          <span className={`inline-block px-1.5 py-0.5 rounded-full text-[10px] font-bold ${row.product_type === 'RM' ? 'bg-orange-100 text-orange-700' : row.product_type === 'PP' ? 'bg-purple-100 text-purple-700' : 'bg-green-100 text-green-700'}`}>
                            {row.product_type}
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-right">{row.unit_cost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        <td className="px-2 py-1.5 text-right font-semibold">{row.initial_stock.toLocaleString()}</td>
                        <td className="px-2 py-1.5 text-right">{row.safety_stock.toLocaleString()}</td>
                        <td className="px-2 py-1.5 text-right">{onHand.toLocaleString()}</td>
                        <td className="px-2 py-1.5">{row.order_point || '-'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-surface-200 flex gap-2 justify-end shrink-0">
          <button
            type="button"
            onClick={() => { setInitImportOpen(false); setInitImportRows([]); setInitImportDupCodes(new Set()); setInitImportErrors([]) }}
            disabled={initImporting}
            className="px-4 py-2 border border-surface-300 rounded-xl hover:bg-surface-100 disabled:opacity-50"
          >
            ยกเลิก
          </button>
          <button
            type="button"
            onClick={confirmInitImport}
            disabled={initImporting || (initImportRows.length - initImportDupCodes.size) === 0}
            className="px-4 py-2 bg-orange-600 text-white rounded-xl hover:bg-orange-700 disabled:opacity-50 font-semibold"
          >
            {initImporting ? 'กำลังนำเข้า...' : `ยืนยันนำเข้า (${initImportRows.length - initImportDupCodes.size} รายการ)`}
          </button>
        </div>
      </Modal>

      {/* Notification Modal */}
      <Modal open={notifyModal.open} onClose={() => setNotifyModal((p) => ({ ...p, open: false }))} closeOnBackdropClick contentClassName="max-w-sm">
        <div className="p-6 text-center">
          <div className={`mx-auto w-14 h-14 rounded-full flex items-center justify-center mb-4 ${
            notifyModal.type === 'success' ? 'bg-green-100' : notifyModal.type === 'error' ? 'bg-red-100' : 'bg-amber-100'
          }`}>
            {notifyModal.type === 'success' && (
              <svg className="w-7 h-7 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            )}
            {notifyModal.type === 'error' && (
              <svg className="w-7 h-7 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            )}
            {notifyModal.type === 'warning' && (
              <svg className="w-7 h-7 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )}
          </div>
          <h3 className={`text-lg font-bold mb-1 ${
            notifyModal.type === 'success' ? 'text-green-800' : notifyModal.type === 'error' ? 'text-red-800' : 'text-amber-800'
          }`}>
            {notifyModal.title}
          </h3>
          {notifyModal.message && (
            <p className="text-sm text-gray-600 mt-1">{notifyModal.message}</p>
          )}
          <button
            type="button"
            onClick={() => setNotifyModal((p) => ({ ...p, open: false }))}
            className={`mt-5 px-6 py-2.5 rounded-xl font-semibold text-white transition-colors ${
              notifyModal.type === 'success' ? 'bg-green-600 hover:bg-green-700'
                : notifyModal.type === 'error' ? 'bg-red-600 hover:bg-red-700'
                : 'bg-amber-500 hover:bg-amber-600'
            }`}
          >
            ตกลง
          </button>
        </div>
      </Modal>
    </div>
  )
}

function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = 'ค้นหา...',
}: {
  options: string[]
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const wrapperRef = useRef<HTMLDivElement>(null)

  // ปิด dropdown เมื่อคลิกข้างนอก
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const filtered = options.filter((o) =>
    o.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div ref={wrapperRef} className="relative">
      <div
        className="w-full flex items-center border border-surface-300 rounded-xl bg-white cursor-pointer"
        onClick={() => setOpen(true)}
      >
        <input
          type="text"
          value={open ? search : value || ''}
          onChange={(e) => { setSearch(e.target.value); if (!open) setOpen(true) }}
          onFocus={() => { setOpen(true); setSearch('') }}
          placeholder={value ? value : placeholder}
          className="flex-1 px-3 py-2 rounded-xl text-base outline-none bg-transparent"
        />
        {value && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onChange(''); setSearch('') }}
            className="px-2 text-gray-400 hover:text-red-500"
            title="ล้าง"
          >
            &times;
          </button>
        )}
        <span className="px-2 text-gray-400 pointer-events-none">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
        </span>
      </div>
      {open && (
        <ul className="absolute z-50 mt-1 w-full max-h-48 overflow-y-auto bg-white border border-surface-300 rounded-xl shadow-lg">
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-gray-400 italic text-sm">ไม่พบข้อมูล</li>
          ) : (
            filtered.map((opt) => (
              <li
                key={opt}
                className={`px-3 py-2 cursor-pointer hover:bg-blue-50 text-sm ${opt === value ? 'bg-blue-100 font-semibold text-blue-700' : ''}`}
                onClick={() => { onChange(opt); setOpen(false); setSearch('') }}
              >
                {opt}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}

function ProductImage({
  code,
  name,
  imageUrl,
}: {
  code: string
  name: string
  imageUrl?: string | null
}) {
  const [failed, setFailed] = useState(false)
  const url = imageUrl || (code ? getProductImageUrl(code) : '')
  const displayUrl = url && !failed ? url : ''
  if (!displayUrl) {
    return (
      <div className="w-20 h-20 bg-surface-200 rounded-xl flex items-center justify-center text-surface-400 text-xs">
        ไม่มีรูป
      </div>
    )
  }
  return (
    <a
      href={displayUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="block w-20 h-20 rounded-xl overflow-hidden hover:ring-2 hover:ring-primary-200 focus:outline-none focus:ring-2 focus:ring-primary-200"
      title="คลิกเพื่อเปิดรูปในแท็บใหม่"
    >
      <img
        src={displayUrl}
        alt={name}
        className="w-20 h-20 object-cover"
        onError={() => setFailed(true)}
      />
    </a>
  )
}
