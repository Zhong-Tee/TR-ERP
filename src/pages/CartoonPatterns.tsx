import { useState, useEffect, useRef } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import { getPublicUrl } from '../lib/qcApi'
import Modal from '../components/ui/Modal'
import { CartoonPattern } from '../types'

const SEARCH_DEBOUNCE_MS = 400
const BUCKET_CARTOON_PATTERNS = 'cartoon-patterns'
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || ''

function getPatternImageUrl(patternName: string | null | undefined, ext: string = '.jpg'): string {
  return getPublicUrl(BUCKET_CARTOON_PATTERNS, patternName, ext)
}

/** อัปโหลดไฟล์รูปไป bucket cartoon-patterns ชื่อไฟล์ = patternName + นามสกุล */
async function uploadPatternImage(file: File, patternName: string): Promise<string> {
  const ext = file.name.includes('.') ? '.' + file.name.split('.').pop() : '.jpg'
  const fileName = patternName.trim() + ext
  const { data, error } = await supabase.storage
    .from(BUCKET_CARTOON_PATTERNS)
    .upload(fileName, file, {
      cacheControl: '3600',
      upsert: true,
      contentType: file.type || `image/${ext.replace('.', '')}`,
    })
  if (error) throw error
  return `${supabaseUrl}/storage/v1/object/public/${BUCKET_CARTOON_PATTERNS}/${encodeURIComponent(data.path)}`
}

/** อัปโหลดรูปเดียวไป bucket ด้วยชื่อไฟล์เดิม (ใช้สำหรับอัปโหลดหลายรูป) */
async function uploadImageToBucket(file: File): Promise<void> {
  const fileName = file.name || `image-${Date.now()}.jpg`
  const { error } = await supabase.storage
    .from(BUCKET_CARTOON_PATTERNS)
    .upload(fileName, file, {
      cacheControl: '3600',
      upsert: true,
      contentType: file.type || 'image/jpeg',
    })
  if (error) throw error
}

const PATTERN_TEMPLATE_HEADERS = ['pattern_name', 'product_category', 'line_count'] as const

