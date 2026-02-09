import { useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import Modal from '../components/ui/Modal'
import { InventoryAudit, InventoryAuditItem, Product, StockBalance } from '../types'

const TEMPLATE_HEADERS = ['product_code', 'counted_qty'] as const

interface DraftAuditItem {
  product_id: string
  counted_qty: number
}

function generateCode(prefix: string) {
  const date = new Date()
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const rand = Math.floor(Math.random() * 9000) + 1000
  return `${prefix}-${y}${m}${d}-${rand}`
}

export default function WarehouseAudit() {
  const [audits, setAudits] = useState<InventoryAudit[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [balances, setBalances] = useState<Record<string, StockBalance>>({})
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draftItems, setDraftItems] = useState<DraftAuditItem[]>([{ product_id: '', counted_qty: 0 }])
  const [note, setNote] = useState('')
  const [viewing, setViewing] = useState<InventoryAudit | null>(null)
  const [viewItems, setViewItems] = useState<InventoryAuditItem[]>([])
  const importInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    loadAll()
  }, [])

  async function loadAll() {
    setLoading(true)
    try {
      const [auditRes, productRes, balanceRes] = await Promise.all([
        supabase.from('inv_audits').select('*').order('created_at', { ascending: false }),
        supabase.from('pr_products').select('id, product_code, product_name').eq('is_active', true),
        supabase
          .from('inv_stock_balances')
          .select('id, product_id, on_hand, reserved, safety_stock, created_at, updated_at'),
      ])
      if (auditRes.error) throw auditRes.error
      if (productRes.error) throw productRes.error
      if (balanceRes.error) throw balanceRes.error
      setAudits((auditRes.data || []) as InventoryAudit[])
      setProducts((productRes.data || []) as Product[])
      const map: Record<string, StockBalance> = {}
      ;(balanceRes.data || []).forEach((row) => {
        map[row.product_id] = row as StockBalance
      })
      setBalances(map)
    } catch (e) {
      console.error('Load audit failed:', e)
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

  function downloadTemplate() {
    const ws = XLSX.utils.aoa_to_sheet([
      TEMPLATE_HEADERS as unknown as string[],
      ['P001', 10],
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Audit')
    XLSX.writeFile(wb, 'Template_Audit.xlsx')
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

      const nextItems: DraftAuditItem[] = []
      rows.forEach((row) => {
        const code = String(row.product_code ?? '').trim()
        const qty = Number(row.counted_qty ?? 0)
        const product = productCodeMap[code]
        if (!product || qty < 0) return
        nextItems.push({ product_id: product.id, counted_qty: qty })
      })
      if (!nextItems.length) throw new Error('ไม่มีแถวที่ valid (ต้องมี product_code และ counted_qty)')
      setDraftItems(nextItems)
      setCreateOpen(true)
    } catch (e: any) {
      console.error('Import error:', e)
      alert('นำเข้าไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      importInputRef.current && (importInputRef.current.value = '')
    }
  }

  function addDraftItem() {
    setDraftItems((prev) => [...prev, { product_id: '', counted_qty: 0 }])
  }

  function updateDraftItem(index: number, patch: Partial<DraftAuditItem>) {
    setDraftItems((prev) =>
      prev.map((item, idx) => (idx === index ? { ...item, ...patch } : item))
    )
  }

  function removeDraftItem(index: number) {
    setDraftItems((prev) => prev.filter((_, idx) => idx !== index))
  }

  async function createAudit() {
    const validItems = draftItems.filter((i) => i.product_id && Number.isFinite(i.counted_qty))
    if (!validItems.length) {
      alert('กรุณาเพิ่มรายการสินค้าอย่างน้อย 1 รายการ')
      return
    }
    setSaving(true)
    try {
      const auditNo = generateCode('AUDIT')
      const itemsPayload = validItems.map((item) => {
        const systemQty = Number(balances[item.product_id]?.on_hand || 0)
        const countedQty = Number(item.counted_qty || 0)
        const variance = countedQty - systemQty
        return {
          product_id: item.product_id,
          system_qty: systemQty,
          counted_qty: countedQty,
          variance,
        }
      })

      const totalSystem = itemsPayload.reduce((sum, i) => sum + Number(i.system_qty || 0), 0)
      const totalVariance = itemsPayload.reduce((sum, i) => sum + Math.abs(Number(i.variance || 0)), 0)
      const accuracy = totalSystem > 0 ? ((totalSystem - totalVariance) / totalSystem) * 100 : 100

      const { data: auditData, error: auditError } = await supabase
        .from('inv_audits')
        .insert({
          audit_no: auditNo,
          status: 'completed',
          completed_at: new Date().toISOString(),
          accuracy_percent: Number.isFinite(accuracy) ? accuracy : 0,
          total_items: itemsPayload.length,
          total_variance: totalVariance,
          note: note.trim() || null,
        })
        .select('*')
        .single()
      if (auditError) throw auditError

      const { error: itemError } = await supabase.from('inv_audit_items').insert(
        itemsPayload.map((item) => ({
          audit_id: auditData.id,
          ...item,
        }))
      )
      if (itemError) throw itemError

      setDraftItems([{ product_id: '', counted_qty: 0 }])
      setNote('')
      setCreateOpen(false)
      await loadAll()
      alert('บันทึก Audit เรียบร้อย')
    } catch (e: any) {
      console.error('Create audit failed:', e)
      alert('บันทึก Audit ไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setSaving(false)
    }
  }

  async function openView(audit: InventoryAudit) {
    setViewing(audit)
    const { data, error } = await supabase
      .from('inv_audit_items')
      .select('id, audit_id, product_id, system_qty, counted_qty, variance, pr_products(product_code, product_name)')
      .eq('audit_id', audit.id)
    if (!error) {
      setViewItems((data || []) as InventoryAuditItem[])
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
          + สร้างใบ Audit
        </button>
      </div>

      <div className="bg-white p-6 rounded-lg shadow">
        {loading ? (
          <div className="flex justify-center items-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
          </div>
        ) : audits.length === 0 ? (
          <div className="text-center py-12 text-gray-500">ยังไม่มีประวัติ Audit</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-blue-600 text-white">
                  <th className="p-3 text-left font-semibold rounded-tl-xl">เลขที่ Audit</th>
                  <th className="p-3 text-left font-semibold">วันที่</th>
                  <th className="p-3 text-left font-semibold">ความถูกต้อง (%)</th>
                  <th className="p-3 text-right font-semibold rounded-tr-xl">การจัดการ</th>
                </tr>
              </thead>
              <tbody>
                {audits.map((audit, idx) => (
                  <tr key={audit.id} className={`border-b border-gray-200 hover:bg-blue-50 transition-colors ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                    <td className="p-3 font-medium">{audit.audit_no}</td>
                    <td className="p-3">{new Date(audit.created_at).toLocaleString()}</td>
                    <td className="p-3">{audit.accuracy_percent?.toFixed(2) ?? '-'}</td>
                    <td className="p-3 text-right">
                      <button
                        type="button"
                        onClick={() => openView(audit)}
                        className="px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-semibold"
                      >
                        ดูรายละเอียด
                      </button>
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
          <h2 className="text-xl font-bold">สร้างใบ Audit</h2>
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
                    min={0}
                    value={item.counted_qty}
                    onChange={(e) => updateDraftItem(index, { counted_qty: Number(e.target.value) || 0 })}
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
              onClick={createAudit}
              disabled={saving}
              className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50"
            >
              {saving ? 'กำลังบันทึก...' : 'บันทึก Audit'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={!!viewing} onClose={() => setViewing(null)} contentClassName="max-w-2xl">
        <div className="p-6 space-y-4">
          <h2 className="text-xl font-bold">รายละเอียด Audit</h2>
          {viewing && (
            <div className="text-sm text-gray-600">
              เลขที่ Audit: <span className="font-medium text-gray-900">{viewing.audit_no}</span>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-100">
                <tr>
                  <th className="p-2 text-left">สินค้า</th>
                  <th className="p-2 text-right">ในระบบ</th>
                  <th className="p-2 text-right">นับได้</th>
                  <th className="p-2 text-right">ต่าง</th>
                </tr>
              </thead>
              <tbody>
                {viewItems.map((item: any) => (
                  <tr key={item.id} className="border-t">
                    <td className="p-2">
                      {item.pr_products?.product_code} - {item.pr_products?.product_name}
                    </td>
                    <td className="p-2 text-right">{Number(item.system_qty).toLocaleString()}</td>
                    <td className="p-2 text-right">{Number(item.counted_qty).toLocaleString()}</td>
                    <td className="p-2 text-right">{Number(item.variance).toLocaleString()}</td>
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
    </div>
  )
}
