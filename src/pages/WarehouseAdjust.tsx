import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import Modal from '../components/ui/Modal'
import { useAuthContext } from '../contexts/AuthContext'
import { InventoryAdjustment, InventoryAdjustmentItem, Product } from '../types'
import { adjustStockBalancesBulkRPC, bulkUpdateSafetyStock, bulkUpdateOrderPoint } from '../lib/inventory'

interface DraftItem {
  product_id: string
  qty: number
  safety_stock: number | null
  order_point: number | null
}

interface StockBalance {
  product_id: string
  on_hand: number
  safety_stock: number | null
}

const TEMPLATE_HEADERS = ['product_code', 'qty', 'safety_stock', 'order_point'] as const

async function generateCode(prefix: string) {
  const date = new Date()
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const dayPrefix = `${prefix}-${y}${m}${d}-`

  const { data } = await supabase
    .from('inv_adjustments')
    .select('adjust_no')
    .like('adjust_no', `${dayPrefix}%`)

  let maxNum = 0
  if (data) {
    for (const row of data) {
      const suffix = row.adjust_no.replace(dayPrefix, '')
      if (/^\d{3}$/.test(suffix)) {
        const num = parseInt(suffix, 10)
        if (num > maxNum) maxNum = num
      }
    }
  }

  return `${dayPrefix}${String(maxNum + 1).padStart(3, '0')}`
}