export default function CartoonPatterns() {
  const [patterns, setPatterns] = useState<CartoonPattern[]>([])
  const [loading, setLoading] = useState(true)
  const [searchInput, setSearchInput] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [modalMode, setModalMode] = useState<'add' | 'edit' | null>(null)
  const [editingPattern, setEditingPattern] = useState<CartoonPattern | null>(null)
  const [formPatternName, setFormPatternName] = useState('')
  const [formPatternCategory, setFormPatternCategory] = useState('')
  const [formLineCount, setFormLineCount] = useState<number | ''>('')
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [patternToDelete, setPatternToDelete] = useState<CartoonPattern | null>(null)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadPreview, setUploadPreview] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [uploadingImages, setUploadingImages] = useState(false)
  const [productCategories, setProductCategories] = useState<string[]>([])
  const [categoryFieldSettings, setCategoryFieldSettings] = useState<Record<string, { line_1?: boolean; line_2?: boolean; line_3?: boolean }>>({})
  const [categoryDrafts, setCategoryDrafts] = useState<Record<string, string>>({})
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
    loadPatterns()
  }, [appliedSearch])

  useEffect(() => {
    loadProductCategories()
    loadCategoryFieldSettings()
  }, [])

  async function loadProductCategories() {
    try {
      const { data, error } = await supabase
        .from('pr_products')
        .select('product_category')
        .eq('is_active', true)
        .not('product_category', 'is', null)
      if (error) throw error
      const categories = Array.from(
        new Set(
          (data || [])
            .map((r: { product_category: string | null }) => r.product_category)
            .filter((c): c is string => !!c && String(c).trim() !== '')
        )
      ).sort((a, b) => a.localeCompare(b))
      setProductCategories(categories)
    } catch (error: any) {
      console.error('Error loading product categories:', error)
      setProductCategories([])
    }
  }

  async function loadCategoryFieldSettings() {
    try {
      const { data, error } = await supabase
        .from('pr_category_field_settings')
        .select('category, line_1, line_2, line_3')
      if (error) throw error
      const map: Record<string, { line_1?: boolean; line_2?: boolean; line_3?: boolean }> = {}
      ;(data || []).forEach((row: any) => {
        map[row.category] = {
          line_1: row.line_1 ?? true,
          line_2: row.line_2 ?? true,
          line_3: row.line_3 ?? true,
        }
      })
      setCategoryFieldSettings(map)
    } catch (error: any) {
      console.error('Error loading category field settings:', error)
      setCategoryFieldSettings({})
    }
  }

  function getDefaultLineCountForCategory(category: string) {
    if (!category) return 3
    const settings = categoryFieldSettings[category]
    if (!settings) return 3
    const count = [settings.line_1, settings.line_2, settings.line_3].filter((v) => v).length
    return Math.min(3, Math.max(1, count || 1))
  }

  function normalizeLineCount(value: number | null | undefined) {
    if (value == null) return null
    const n = Math.round(Number(value))
    if (!Number.isFinite(n)) return null
    return Math.min(3, Math.max(1, n))
  }

  async function loadPatterns() {
    setLoading(true)
    try {
      let query = supabase
        .from('cp_cartoon_patterns')
        .select('*')
        .eq('is_active', true)
        .order('pattern_name', { ascending: true })

      if (appliedSearch) {
        query = query.ilike('pattern_name', `%${appliedSearch}%`)
      }

      const { data, error } = await query

      if (error) throw error
      setPatterns(data || [])
    } catch (error: any) {
      console.error('Error loading patterns:', error)
      alert('เกิดข้อผิดพลาดในการโหลดข้อมูล: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  function openAdd() {
    setFormPatternName('')
    setFormPatternCategory('')
    setFormLineCount('')
    setEditingPattern(null)
    setUploadFile(null)
    setUploadPreview(null)
    setModalMode('add')
  }

  function openEdit(pattern: CartoonPattern) {
    setEditingPattern(pattern)
    setFormPatternName(pattern.pattern_name)
    setFormPatternCategory(pattern.product_category ?? '')
    setFormLineCount(pattern.line_count ?? '')
    setUploadFile(null)
    setUploadPreview(null)
    setModalMode('edit')
  }

  function closeModal() {
    if (uploadPreview) URL.revokeObjectURL(uploadPreview)
    setModalMode(null)
    setEditingPattern(null)
    setFormPatternName('')
    setFormPatternCategory('')
    setFormLineCount('')
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
    const name = formPatternName.trim()
    if (!name) {
      alert('กรุณากรอกชื่อลายการ์ตูน')
      return
    }

    setSaving(true)
    try {
      if (uploadFile) {
        await uploadPatternImage(uploadFile, name)
      }
      const nextCategory = formPatternCategory || null
      const baseLineCount =
        formLineCount === '' ? getDefaultLineCountForCategory(formPatternCategory) : Number(formLineCount)
      const nextLineCount = normalizeLineCount(baseLineCount)

      if (modalMode === 'add') {
        const { error } = await supabase.from('cp_cartoon_patterns').insert({
          pattern_name: name,
          product_category: nextCategory,
          line_count: nextLineCount,
          is_active: true,
        })
        if (error) throw error
        alert('เพิ่มลายการ์ตูนเรียบร้อย')
      } else if (modalMode === 'edit' && editingPattern) {
        const { error } = await supabase
          .from('cp_cartoon_patterns')
          .update({
            pattern_name: name,
            product_category: nextCategory,
            line_count: nextLineCount,
          })
          .eq('id', editingPattern.id)
        if (error) throw error
        alert('แก้ไขลายการ์ตูนเรียบร้อย')
      }
      closeModal()
      loadPatterns()
    } catch (error: any) {
      console.error('Error saving pattern:', error)
      alert('เกิดข้อผิดพลาด: ' + error.message)
    } finally {
      setSaving(false)
    }
  }

  function openDeleteConfirm(pattern: CartoonPattern) {
    setPatternToDelete(pattern)
  }

  async function confirmDelete() {
    if (!patternToDelete) return
    setDeletingId(patternToDelete.id)
    try {
      const { error } = await supabase
        .from('cp_cartoon_patterns')
        .update({ is_active: false })
        .eq('id', patternToDelete.id)
      if (error) throw error
      setPatternToDelete(null)
      loadPatterns()
    } catch (error: any) {
      console.error('Error deactivating pattern:', error)
      alert('เกิดข้อผิดพลาด: ' + error.message)
    } finally {
      setDeletingId(null)
    }
  }

  function downloadTemplate() {
    const ws = XLSX.utils.aoa_to_sheet([
      PATTERN_TEMPLATE_HEADERS as unknown as string[],
      ['ลายตัวอย่าง', 'ตัวอย่างหมวดหมู่', 3],
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'ลายการ์ตูน')
    XLSX.writeFile(wb, 'Template_ลายการ์ตูน.xlsx')
  }

  async function downloadPatternsExcel() {
    try {
      const { data, error } = await supabase
        .from('cp_cartoon_patterns')
        .select('pattern_name, product_category, line_count')
        .eq('is_active', true)
        .order('pattern_name', { ascending: true })
      if (error) throw error
      const headers = ['pattern_name', 'product_category', 'line_count']
      const rows = (data || []).map((p: any) => [p.pattern_name ?? '', p.product_category ?? '', p.line_count ?? ''])
      const wb = XLSX.utils.book_new()
      const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
      XLSX.utils.book_append_sheet(wb, ws, 'ลายการ์ตูน')
      XLSX.writeFile(wb, 'ข้อมูลลายการ์ตูนทั้งหมด.xlsx')
    } catch (e: any) {
      console.error(e)
      alert('ดาวน์โหลดไม่สำเร็จ: ' + (e?.message || e))
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

      const toInsert: Array<{ pattern_name: string; product_category?: string | null; line_count?: number | null; is_active: boolean }> = []
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        const name = String(row.pattern_name ?? '').trim()
        if (!name) continue
        const category = String(row.product_category ?? '').trim()
        const rawLineCount = row.line_count != null && row.line_count !== '' ? Number(row.line_count) : null
        const lineCount = normalizeLineCount(
          rawLineCount != null ? rawLineCount : category ? getDefaultLineCountForCategory(category) : null
        )
        toInsert.push({
          pattern_name: name,
          product_category: category || null,
          line_count: lineCount,
          is_active: true,
        })
      }
      if (!toInsert.length) throw new Error('ไม่มีแถวที่ valid (ต้องมี pattern_name)')

      const { error } = await supabase.from('cp_cartoon_patterns').insert(toInsert)
      if (error) throw error
      alert(`นำเข้าลายการ์ตูน ${toInsert.length} รายการเรียบร้อย`)
      loadPatterns()
    } catch (err: any) {
      console.error('Import error:', err)
      alert('นำเข้าลายการ์ตูนล้มเหลว: ' + (err?.message || err))
    } finally {
      setImporting(false)
      importInputRef.current && (importInputRef.current.value = '')
    }
  }

  async function updatePatternInline(patternId: string, changes: Partial<CartoonPattern>) {
    try {
      const payload: Record<string, any> = { updated_at: new Date().toISOString() }
      if (Object.prototype.hasOwnProperty.call(changes, 'product_category')) {
        payload.product_category = changes.product_category ?? null
      }
      if (Object.prototype.hasOwnProperty.call(changes, 'line_count')) {
        payload.line_count = normalizeLineCount(changes.line_count ?? null)
      }
      const { error } = await supabase
        .from('cp_cartoon_patterns')
        .update(payload)
        .eq('id', patternId)
      if (error) throw error
      setPatterns((prev) =>
        prev.map((p) => (p.id === patternId ? { ...p, ...changes } : p))
      )
    } catch (error: any) {
      console.error('Error updating pattern:', error)
      alert('เกิดข้อผิดพลาด: ' + (error?.message || error))
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
      if (ok) alert(`อัปโหลดรูปสำเร็จ ${ok} ไฟล์${fail ? ` ล้มเหลว ${fail} ไฟล์` : ''}`)
      if (fail && !ok) alert('อัปโหลดรูปล้มเหลว: ' + (fail === 1 ? imageFiles[0].name : `${fail} ไฟล์`))
    } finally {
      setUploadingImages(false)
      uploadImagesInputRef.current && (uploadImagesInputRef.current.value = '')
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-end gap-2 mt-2">
          <button
            type="button"
            onClick={downloadPatternsExcel}
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
            {importing ? 'กำลังนำเข้า...' : 'Import ลายการ์ตูน'}
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
            + เพิ่มลายการ์ตูน
          </button>
      </div>

      <div className="bg-white p-6 rounded-lg shadow">
        <div className="mb-4">
          <label htmlFor="patterns-search" className="sr-only">ค้นหาลายการ์ตูน</label>
          <input
            id="patterns-search"
            type="text"
            autoComplete="off"
            tabIndex={0}
            placeholder="ค้นหาชื่อลายการ์ตูน..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          />
        </div>

        {loading ? (
          <div className="flex justify-center items-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
          </div>
        ) : patterns.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            ไม่พบข้อมูลลายการ์ตูน
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-blue-600 text-white">
                  <th className="p-3 text-left font-semibold rounded-tl-xl">รูป</th>
                  <th className="p-3 text-left font-semibold">ชื่อลายการ์ตูน</th>
                  <th className="p-3 text-left font-semibold">หมวดหมู่สินค้า</th>
                  <th className="p-3 text-left font-semibold">จำนวนบรรทัด</th>
                  <th className="p-3 text-right font-semibold rounded-tr-xl">การจัดการ</th>
                </tr>
              </thead>
              <tbody>
                {patterns.map((pattern, idx) => (
                  <tr key={pattern.id} className={`border-t border-surface-200 hover:bg-blue-50 transition-colors ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                    <td className="p-3">
                      <PatternImage patternName={pattern.pattern_name} name={pattern.pattern_name} />
                    </td>
                    <td className="p-3 font-medium">{pattern.pattern_name}</td>
                    <td className="p-3">
                      <input
                        type="text"
                        list="cartoon-category-options"
                        value={categoryDrafts[pattern.id] ?? pattern.product_category ?? ''}
                        onChange={(e) => {
                          const next = e.target.value
                          setCategoryDrafts((prev) => ({ ...prev, [pattern.id]: next }))
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.currentTarget.blur()
                          }
                          if (e.key === 'Escape') {
                            setCategoryDrafts((prev) => {
                              const next = { ...prev }
                              delete next[pattern.id]
                              return next
                            })
                            e.currentTarget.blur()
                          }
                        }}
                        onBlur={(e) => {
                          const nextCategory = e.target.value.trim()
                          const current = pattern.product_category ?? ''
                          if (nextCategory === current) {
                            setCategoryDrafts((prev) => {
                              const next = { ...prev }
                              delete next[pattern.id]
                              return next
                            })
                            return
                          }
                          const nextLineCount = getDefaultLineCountForCategory(nextCategory)
                          updatePatternInline(pattern.id, {
                            product_category: nextCategory || null,
                            line_count: nextLineCount,
                          })
                          setCategoryDrafts((prev) => {
                            const next = { ...prev }
                            delete next[pattern.id]
                            return next
                          })
                        }}
                        className="w-full px-2 py-1 border rounded text-sm"
                        placeholder="-- เลือกหมวดหมู่ --"
                      />
                    </td>
                    <td className="p-3">
                      <select
                        value={
                          normalizeLineCount(pattern.line_count ?? null) ??
                          getDefaultLineCountForCategory(pattern.product_category ?? '')
                        }
                        onChange={(e) => {
                          const next = normalizeLineCount(Number(e.target.value)) || 1
                          updatePatternInline(pattern.id, { line_count: next })
                        }}
                        className="w-20 px-2 py-1 border rounded text-sm"
                      >
                        {[1, 2, 3].map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="p-3 text-right">
                      <div className="flex gap-2 justify-end">
                        <button
                          type="button"
                          onClick={() => openEdit(pattern)}
                          className="px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-semibold"
                        >
                          แก้ไข
                        </button>
                        <button
                          type="button"
                          onClick={() => openDeleteConfirm(pattern)}
                          disabled={deletingId === pattern.id}
                          className="px-3 py-1.5 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm font-semibold disabled:opacity-50"
                        >
                          {deletingId === pattern.id ? 'กำลังลบ...' : 'ลบ'}
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

      <datalist id="cartoon-category-options">
        {productCategories.map((cat) => (
          <option key={cat} value={cat} />
        ))}
      </datalist>

      <Modal
        open={modalMode !== null}
        onClose={closeModal}
        closeOnBackdropClick={false}
        contentClassName="max-w-lg"
      >
        <div className="p-6">
          <h2 className="text-xl font-bold mb-4">
            {modalMode === 'add' ? 'เพิ่มลายการ์ตูน' : 'แก้ไขลายการ์ตูน'}
          </h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">ชื่อลายการ์ตูน *</label>
              <input
                type="text"
                value={formPatternName}
                onChange={(e) => setFormPatternName(e.target.value)}
                placeholder="ชื่อลายการ์ตูน"
                className="w-full px-3 py-2 border rounded-lg"
                readOnly={modalMode === 'edit'}
              />
              {modalMode === 'edit' && (
                <p className="text-xs text-gray-500 mt-1">ไม่สามารถแก้ไขชื่อลายการ์ตูนได้ (ใช้เป็นชื่อไฟล์รูป)</p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">หมวดหมู่สินค้า</label>
              <select
                value={formPatternCategory}
                onChange={(e) => {
                  const nextCategory = e.target.value
                  setFormPatternCategory(nextCategory)
                  const nextLineCount = getDefaultLineCountForCategory(nextCategory)
                  setFormLineCount(nextLineCount)
                }}
                className="w-full px-3 py-2 border rounded-lg"
              >
                <option value="">-- เลือกหมวดหมู่ --</option>
                {productCategories.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">จำนวนบรรทัด</label>
              <select
                value={formLineCount === '' ? '' : Number(formLineCount)}
                onChange={(e) => setFormLineCount(Number(e.target.value))}
                className="w-full px-3 py-2 border rounded-lg"
              >
                <option value="">-- เลือกจำนวนบรรทัด --</option>
                {[1, 2, 3].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">รูปลายการ์ตูน</label>
              <p className="text-xs text-gray-500 mb-1">
                อัปโหลดรูปจะเก็บใน Bucket {BUCKET_CARTOON_PATTERNS} ชื่อไฟล์ = ชื่อลายการ์ตูน
                {modalMode === 'edit' && ' — อัปโหลดรูปใหม่จะแทนที่รูปเก่า'}
              </p>
              <input
                type="file"
                accept="image/*"
                onChange={onFileChange}
                className="w-full text-sm text-gray-600 file:mr-2 file:py-2 file:px-3 file:rounded file:border-0 file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
              />
              {(uploadPreview || (formPatternName.trim() && !uploadFile)) && (
                <div className="mt-2">
                  <span className="text-xs text-gray-500 block mb-1">พรีวิว</span>
                  {uploadPreview ? (
                    <img
                      src={uploadPreview}
                      alt="พรีวิว"
                      className="w-24 h-24 object-cover rounded border"
                    />
                  ) : (
                    <PatternImage patternName={formPatternName.trim()} name={formPatternName} />
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
              {saving ? 'กำลังบันทึก...' : modalMode === 'add' ? 'เพิ่มลายการ์ตูน' : 'บันทึก'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={patternToDelete !== null}
        onClose={() => setPatternToDelete(null)}
        closeOnBackdropClick={true}
        contentClassName="max-w-md"
      >
        <div className="p-6">
          <h2 className="text-xl font-bold mb-3 text-gray-800">ยืนยันปิดการใช้งานลายการ์ตูน</h2>
          {patternToDelete && (
            <p className="text-gray-600 mb-4">
              ต้องการปิดการใช้งานลายการ์ตูน <strong>"{patternToDelete.pattern_name}"</strong> ใช่หรือไม่?
              <br />
              <span className="text-sm text-gray-500">จะไม่แสดงในรายการแต่ยังอยู่ในระบบ</span>
            </p>
          )}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => setPatternToDelete(null)}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              ยกเลิก
            </button>
            <button
              type="button"
              onClick={confirmDelete}
              disabled={deletingId === patternToDelete?.id}
              className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-50"
            >
              {deletingId === patternToDelete?.id ? 'กำลังลบ...' : 'ปิดการใช้งาน'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

function PatternImage({ patternName, name }: { patternName: string; name: string }) {
  const url = getPatternImageUrl(patternName)
  if (!url) {
    return (
      <div className="w-16 h-16 bg-gray-200 rounded flex items-center justify-center text-gray-400 text-xs">
        ไม่มีรูป
      </div>
    )
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="block w-16 h-16 rounded overflow-hidden hover:ring-2 hover:ring-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
      title="คลิกเพื่อเปิดรูปในแท็บใหม่"
    >
      <img
        src={url}
        alt={name}
        className="w-16 h-16 object-cover"
        loading="lazy"
        decoding="async"
        onError={(e) => {
          const target = e.target as HTMLImageElement
          target.onerror = null
          target.src = 'https://placehold.co/64x64?text=NO+IMG'
        }}
      />
    </a>
  )
}
