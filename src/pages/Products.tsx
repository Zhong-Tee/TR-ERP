import { useState, useEffect, useRef } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import { getPublicUrl } from '../lib/qcApi'
import Modal from '../components/ui/Modal'
import { Product } from '../types'

const SEARCH_DEBOUNCE_MS = 400

const BUCKET_PRODUCT_IMAGES = 'product-images'
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || ''

function getProductImageUrl(productCode: string | null | undefined, ext: string = '.jpg'): string {
  return getPublicUrl(BUCKET_PRODUCT_IMAGES, productCode, ext)
}

const PRODUCT_TEMPLATE_HEADERS = [
  'product_code',
  'product_name',
  'product_category',
  'product_type',
  'rubber_code',
  'storage_location',
] as const

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

const emptyForm = () => ({
  product_code: '',
  product_name: '',
  product_category: '',
  product_type: '',
  rubber_code: '',
  storage_location: '',
})

export default function Products() {
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [searchInput, setSearchInput] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
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

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const importInputRef = useRef<HTMLInputElement>(null)
  const uploadImagesInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    debounceRef.current = setTimeout(() => {
      setAppliedSearch(searchInput.trim())
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [searchInput])

  useEffect(() => {
    loadProducts()
  }, [appliedSearch, categoryFilter])

  useEffect(() => {
    loadCategories()
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

  async function loadProducts() {
    setLoading(true)
    try {
      let query = supabase
        .from('pr_products')
        .select('*')
        .eq('is_active', true)
        .order('product_code', { ascending: true })

      if (appliedSearch) {
        query = query.or(
          `product_code.ilike.%${appliedSearch}%,product_name.ilike.%${appliedSearch}%`
        )
      }
      if (categoryFilter) {
        query = query.eq('product_category', categoryFilter)
      }

      const { data, error } = await query

      if (error) throw error
      setProducts(data || [])
    } catch (error: any) {
      console.error('Error loading products:', error)
      alert('เกิดข้อผิดพลาดในการโหลดข้อมูล: ' + error.message)
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
      product_category: product.product_category || '',
      product_type: product.product_type || '',
      rubber_code: product.rubber_code || '',
      storage_location: product.storage_location || '',
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
      alert('กรุณากรอกรหัสสินค้าและชื่อสินค้า')
      return
    }

    setSaving(true)
    try {
      if (uploadFile) {
        await uploadProductImage(uploadFile, code)
      }
      if (modalMode === 'add') {
        const { error } = await supabase.from('pr_products').insert({
          product_code: code,
          product_name: name,
          product_category: form.product_category.trim() || null,
          product_type: form.product_type.trim() || null,
          rubber_code: form.rubber_code.trim() || null,
          storage_location: form.storage_location.trim() || null,
          is_active: true,
        })
        if (error) throw error
        alert('เพิ่มสินค้าเรียบร้อย')
      } else if (modalMode === 'edit' && editingProduct) {
        const { error } = await supabase
          .from('pr_products')
          .update({
            product_code: code,
            product_name: name,
            product_category: form.product_category.trim() || null,
            product_type: form.product_type.trim() || null,
            rubber_code: form.rubber_code.trim() || null,
            storage_location: form.storage_location.trim() || null,
          })
          .eq('id', editingProduct.id)
        if (error) throw error
        alert('แก้ไขสินค้าเรียบร้อย')
      }
      closeModal()
      loadProducts()
      loadCategories()
    } catch (error: any) {
      console.error('Error saving product:', error)
      alert('เกิดข้อผิดพลาด: ' + error.message)
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
      alert('เกิดข้อผิดพลาด: ' + error.message)
    } finally {
      setDeletingId(null)
    }
  }

  function downloadTemplate() {
    const ws = XLSX.utils.aoa_to_sheet([
      PRODUCT_TEMPLATE_HEADERS as unknown as string[],
      ['P001', 'สินค้าตัวอย่าง', 'หมวดA', 'ประเภท1', 'R001', 'A-1'],
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'สินค้า')
    XLSX.writeFile(wb, 'Template_สินค้า.xlsx')
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

      const toInsert: Array<{
        product_code: string
        product_name: string
        product_category: string | null
        product_type: string | null
        rubber_code: string | null
        storage_location: string | null
        is_active: boolean
      }> = []
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        const code = String(row.product_code ?? '').trim()
        const name = String(row.product_name ?? '').trim()
        if (!code || !name) continue
        toInsert.push({
          product_code: code,
          product_name: name,
          product_category: (row.product_category != null && String(row.product_category).trim()) || null,
          product_type: (row.product_type != null && String(row.product_type).trim()) || null,
          rubber_code: (row.rubber_code != null && String(row.rubber_code).trim()) || null,
          storage_location: (row.storage_location != null && String(row.storage_location).trim()) || null,
          is_active: true,
        })
      }
      if (!toInsert.length) throw new Error('ไม่มีแถวที่ valid (ต้องมี product_code และ product_name)')

      const { error } = await supabase.from('pr_products').insert(toInsert)
      if (error) throw error
      alert(`นำเข้าสินค้า ${toInsert.length} รายการเรียบร้อย`)
      loadProducts()
      loadCategories()
    } catch (err: any) {
      console.error('Import error:', err)
      alert('นำเข้าสินค้าล้มเหลว: ' + (err?.message || err))
    } finally {
      setImporting(false)
      importInputRef.current && (importInputRef.current.value = '')
    }
  }

  async function handleUploadImages(files: FileList | null) {
    if (!files?.length) return
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'))
    if (!imageFiles.length) {
      alert('กรุณาเลือกไฟล์รูปภาพเท่านั้น')
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
        alert(`อัปโหลดรูปสำเร็จ ${ok} ไฟล์${fail ? ` ล้มเหลว ${fail} ไฟล์` : ''}`)
      }
      if (fail && !ok) alert('อัปโหลดรูปล้มเหลว: ' + (fail === 1 ? imageFiles[0].name : `${fail} ไฟล์`))
    } finally {
      setUploadingImages(false)
      uploadImagesInputRef.current && (uploadImagesInputRef.current.value = '')
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold">จัดการสินค้า</h1>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={downloadTemplate}
            className="px-3 py-2 border border-gray-400 rounded hover:bg-gray-50 text-sm"
          >
            Download Template
          </button>
          <label className="px-3 py-2 border border-gray-400 rounded hover:bg-gray-50 text-sm cursor-pointer disabled:opacity-50 inline-block">
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
          <label className="px-3 py-2 border border-gray-400 rounded hover:bg-gray-50 text-sm cursor-pointer disabled:opacity-50 inline-block">
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
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 text-white"
          >
            + เพิ่มสินค้า
          </button>
        </div>
      </div>

      <div className="bg-white p-6 rounded-lg shadow">
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
              className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
          </div>
          <div className="w-full sm:w-auto sm:min-w-[180px]">
            <label htmlFor="products-category" className="sr-only">หมวดหมู่</label>
            <select
              id="products-category"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
            >
              <option value="">ทั้งหมด</option>
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
            <table className="w-full">
              <thead className="bg-gray-100">
                <tr>
                  <th className="p-3 text-left">รูป</th>
                  <th className="p-3 text-left">รหัสสินค้า</th>
                  <th className="p-3 text-left">ชื่อสินค้า</th>
                  <th className="p-3 text-left">จุดจัดเก็บ</th>
                  <th className="p-3 text-left">รหัสหน้ายาง</th>
                  <th className="p-3 text-left">หมวดหมู่</th>
                  <th className="p-3 text-right">การจัดการ</th>
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <tr key={product.id} className="border-t">
                    <td className="p-3">
                      <ProductImage
                        code={product.product_code}
                        name={product.product_name}
                      />
                    </td>
                    <td className="p-3 font-medium">{product.product_code}</td>
                    <td className="p-3">{product.product_name}</td>
                    <td className="p-3">{product.storage_location || '-'}</td>
                    <td className="p-3">{product.rubber_code || '-'}</td>
                    <td className="p-3">{product.product_category || '-'}</td>
                    <td className="p-3 text-right">
                      <div className="flex gap-2 justify-end">
                        <button
                          type="button"
                          onClick={() => openEdit(product)}
                          className="px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 text-sm"
                        >
                          แก้ไข
                        </button>
                        <button
                          type="button"
                          onClick={() => openDeleteConfirm(product)}
                          disabled={deletingId === product.id}
                          className="px-3 py-1 bg-red-500 text-white rounded hover:bg-red-600 text-sm disabled:opacity-50"
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
      </div>

      <Modal
        open={modalMode !== null}
        onClose={closeModal}
        closeOnBackdropClick={false}
        contentClassName="max-w-lg"
      >
        <div className="p-6">
          <h2 className="text-xl font-bold mb-4">
            {modalMode === 'add' ? 'เพิ่มสินค้า' : 'แก้ไขสินค้า'}
          </h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">รหัสสินค้า *</label>
              <input
                type="text"
                value={form.product_code}
                onChange={(e) => setForm((f) => ({ ...f, product_code: e.target.value }))}
                placeholder="รหัสสินค้า"
                className="w-full px-3 py-2 border rounded-lg"
                readOnly={modalMode === 'edit'}
              />
              {modalMode === 'edit' && (
                <p className="text-xs text-gray-500 mt-1">ไม่สามารถแก้ไขรหัสสินค้าได้</p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">ชื่อสินค้า *</label>
              <input
                type="text"
                value={form.product_name}
                onChange={(e) => setForm((f) => ({ ...f, product_name: e.target.value }))}
                placeholder="ชื่อสินค้า"
                className="w-full px-3 py-2 border rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">จุดจัดเก็บ</label>
              <input
                type="text"
                value={form.storage_location}
                onChange={(e) => setForm((f) => ({ ...f, storage_location: e.target.value }))}
                placeholder="จุดจัดเก็บ"
                className="w-full px-3 py-2 border rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">หมวดหมู่</label>
              <input
                type="text"
                value={form.product_category}
                onChange={(e) => setForm((f) => ({ ...f, product_category: e.target.value }))}
                placeholder="หมวดหมู่สินค้า"
                className="w-full px-3 py-2 border rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">ประเภทสินค้า</label>
              <input
                type="text"
                value={form.product_type}
                onChange={(e) => setForm((f) => ({ ...f, product_type: e.target.value }))}
                placeholder="ประเภท"
                className="w-full px-3 py-2 border rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">รหัสหน้ายาง</label>
              <input
                type="text"
                value={form.rubber_code}
                onChange={(e) => setForm((f) => ({ ...f, rubber_code: e.target.value }))}
                placeholder="รหัสหน้ายาง"
                className="w-full px-3 py-2 border rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">รูปสินค้า</label>
              <p className="text-xs text-gray-500 mb-1">
                อัปโหลดรูปจะเก็บใน Bucket {BUCKET_PRODUCT_IMAGES} ชื่อไฟล์ = รหัสสินค้า
                {modalMode === 'edit' && ' — อัปโหลดรูปใหม่จะแทนที่รูปเก่า'}
              </p>
              <input
                type="file"
                accept="image/*"
                onChange={onFileChange}
                className="w-full text-sm text-gray-600 file:mr-2 file:py-2 file:px-3 file:rounded file:border-0 file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
              />
              {(uploadPreview || (form.product_code.trim() && !uploadFile)) && (
                <div className="mt-2">
                  <span className="text-xs text-gray-500 block mb-1">พรีวิว</span>
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
          <div className="flex gap-2 mt-6 justify-end">
            <button
              type="button"
              onClick={closeModal}
              className="px-4 py-2 border rounded-lg hover:bg-gray-50"
            >
              ยกเลิก
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50"
            >
              {saving ? 'กำลังบันทึก...' : modalMode === 'add' ? 'เพิ่มสินค้า' : 'บันทึก'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={productToDelete !== null}
        onClose={() => setProductToDelete(null)}
        closeOnBackdropClick={true}
        contentClassName="max-w-md"
      >
        <div className="p-6">
          <h2 className="text-xl font-bold mb-3 text-gray-800">ยืนยันปิดการใช้งานสินค้า</h2>
          {productToDelete && (
            <p className="text-gray-600 mb-4">
              ต้องการปิดการใช้งานสินค้า <strong>"{productToDelete.product_name}"</strong> (รหัส {productToDelete.product_code}) ใช่หรือไม่?
              <br />
              <span className="text-sm text-gray-500">สินค้าจะไม่แสดงในรายการแต่ยังอยู่ในระบบ</span>
            </p>
          )}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => setProductToDelete(null)}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              ยกเลิก
            </button>
            <button
              type="button"
              onClick={confirmDelete}
              disabled={deletingId === productToDelete?.id}
              className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-50"
            >
              {deletingId === productToDelete?.id ? 'กำลังลบ...' : 'ปิดการใช้งาน'}
            </button>
          </div>
        </div>
      </Modal>
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
      <div className="w-16 h-16 bg-gray-200 rounded flex items-center justify-center text-gray-400 text-xs">
        ไม่มีรูป
      </div>
    )
  }
  return (
    <a
      href={displayUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="block w-16 h-16 rounded overflow-hidden hover:ring-2 hover:ring-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
      title="คลิกเพื่อเปิดรูปในแท็บใหม่"
    >
      <img
        src={displayUrl}
        alt={name}
        className="w-16 h-16 object-cover"
        onError={() => setFailed(true)}
      />
    </a>
  )
}