export default function WarehouseAdjust() {
  const { user } = useAuthContext()
  const [adjustments, setAdjustments] = useState<InventoryAdjustment[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [balances, setBalances] = useState<Record<string, StockBalance>>({})
  const [userMap, setUserMap] = useState<Record<string, string>>({})
  const [itemCountMap, setItemCountMap] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draftItems, setDraftItems] = useState<DraftItem[]>([{ product_id: '', qty: 0, safety_stock: null, order_point: null }])
  const [note, setNote] = useState('')
  const [viewing, setViewing] = useState<InventoryAdjustment | null>(null)
  const [viewItems, setViewItems] = useState<InventoryAdjustmentItem[]>([])
  const [updating, setUpdating] = useState<string | null>(null)
  const importInputRef = useRef<HTMLInputElement>(null)

  // Notification modal state
  const [notifyModal, setNotifyModal] = useState<{ open: boolean; type: 'success' | 'error' | 'warning'; title: string; message: string }>({
    open: false, type: 'success', title: '', message: '',
  })

  function showNotify(type: 'success' | 'error' | 'warning', title: string, message: string = '') {
    setNotifyModal({ open: true, type, title, message })
  }

  useEffect(() => {
    loadAll()
  }, [])

  async function loadAll() {
    setLoading(true)
    try {
      const [adjustRes, productRes, balanceRes, usersRes, itemCountRes] = await Promise.all([
        supabase.from('inv_adjustments').select('*').order('created_at', { ascending: false }),
        supabase.from('pr_products').select('id, product_code, product_name, order_point').eq('is_active', true).order('product_code', { ascending: true }),
        supabase.from('inv_stock_balances').select('product_id, on_hand, safety_stock'),
        supabase.from('us_users').select('id, username'),
        supabase.from('inv_adjustment_items').select('adjustment_id'),
      ])
      if (adjustRes.error) throw adjustRes.error
      if (productRes.error) throw productRes.error
      setAdjustments((adjustRes.data || []) as InventoryAdjustment[])
      setProducts((productRes.data || []) as Product[])

      // stock balances map
      const bMap: Record<string, StockBalance> = {}
      ;(balanceRes.data || []).forEach((row: any) => {
        bMap[row.product_id] = { product_id: row.product_id, on_hand: Number(row.on_hand || 0), safety_stock: row.safety_stock != null ? Number(row.safety_stock) : null }
      })
      setBalances(bMap)

      // users map
      const uMap: Record<string, string> = {}
      ;(usersRes.data || []).forEach((u: any) => { uMap[u.id] = u.username || u.id })
      setUserMap(uMap)

      // item count per adjustment
      const cMap: Record<string, number> = {}
      ;(itemCountRes.data || []).forEach((row: any) => {
        cMap[row.adjustment_id] = (cMap[row.adjustment_id] || 0) + 1
      })
      setItemCountMap(cMap)
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

  const productIdMap = useMemo(() => {
    const map: Record<string, Product> = {}
    products.forEach((p) => { map[p.id] = p })
    return map
  }, [products])

  function addDraftItem() {
    setDraftItems((prev) => [...prev, { product_id: '', qty: 0, safety_stock: null, order_point: null }])
  }

  const updateDraftItem = useCallback((index: number, patch: Partial<DraftItem>) => {
    setDraftItems((prev) =>
      prev.map((item, idx) => (idx === index ? { ...item, ...patch } : item))
    )
  }, [])

  const removeDraftItem = useCallback((index: number) => {
    setDraftItems((prev) => prev.filter((_, idx) => idx !== index))
  }, [])

  function downloadTemplate() {
    const ws = XLSX.utils.aoa_to_sheet([
      TEMPLATE_HEADERS as unknown as string[],
      ['P001', 50, 10, 'จุดA'],
      ['P002', 100, 20, 'จุดB'],
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'ปรับสต๊อค')
    XLSX.writeFile(wb, 'Template_ปรับสต๊อค.xlsx')
  }

  function downloadCurrentProducts() {
    const headers = ['product_code', 'product_name', 'on_hand', 'safety_stock', 'order_point']
    const rows = products.map((p) => {
      const b = balances[p.id]
      const op = p.order_point != null ? Number(p.order_point) : 0
      return [
        p.product_code,
        p.product_name,
        b ? b.on_hand : 0,
        b?.safety_stock ?? 0,
        Number.isFinite(op) ? op : 0,
      ]
    })
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
    ws['!cols'] = [
      { wch: 15 }, // product_code
      { wch: 30 }, // product_name
      { wch: 12 }, // on_hand
      { wch: 14 }, // safety_stock
      { wch: 14 }, // order_point
    ]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'สินค้าปัจจุบัน')
    XLSX.writeFile(wb, `สินค้าปัจจุบัน_${new Date().toISOString().slice(0, 10)}.xlsx`)
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

      // รองรับทั้งรูปแบบ template (product_code, qty, safety_stock) และไฟล์ดาวน์โหลดสินค้าปัจจุบัน (product_code, on_hand, safety_stock)
      const firstRow = rows[0]
      const hasQty = 'qty' in firstRow
      const hasOnHand = 'on_hand' in firstRow

      if (!hasQty && !hasOnHand) {
        throw new Error('ไม่พบคอลัมน์ qty หรือ on_hand ในไฟล์ — กรุณาใช้ไฟล์ Template หรือไฟล์ดาวน์โหลดสินค้าปัจจุบัน')
      }

      const qtyKey = hasQty ? 'qty' : 'on_hand'

      const nextItems: DraftItem[] = []
      rows.forEach((row) => {
        const code = String(row.product_code ?? '').trim()
        const qty = Number(row[qtyKey] ?? 0)
        const product = productCodeMap[code]
        if (!product) return
        const ss = row.safety_stock != null && String(row.safety_stock).trim() !== '' ? Number(row.safety_stock) : null
        const opRaw = row.order_point != null && String(row.order_point).trim() !== '' ? Number(row.order_point) : null
        const op = opRaw != null && Number.isFinite(opRaw) ? opRaw : (product.order_point != null ? Number(product.order_point) || null : null)
        nextItems.push({ product_id: product.id, qty, safety_stock: ss, order_point: op })
      })
      if (!nextItems.length) throw new Error('ไม่มีแถวที่ valid (ต้องมี product_code)')
      setDraftItems(nextItems)
      setCreateOpen(true)
    } catch (e: any) {
      console.error('Import error:', e)
      showNotify('error', 'นำเข้าไม่สำเร็จ', e?.message || String(e))
    } finally {
      importInputRef.current && (importInputRef.current.value = '')
    }
  }

  async function createAdjustment() {
    if (!note.trim()) {
      showNotify('warning', 'กรุณากรอกหัวข้อการปรับ')
      return
    }
    // กรองรายการที่มีสินค้า และมีการเปลี่ยนแปลง (สต๊อค, safety stock, หรือ order_point)
    const validItems = draftItems.filter((i) => {
      if (!i.product_id) return false
      const currentOnHand = balances[i.product_id]?.on_hand ?? 0
      const currentSafety = balances[i.product_id]?.safety_stock
      const currentOrderPoint = productIdMap[i.product_id]?.order_point != null ? Number(productIdMap[i.product_id].order_point) : null
      const qtyChanged = i.qty !== currentOnHand
      const safetyChanged = i.safety_stock !== null && i.safety_stock !== (currentSafety ?? 0)
      const orderPointChanged = i.order_point !== null && i.order_point !== (currentOrderPoint ?? 0)
      return qtyChanged || safetyChanged || orderPointChanged
    })
    if (!validItems.length) {
      showNotify('warning', 'กรุณาเพิ่มรายการสินค้าอย่างน้อย 1 รายการที่มีค่าเปลี่ยนแปลง')
      return
    }
    setSaving(true)
    try {
      const adjustNo = await generateCode('ADJ')
      const { data: adjustData, error: adjustError } = await supabase
        .from('inv_adjustments')
        .insert({
          adjust_no: adjustNo,
          status: 'pending',
          created_by: user?.id || null,
          note: note.trim(),
        })
        .select('*')
        .single()
      if (adjustError) throw adjustError

      // เก็บ delta + safety_stock + order_point ไว้ใน items ทั้งหมด (รออนุมัติ)
      const itemsPayload = validItems.map((item) => {
        const currentOnHand = balances[item.product_id]?.on_hand ?? 0
        const delta = item.qty - currentOnHand
        return {
          adjustment_id: adjustData.id,
          product_id: item.product_id,
          qty_delta: delta,
          new_safety_stock: item.safety_stock,
          new_order_point: item.order_point != null ? String(item.order_point) : null,
        }
      })
      const { error: itemError } = await supabase.from('inv_adjustment_items').insert(itemsPayload)
      if (itemError) throw itemError

      // ไม่อัปเดตทันที — ทุกค่ารออนุมัติก่อน

      setDraftItems([{ product_id: '', qty: 0, safety_stock: null, order_point: null }])
      setNote('')
      setCreateOpen(false)
      await loadAll()
      showNotify('success', 'สร้างใบปรับสต๊อคเรียบร้อย', `${validItems.length} รายการ — รออนุมัติ`)
    } catch (e: any) {
      console.error('Create adjustment failed:', e)
      showNotify('error', 'สร้างใบปรับสต๊อคไม่สำเร็จ', e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  async function approveAdjustment(adjustment: InventoryAdjustment) {
    setUpdating(adjustment.id)
    try {
      const { data: items, error: itemsError } = await supabase
        .from('inv_adjustment_items')
        .select('product_id, qty_delta, new_safety_stock, new_order_point')
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

      // อัปเดต on_hand + movement ทั้ง batch ผ่าน RPC ครั้งเดียว (แทน N×3 queries)
      const qtyItems = (items || []).filter((i) => Number(i.qty_delta) !== 0)
      if (qtyItems.length) {
        await adjustStockBalancesBulkRPC(
          qtyItems.map((item) => ({
            productId: item.product_id,
            qtyDelta: Number(item.qty_delta),
            movementType: 'adjust',
            refType: 'inv_adjustments',
            refId: adjustment.id,
            note: `ปรับสต๊อค ${adjustment.adjust_no}`,
          }))
        )
      }

      // ตรวจสอบก่อนว่า on_hand เพียงพอสำหรับย้ายเข้า safety stock
      const safetyItems = (items || []).filter((i) => i.new_safety_stock != null)
      for (const si of safetyItems) {
        const curBal = balances[si.product_id]
        const onHandAfterAdjust = (curBal?.on_hand ?? 0) + Number(qtyItems.find((q) => q.product_id === si.product_id)?.qty_delta ?? 0)
        const curSafety = curBal?.safety_stock ?? 0
        const newSafety = Number(si.new_safety_stock)
        const delta = newSafety - curSafety
        if (delta > 0 && delta > onHandAfterAdjust) {
          showNotify('error', 'on_hand ไม่เพียงพอ', `สินค้า ${productIdMap[si.product_id]?.product_code || si.product_id} — ต้องการย้าย ${delta} แต่ on_hand หลังปรับมีเพียง ${onHandAfterAdjust}`)
          setUpdating(null)
          return
        }
      }

      if (safetyItems.length) {
        await bulkUpdateSafetyStock(
          safetyItems.map((item) => ({
            productId: item.product_id,
            safetyStock: Number(item.new_safety_stock),
          }))
        )
      }

      // อัปเดต order_point ทั้ง batch ผ่าน RPC ครั้งเดียว (แทน N queries)
      const orderPointItems = (items || []).filter((i) => i.new_order_point != null)
      if (orderPointItems.length) {
        await bulkUpdateOrderPoint(
          orderPointItems.map((item) => ({
            productId: item.product_id,
            orderPoint: String(item.new_order_point),
          }))
        )
      }

      await loadAll()
      // แจ้ง Sidebar ให้อัปเดตจำนวนสินค้าต่ำกว่าจุดสั่งซื้อ
      window.dispatchEvent(new Event('sidebar-refresh-counts'))
      showNotify('success', 'อนุมัติการปรับสต๊อคเรียบร้อย')
    } catch (e: any) {
      console.error('Approve adjustment failed:', e)
      showNotify('error', 'อนุมัติไม่สำเร็จ', e?.message || String(e))
    } finally {
      setUpdating(null)
    }
  }

  async function openView(adjustment: InventoryAdjustment) {
    setViewing(adjustment)
    const { data, error } = await supabase
      .from('inv_adjustment_items')
      .select('id, adjustment_id, product_id, qty_delta, new_safety_stock, new_order_point, pr_products(product_code, product_name)')
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
        <button
          type="button"
          onClick={downloadCurrentProducts}
          className="px-4 py-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 font-semibold text-sm"
        >
          ดาวน์โหลดสินค้าปัจจุบัน
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
                  <th className="p-3 text-left font-semibold">หัวข้อการปรับ</th>
                  <th className="p-3 text-left font-semibold">สถานะ</th>
                  <th className="p-3 text-left font-semibold">วันที่สร้าง</th>
                  <th className="p-3 text-left font-semibold">ผู้สร้าง</th>
                  <th className="p-3 text-left font-semibold">ผู้อนุมัติ</th>
                  <th className="p-3 text-center font-semibold">จำนวนรายการ</th>
                  <th className="p-3 text-right font-semibold rounded-tr-xl">การจัดการ</th>
                </tr>
              </thead>
              <tbody>
                {adjustments.map((adjustment, idx) => (
                  <tr key={adjustment.id} className={`border-b border-gray-200 hover:bg-blue-50 transition-colors ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                    <td className="p-3 font-medium">{adjustment.adjust_no}</td>
                    <td className="p-3 text-sm text-gray-700">{adjustment.note || '-'}</td>
                    <td className="p-3">
                      <span className={`inline-flex px-3 py-1 rounded-full text-xs font-bold ${
                        adjustment.status === 'approved' ? 'bg-green-500 text-white' : 'bg-amber-500 text-white'
                      }`}>
                        {adjustment.status}
                      </span>
                    </td>
                    <td className="p-3">{new Date(adjustment.created_at).toLocaleString()}</td>
                    <td className="p-3 text-sm">{adjustment.created_by ? (userMap[adjustment.created_by] || '-') : '-'}</td>
                    <td className="p-3 text-sm">{adjustment.approved_by ? (userMap[adjustment.approved_by] || '-') : '-'}</td>
                    <td className="p-3 text-center">{itemCountMap[adjustment.id] || 0}</td>
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

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} contentClassName="max-w-5xl !overflow-hidden flex flex-col">
        {/* Sticky Header */}
        <div className="px-6 pt-6 pb-3 border-b border-surface-200 shrink-0">
          <h2 className="text-xl font-bold">สร้างใบปรับสต๊อค</h2>
          <p className="text-sm text-gray-500 mt-1">กรอกจำนวนสต๊อคที่ต้องการตั้งค่า (ระบบจะเปลี่ยนสต๊อคเป็นตัวเลขที่กรอก) — รายการทั้งหมด {draftItems.length} รายการ</p>
          {/* หัวข้อการปรับ (บังคับกรอก) */}
          <div className="mt-3">
            <div className="flex items-center gap-2">
              <label className="text-sm font-semibold text-gray-700 whitespace-nowrap">หัวข้อการปรับ <span className="text-red-500">*</span></label>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="เช่น ปรับสต๊อคตามนับจริง, ปรับจากรายงาน Audit"
                className={`flex-1 px-3 py-2 border rounded-lg text-sm ${!note.trim() ? 'border-red-300' : 'border-gray-300'}`}
              />
            </div>
          </div>
          {/* Column Headers */}
          <div className="grid grid-cols-12 gap-2 items-center text-sm font-semibold text-gray-600 mt-3">
            <div className="col-span-4">สินค้า</div>
            <div className="col-span-2 text-center">จุดสั่งซื้อ</div>
            <div className="col-span-2 text-center">Safety Stock</div>
            <div className="col-span-2 text-center">จำนวนสต๊อค</div>
            <div className="col-span-2 text-center">จัดการ</div>
          </div>
        </div>
        {/* Scrollable Body */}
        <div className="px-6 py-4 overflow-y-auto flex-1">
          <DraftItemsList
            items={draftItems}
            productOptions={productOptions}
            balances={balances}
            productIdMap={productIdMap}
            onUpdate={updateDraftItem}
            onRemove={removeDraftItem}
          />
        </div>
        {/* Sticky Footer */}
        <div className="px-6 py-4 border-t border-surface-200 shrink-0">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={addDraftItem}
              className="px-3 py-2 border rounded-lg hover:bg-gray-50 text-sm"
            >
              + เพิ่มรายการ
            </button>
            <div className="flex gap-2">
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
                disabled={saving || !note.trim()}
                className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50"
              >
                {saving ? 'กำลังบันทึก...' : 'บันทึกการปรับสต๊อค'}
              </button>
            </div>
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
                  <th className="p-2 text-right">จุดสั่งซื้อ</th>
                  <th className="p-2 text-right">Safety Stock</th>
                  <th className="p-2 text-right">จำนวนที่ปรับ</th>
                </tr>
              </thead>
              <tbody>
                {viewItems.map((item: any) => (
                  <tr key={item.id} className="border-t">
                    <td className="p-2">
                      {item.pr_products?.product_code} - {item.pr_products?.product_name}
                    </td>
                    <td className="p-2 text-right text-gray-600">
                      {item.new_order_point != null ? item.new_order_point : '-'}
                    </td>
                    <td className="p-2 text-right text-gray-600">
                      {item.new_safety_stock != null ? Number(item.new_safety_stock).toLocaleString() : '-'}
                    </td>
                    <td className={`p-2 text-right font-medium ${Number(item.qty_delta) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {Number(item.qty_delta) > 0 ? '+' : ''}{Number(item.qty_delta).toLocaleString()}
                    </td>
                  </tr>
                ))}
                {!viewItems.length && (
                  <tr>
                    <td className="p-2 text-center text-gray-500" colSpan={4}>
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

/** Memoized list เพื่อไม่ให้ re-render ทุก keystroke เมื่อพิมพ์ "หัวข้อการปรับ" */
const DraftItemsList = React.memo(function DraftItemsList({
  items,
  productOptions,
  balances,
  productIdMap,
  onUpdate,
  onRemove,
}: {
  items: DraftItem[]
  productOptions: { value: string; label: string }[]
  balances: Record<string, StockBalance>
  productIdMap: Record<string, Product>
  onUpdate: (index: number, patch: Partial<DraftItem>) => void
  onRemove: (index: number) => void
}) {
  return (
    <div className="space-y-3">
      {items.map((item, index) => (
        <div key={`draft-${index}`} className="grid grid-cols-12 gap-2 items-center">
          <div className="col-span-4">
            <select
              value={item.product_id}
              onChange={(e) => {
                const pid = e.target.value
                const b = pid ? balances[pid] : null
                const p = pid ? productIdMap[pid] : null
                onUpdate(index, {
                  product_id: pid,
                  qty: b ? b.on_hand : 0,
                  safety_stock: b?.safety_stock ?? null,
                  order_point: p?.order_point != null ? (Number(p.order_point) || null) : null,
                })
              }}
              className="w-full px-3 py-2 border rounded-lg bg-white text-sm"
            >
              <option value="">เลือกสินค้า</option>
              {productOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div className="col-span-2">
            <input
              type="number"
              min="0"
              value={item.order_point ?? ''}
              onChange={(e) => onUpdate(index, { order_point: e.target.value !== '' ? Number(e.target.value) : null })}
              placeholder="0"
              className="w-full px-3 py-2 border rounded-lg text-center text-sm"
            />
          </div>
          <div className="col-span-2">
            {(() => {
              const b = item.product_id ? balances[item.product_id] : null
              const totalPhysical = (b?.on_hand ?? 0) + (b?.safety_stock ?? 0)
              const overLimit = item.safety_stock != null && item.safety_stock > totalPhysical && totalPhysical > 0
              return (
                <>
                  <input
                    type="number"
                    min="0"
                    value={item.safety_stock ?? ''}
                    onChange={(e) => onUpdate(index, { safety_stock: e.target.value !== '' ? Number(e.target.value) : null })}
                    placeholder="0"
                    className={`w-full px-3 py-2 border rounded-lg text-center text-sm ${overLimit ? 'border-red-400 bg-red-50' : ''}`}
                  />
                  {overLimit && <p className="text-xs text-red-500 mt-0.5 text-center">เกินสต๊อครวม ({totalPhysical})</p>}
                </>
              )
            })()}
          </div>
          <div className="col-span-2">
            <input
              type="number"
              min="0"
              value={item.qty}
              onChange={(e) => onUpdate(index, { qty: Number(e.target.value) || 0 })}
              placeholder="0"
              className="w-full px-3 py-2 border rounded-lg text-center text-sm"
            />
          </div>
          <div className="col-span-2">
            <button
              type="button"
              onClick={() => onRemove(index)}
              disabled={items.length === 1}
              className="px-3 py-2 bg-red-100 text-red-600 rounded hover:bg-red-200 disabled:opacity-50 w-full text-sm"
            >
              ลบ
            </button>
          </div>
        </div>
      ))}
    </div>
  )
})
