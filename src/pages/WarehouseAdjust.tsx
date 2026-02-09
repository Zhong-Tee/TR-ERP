import { useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import Modal from '../components/ui/Modal'
import { useAuthContext } from '../contexts/AuthContext'
import { InventoryAdjustment, InventoryAdjustmentItem, Product } from '../types'
import { adjustStockBalancesBulk } from '../lib/inventory'

interface DraftItem {
  product_id: string
  qty: number
}

const TEMPLATE_HEADERS = ['product_code', 'qty'] as const

function generateCode(prefix: string) {
  const date = new Date()
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const rand = Math.floor(Math.random() * 9000) + 1000
  return `${prefix}-${y}${m}${d}-${rand}`
}

export default function WarehouseAdjust() {
  const { user } = useAuthContext()
  const [adjustments, setAdjustments] = useState<InventoryAdjustment[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draftItems, setDraftItems] = useState<DraftItem[]>([{ product_id: '', qty: 1 }])
  const [note, setNote] = useState('')
  const [viewing, setViewing] = useState<InventoryAdjustment | null>(null)
  const [viewItems, setViewItems] = useState<InventoryAdjustmentItem[]>([])
  const [updating, setUpdating] = useState<string | null>(null)
  const importInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    loadAll()
  }, [])

  async function loadAll() {
    setLoading(true)
    try {
      const [adjustRes, productRes] = await Promise.all([
        supabase.from('inv_adjustments').select('*').order('created_at', { ascending: false }),
        supabase.from('pr_products').select('id, product_code, product_name').eq('is_active', true),
      ])
      if (adjustRes.error) throw adjustRes.error
      if (productRes.error) throw productRes.error
      setAdjustments((adjustRes.data || []) as InventoryAdjustment[])
      setProducts((productRes.data || []) as Product[])
    } catch (e) {
      console.error('Load adjustments failed:', e)
    } finally {
      setLoading(false)
    }
  }

  const productOptions = useMemo(
    () =>
      products.map((p) => ({
        value: p.id,
        label: `${p.product_code} - ${p.product_name}`,
      })),
    [products]
  )

  const productCodeMap = useMemo(() => {
    const map: Record<string, Product> = {}
    products.forEach((p) => {
      map[p.product_code] = p
    })
    return map
  }, [products])

  function addDraftItem() {
    setDraftItems((prev) => [...prev, { product_id: '', qty: 1 }])
  }

  function updateDraftItem(index: number, patch: Partial<DraftItem>) {
    setDraftItems((prev) =>
      prev.map((item, idx) => (idx === index ? { ...item, ...patch } : item))
    )
  }

  function removeDraftItem(index: number) {
    setDraftItems((prev) => prev.filter((_, idx) => idx !== index))
  }

  function downloadTemplate() {
    const ws = XLSX.utils.aoa_to_sheet([
      TEMPLATE_HEADERS as unknown as string[],
      ['P001', 10],
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'ปรับสต๊อค')
    XLSX.writeFile(wb, 'Template_ปรับสต๊อค.xlsx')
  }

  async function handleImport(file: File) {
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(new Uint8Array(buf), { type: 'array' })
      const firstSheet = wb.SheetNames[0]
      if (!firstSheet) throw new Error('ไม่มีชีตในไฟล์')
      const sheet = wb.Sheets[firstSheet]
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })
      if (!rows.length) throw new Error('ไม่มีข้อมูลในไฟล์')

      const nextItems: DraftItem[] = []
      rows.forEach((row) => {
        const code = String(row.product_code ?? '').trim()
        const qty = Number(row.qty ?? 0)
        const product = productCodeMap[code]
        if (!product || qty <= 0) return
        nextItems.push({ product_id: product.id, qty })
      })
      if (!nextItems.length) throw new Error('ไม่มีแถวที่ valid (ต้องมี product_code และ qty > 0)')
      setDraftItems(nextItems)
      setCreateOpen(true)
    } catch (e: any) {
      console.error('Import error:', e)
      alert('นำเข้าไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      importInputRef.current && (importInputRef.current.value = '')
    }
  }

  async function createAdjustment() {
    const validItems = draftItems.filter((i) => i.product_id && i.qty > 0)
    if (!validItems.length) {
      alert('กรุณาเพิ่มรายการสินค้าอย่างน้อย 1 รายการ')
      return
    }
    setSaving(true)
    try {
      const adjustNo = generateCode('ADJ')
      const { data: adjustData, error: adjustError } = await supabase
        .from('inv_adjustments')
        .insert({
          adjust_no: adjustNo,
          status: 'pending',
          created_by: user?.id || null,
          note: note.trim() || null,
        })
        .select('*')
        .single()
      if (adjustError) throw adjustError

      const itemsPayload = validItems.map((item) => ({
        adjustment_id: adjustData.id,
        product_id: item.product_id,
        qty_delta: -Math.abs(item.qty),
      }))
      const { error: itemError } = await supabase.from('inv_adjustment_items').insert(itemsPayload)
      if (itemError) throw itemError

      setDraftItems([{ product_id: '', qty: 1 }])
      setNote('')
      setCreateOpen(false)
      await loadAll()
      alert('สร้างใบปรับสต๊อคเรียบร้อย')
    } catch (e: any) {
      console.error('Create adjustment failed:', e)
      alert('สร้างใบปรับสต๊อคไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setSaving(false)
    }
  }

  async function approveAdjustment(adjustment: InventoryAdjustment) {
    setUpdating(adjustment.id)
    try {
      const { data: items, error: itemsError } = await supabase
        .from('inv_adjustment_items')
        .select('product_id, qty_delta')
        .eq('adjustment_id', adjustment.id)
      if (itemsError) throw itemsError

      const { error } = await supabase
        .from('inv_adjustments')
        .update({
          status: 'approved',
          approved_by: user?.id || null,
          approved_at: new Date().toISOString(),
        })
        .eq('id', adjustment.id)
      if (error) throw error

      await adjustStockBalancesBulk(
        (items || []).map((item) => ({
          productId: item.product_id,
          qtyDelta: Number(item.qty_delta),
          movementType: 'adjust',
          refType: 'inv_adjustments',
          refId: adjustment.id,
          note: `ปรับสต๊อค ${adjustment.adjust_no}`,
        }))
      )

      await loadAll()
      alert('อนุมัติการปรับสต๊อคเรียบร้อย')
    } catch (e: any) {
      console.error('Approve adjustment failed:', e)
      alert('อนุมัติไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setUpdating(null)
    }
  }

  async function openView(adjustment: InventoryAdjustment) {
    setViewing(adjustment)
    const { data, error } = await supabase
      .from('inv_adjustment_items')
      .select('id, adjustment_id, product_id, qty_delta, pr_products(product_code, product_name)')
      .eq('adjustment_id', adjustment.id)
    if (!error) {
      setViewItems((data || []) as unknown as InventoryAdjustmentItem[])
    }
  }

  return (
    <div className="space-y-6 mt-12">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={downloadTemplate}
          className="px-4 py-2 bg-gray-600 text-white rounded-xl hover:bg-gray-700 font-semibold text-sm"
        >
          ดาวน์โหลดฟอร์ม
        </button>
        <label className="px-4 py-2 bg-green-600 text-white rounded-xl hover:bg-green-700 font-semibold text-sm cursor-pointer inline-block">
          Import Excel
          <input
            ref={importInputRef}
            type="file"
            accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) handleImport(file)
            }}
          />
        </label>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="px-4 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-semibold"
        >
          + สร้างใบปรับสต๊อค
        </button>
      </div>

      <div className="bg-white p-6 rounded-lg shadow">
        {loading ? (
          <div className="flex justify-center items-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
          </div>
        ) : adjustments.length === 0 ? (
          <div className="text-center py-12 text-gray-500">ยังไม่มีการปรับสต๊อค</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-blue-600 text-white">
                  <th className="p-3 text-left font-semibold rounded-tl-xl">เลขที่ปรับสต๊อค</th>
                  <th className="p-3 text-left font-semibold">สถานะ</th>
                  <th className="p-3 text-left font-semibold">วันที่สร้าง</th>
                  <th className="p-3 text-right font-semibold rounded-tr-xl">การจัดการ</th>
                </tr>
              </thead>
              <tbody>
                {adjustments.map((adjustment, idx) => (
                  <tr key={adjustment.id} className={`border-b border-gray-200 hover:bg-blue-50 transition-colors ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                    <td className="p-3 font-medium">{adjustment.adjust_no}</td>
                    <td className="p-3">
                      <span className={`inline-flex px-3 py-1 rounded-full text-xs font-bold ${
                        adjustment.status === 'approved' ? 'bg-green-500 text-white' : 'bg-amber-500 text-white'
                      }`}>
                        {adjustment.status}
                      </span>
                    </td>
                    <td className="p-3">{new Date(adjustment.created_at).toLocaleString()}</td>
                    <td className="p-3 text-right">
                      <div className="flex gap-2 justify-end">
                        <button
                          type="button"
                          onClick={() => openView(adjustment)}
                          className="px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-semibold"
                        >
                          ดูรายละเอียด
                        </button>
                        {adjustment.status === 'pending' && (
                          <button
                            type="button"
                            onClick={() => approveAdjustment(adjustment)}
                            disabled={updating === adjustment.id}
                            className="px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-semibold disabled:opacity-50"
                          >
                            อนุมัติ
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} contentClassName="max-w-3xl">
        <div className="p-6 space-y-4">
          <h2 className="text-xl font-bold">สร้างใบปรับสต๊อค</h2>
          <div className="space-y-3">
            {draftItems.map((item, index) => (
              <div key={`draft-${index}`} className="grid grid-cols-12 gap-3 items-center">
                <div className="col-span-7">
                  <select
                    value={item.product_id}
                    onChange={(e) => updateDraftItem(index, { product_id: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg bg-white"
                  >
                    <option value="">เลือกสินค้า</option>
                    {productOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                <div className="col-span-3">
                  <input
                    type="number"
                    min={1}
                    value={item.qty}
                    onChange={(e) => updateDraftItem(index, { qty: Number(e.target.value) || 1 })}
                    className="w-full px-3 py-2 border rounded-lg"
                  />
                </div>
                <div className="col-span-2">
                  <button
                    type="button"
                    onClick={() => removeDraftItem(index)}
                    disabled={draftItems.length === 1}
                    className="px-3 py-2 bg-red-100 text-red-600 rounded hover:bg-red-200 disabled:opacity-50 w-full"
                  >
                    ลบ
                  </button>
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={addDraftItem}
              className="px-3 py-2 border rounded hover:bg-gray-50"
            >
              + เพิ่มรายการ
            </button>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">หมายเหตุ</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg"
              rows={2}
            />
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setCreateOpen(false)}
              className="px-4 py-2 border rounded-lg hover:bg-gray-50"
            >
              ยกเลิก
            </button>
            <button
              type="button"
              onClick={createAdjustment}
              disabled={saving}
              className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50"
            >
              {saving ? 'กำลังบันทึก...' : 'บันทึกการปรับสต๊อค'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={!!viewing} onClose={() => setViewing(null)} contentClassName="max-w-2xl">
        <div className="p-6 space-y-4">
          <h2 className="text-xl font-bold">รายละเอียดการปรับสต๊อค</h2>
          {viewing && (
            <div className="text-sm text-gray-600">
              เลขที่: <span className="font-medium text-gray-900">{viewing.adjust_no}</span>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-100">
                <tr>
                  <th className="p-2 text-left">สินค้า</th>
                  <th className="p-2 text-right">จำนวนที่ปรับ</th>
                </tr>
              </thead>
              <tbody>
                {viewItems.map((item: any) => (
                  <tr key={item.id} className="border-t">
                    <td className="p-2">
                      {item.pr_products?.product_code} - {item.pr_products?.product_name}
                    </td>
                    <td className="p-2 text-right">{Math.abs(Number(item.qty_delta)).toLocaleString()}</td>
                  </tr>
                ))}
                {!viewItems.length && (
                  <tr>
                    <td className="p-2 text-center text-gray-500" colSpan={2}>
                      ไม่มีรายการ
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setViewing(null)}
              className="px-4 py-2 border rounded-lg hover:bg-gray-50"
            >
              ปิด
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
