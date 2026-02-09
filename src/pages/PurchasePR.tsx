import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import Modal from '../components/ui/Modal'
import { useAuthContext } from '../contexts/AuthContext'
import { InventoryPR, InventoryPRItem, Product } from '../types'

interface DraftItem {
  product_id: string
  qty: number
}

function generateCode(prefix: string) {
  const date = new Date()
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const rand = Math.floor(Math.random() * 9000) + 1000
  return `${prefix}-${y}${m}${d}-${rand}`
}

export default function PurchasePR() {
  const { user } = useAuthContext()
  const [prs, setPrs] = useState<InventoryPR[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draftItems, setDraftItems] = useState<DraftItem[]>([{ product_id: '', qty: 1 }])
  const [note, setNote] = useState('')
  const [viewing, setViewing] = useState<InventoryPR | null>(null)
  const [viewItems, setViewItems] = useState<InventoryPRItem[]>([])
  const [updating, setUpdating] = useState<string | null>(null)

  const canApprove = user?.role === 'superadmin'

  const handleCreateFromTopBar = useCallback(() => setCreateOpen(true), [])

  useEffect(() => {
    window.addEventListener('purchase-pr-create', handleCreateFromTopBar)
    return () => window.removeEventListener('purchase-pr-create', handleCreateFromTopBar)
  }, [handleCreateFromTopBar])

  useEffect(() => {
    loadAll()
  }, [])

  async function loadAll() {
    setLoading(true)
    try {
      const [prRes, productRes] = await Promise.all([
        supabase.from('inv_pr').select('*').order('created_at', { ascending: false }),
        supabase.from('pr_products').select('id, product_code, product_name').eq('is_active', true),
      ])
      if (prRes.error) throw prRes.error
      if (productRes.error) throw productRes.error
      setPrs((prRes.data || []) as InventoryPR[])
      setProducts((productRes.data || []) as Product[])
    } catch (e) {
      console.error('Load PR failed:', e)
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

  async function createPR() {
    const validItems = draftItems.filter((i) => i.product_id && i.qty > 0)
    if (!validItems.length) {
      alert('กรุณาเพิ่มรายการสินค้าอย่างน้อย 1 รายการ')
      return
    }
    setSaving(true)
    try {
      const prNo = generateCode('PR')
      const { data: prData, error: prError } = await supabase
        .from('inv_pr')
        .insert({
          pr_no: prNo,
          status: 'pending',
          requested_by: user?.id || null,
          requested_at: new Date().toISOString(),
          note: note.trim() || null,
        })
        .select('*')
        .single()
      if (prError) throw prError

      const itemsPayload = validItems.map((item) => ({
        pr_id: prData.id,
        product_id: item.product_id,
        qty: item.qty,
      }))
      const { error: itemError } = await supabase.from('inv_pr_items').insert(itemsPayload)
      if (itemError) throw itemError

      setDraftItems([{ product_id: '', qty: 1 }])
      setNote('')
      setCreateOpen(false)
      await loadAll()
      alert('สร้าง PR เรียบร้อย')
    } catch (e: any) {
      console.error('Create PR failed:', e)
      alert('สร้าง PR ไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setSaving(false)
    }
  }

  async function openView(pr: InventoryPR) {
    setViewing(pr)
    const { data, error } = await supabase
      .from('inv_pr_items')
      .select('id, pr_id, product_id, qty, note, created_at, pr_products(product_code, product_name)')
      .eq('pr_id', pr.id)
    if (!error) {
      setViewItems((data || []) as InventoryPRItem[])
    }
  }

  async function updateStatus(pr: InventoryPR, status: string) {
    setUpdating(pr.id)
    try {
      const { error } = await supabase
        .from('inv_pr')
        .update({
          status,
          approved_by: status === 'approved' ? user?.id || null : null,
          approved_at: status === 'approved' ? new Date().toISOString() : null,
        })
        .eq('id', pr.id)
      if (error) throw error
      await loadAll()
    } catch (e) {
      console.error('Update PR status failed:', e)
    } finally {
      setUpdating(null)
    }
  }

  return (
    <div className="space-y-6 mt-12">
      <div className="bg-white p-6 rounded-lg shadow">
        {loading ? (
          <div className="flex justify-center items-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
          </div>
        ) : prs.length === 0 ? (
          <div className="text-center py-12 text-gray-500">ยังไม่มี PR</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-100">
                <tr>
                  <th className="p-3 text-left">เลขที่ PR</th>
                  <th className="p-3 text-left">สถานะ</th>
                  <th className="p-3 text-left">วันที่ขอ</th>
                  <th className="p-3 text-left">หมายเหตุ</th>
                  <th className="p-3 text-right">การจัดการ</th>
                </tr>
              </thead>
              <tbody>
                {prs.map((pr) => (
                  <tr key={pr.id} className="border-t">
                    <td className="p-3 font-medium">{pr.pr_no}</td>
                    <td className="p-3">{pr.status}</td>
                    <td className="p-3">{pr.requested_at ? new Date(pr.requested_at).toLocaleString() : '-'}</td>
                    <td className="p-3">{pr.note || '-'}</td>
                    <td className="p-3 text-right">
                      <div className="flex gap-2 justify-end">
                        <button
                          type="button"
                          onClick={() => openView(pr)}
                          className="px-3 py-1 bg-gray-200 rounded hover:bg-gray-300 text-sm"
                        >
                          ดูรายละเอียด
                        </button>
                        {canApprove && pr.status === 'pending' && (
                          <>
                            <button
                              type="button"
                              disabled={updating === pr.id}
                              onClick={() => updateStatus(pr, 'approved')}
                              className="px-3 py-1 bg-emerald-500 text-white rounded hover:bg-emerald-600 text-sm disabled:opacity-50"
                            >
                              อนุมัติ
                            </button>
                            <button
                              type="button"
                              disabled={updating === pr.id}
                              onClick={() => updateStatus(pr, 'rejected')}
                              className="px-3 py-1 bg-red-500 text-white rounded hover:bg-red-600 text-sm disabled:opacity-50"
                            >
                              ไม่อนุมัติ
                            </button>
                          </>
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

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        closeOnBackdropClick={false}
        contentClassName="max-w-3xl"
      >
        <div className="p-6 space-y-4">
          <h2 className="text-xl font-bold">สร้างใบ PR</h2>
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
              onClick={createPR}
              disabled={saving}
              className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50"
            >
              {saving ? 'กำลังบันทึก...' : 'บันทึก PR'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={!!viewing} onClose={() => setViewing(null)} contentClassName="max-w-2xl">
        <div className="p-6 space-y-4">
          <h2 className="text-xl font-bold">รายละเอียด PR</h2>
          {viewing && (
            <div className="text-sm text-gray-600">
              เลขที่ PR: <span className="font-medium text-gray-900">{viewing.pr_no}</span>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-100">
                <tr>
                  <th className="p-2 text-left">สินค้า</th>
                  <th className="p-2 text-right">จำนวน</th>
                </tr>
              </thead>
              <tbody>
                {viewItems.map((item: any) => (
                  <tr key={item.id} className="border-t">
                    <td className="p-2">
                      {item.pr_products?.product_code} - {item.pr_products?.product_name}
                    </td>
                    <td className="p-2 text-right">{Number(item.qty).toLocaleString()}</td>
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
