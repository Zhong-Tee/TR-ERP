import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import Modal from '../components/ui/Modal'
import { useAuthContext } from '../contexts/AuthContext'
import { InventoryReturn, InventoryReturnItem, Product } from '../types'
import { adjustStockBalancesBulk } from '../lib/inventory'

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

export default function WarehouseReturns() {
  const { user } = useAuthContext()
  const [returnsList, setReturnsList] = useState<InventoryReturn[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [shippedBills, setShippedBills] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draftItems, setDraftItems] = useState<DraftItem[]>([{ product_id: '', qty: 1 }])
  const [note, setNote] = useState('')
  const [reason, setReason] = useState('')
  const [billNo, setBillNo] = useState('')
  const [viewing, setViewing] = useState<InventoryReturn | null>(null)
  const [viewItems, setViewItems] = useState<InventoryReturnItem[]>([])
  const [updating, setUpdating] = useState<string | null>(null)

  useEffect(() => {
    loadAll()
  }, [])

  async function loadAll() {
    setLoading(true)
    try {
      const [returnRes, productRes, billRes] = await Promise.all([
        supabase.from('inv_returns').select('*').order('created_at', { ascending: false }),
        supabase.from('pr_products').select('id, product_code, product_name').eq('is_active', true),
        supabase.from('or_orders').select('bill_no').eq('status', 'จัดส่งแล้ว'),
      ])
      if (returnRes.error) throw returnRes.error
      if (productRes.error) throw productRes.error
      if (billRes.error) throw billRes.error
      setReturnsList((returnRes.data || []) as InventoryReturn[])
      setProducts((productRes.data || []) as Product[])
      setShippedBills(
        [...new Set((billRes.data || []).map((row) => row.bill_no).filter(Boolean))].sort()
      )
    } catch (e) {
      console.error('Load returns failed:', e)
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

  async function createReturn() {
    const validItems = draftItems.filter((i) => i.product_id && i.qty > 0)
    if (!billNo) {
      alert('กรุณาเลือกเลขบิลอ้างอิง')
      return
    }
    if (!reason.trim()) {
      alert('กรุณาระบุเหตุผลตีกลับ')
      return
    }
    if (!validItems.length) {
      alert('กรุณาเพิ่มรายการสินค้าอย่างน้อย 1 รายการ')
      return
    }
    setSaving(true)
    try {
      const returnNo = generateCode('RTN')
      const { data: returnData, error: returnError } = await supabase
        .from('inv_returns')
        .insert({
          return_no: returnNo,
          ref_bill_no: billNo,
          reason: reason.trim(),
          status: 'pending',
          created_by: user?.id || null,
          note: note.trim() || null,
        })
        .select('*')
        .single()
      if (returnError) throw returnError

      const itemsPayload = validItems.map((item) => ({
        return_id: returnData.id,
        product_id: item.product_id,
        qty: item.qty,
      }))
      const { error: itemError } = await supabase.from('inv_return_items').insert(itemsPayload)
      if (itemError) throw itemError

      setDraftItems([{ product_id: '', qty: 1 }])
      setNote('')
      setReason('')
      setBillNo('')
      setCreateOpen(false)
      await loadAll()
      alert('สร้างใบรับสินค้าตีกลับเรียบร้อย')
    } catch (e: any) {
      console.error('Create return failed:', e)
      alert('สร้างใบรับสินค้าตีกลับไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setSaving(false)
    }
  }

  async function receiveReturn(ret: InventoryReturn) {
    setUpdating(ret.id)
    try {
      const { data: items, error: itemsError } = await supabase
        .from('inv_return_items')
        .select('product_id, qty')
        .eq('return_id', ret.id)
      if (itemsError) throw itemsError

      const { error } = await supabase
        .from('inv_returns')
        .update({
          status: 'received',
          received_by: user?.id || null,
          received_at: new Date().toISOString(),
        })
        .eq('id', ret.id)
      if (error) throw error

      await adjustStockBalancesBulk(
        (items || []).map((item) => ({
          productId: item.product_id,
          qtyDelta: Number(item.qty),
          movementType: 'return',
          refType: 'inv_returns',
          refId: ret.id,
          note: `รับสินค้าตีกลับ ${ret.return_no}`,
        }))
      )

      await loadAll()
      alert('รับสินค้าตีกลับเข้าคลังเรียบร้อย')
    } catch (e: any) {
      console.error('Receive return failed:', e)
      alert('รับสินค้าตีกลับไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setUpdating(null)
    }
  }

  async function openView(ret: InventoryReturn) {
    setViewing(ret)
    const { data, error } = await supabase
      .from('inv_return_items')
      .select('id, return_id, product_id, qty, pr_products(product_code, product_name)')
      .eq('return_id', ret.id)
    if (!error) {
      setViewItems((data || []) as unknown as InventoryReturnItem[])
    }
  }

  return (
    <div className="space-y-6 mt-12">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="px-4 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-semibold"
        >
          + เปิดใบรับสินค้าตีกลับ
        </button>
      </div>

      <div className="bg-white p-6 rounded-lg shadow">
        {loading ? (
          <div className="flex justify-center items-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
          </div>
        ) : returnsList.length === 0 ? (
          <div className="text-center py-12 text-gray-500">ยังไม่มีรายการตีกลับ</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-blue-600 text-white">
                  <th className="p-3 text-left font-semibold rounded-tl-xl">เลขที่รับคืน</th>
                  <th className="p-3 text-left font-semibold">เลขบิลอ้างอิง</th>
                  <th className="p-3 text-left font-semibold">เหตุผล</th>
                  <th className="p-3 text-left font-semibold">สถานะ</th>
                  <th className="p-3 text-right font-semibold rounded-tr-xl">การจัดการ</th>
                </tr>
              </thead>
              <tbody>
                {returnsList.map((ret, idx) => (
                  <tr key={ret.id} className={`border-b border-gray-200 hover:bg-blue-50 transition-colors ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                    <td className="p-3 font-medium">{ret.return_no}</td>
                    <td className="p-3">{ret.ref_bill_no || '-'}</td>
                    <td className="p-3">{ret.reason || '-'}</td>
                    <td className="p-3">
                      <span className={`inline-flex px-3 py-1 rounded-full text-xs font-bold ${
                        ret.status === 'received' ? 'bg-green-500 text-white' : 'bg-amber-500 text-white'
                      }`}>
                        {ret.status}
                      </span>
                    </td>
                    <td className="p-3 text-right">
                      <div className="flex gap-2 justify-end">
                        <button
                          type="button"
                          onClick={() => openView(ret)}
                          className="px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-semibold"
                        >
                          ดูรายละเอียด
                        </button>
                        {ret.status === 'pending' && (
                          <button
                            type="button"
                            onClick={() => receiveReturn(ret)}
                            disabled={updating === ret.id}
                            className="px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-semibold disabled:opacity-50"
                          >
                            รับเข้าคลัง
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
          <h2 className="text-xl font-bold">เปิดใบรับสินค้าตีกลับ</h2>
          <div className="grid grid-cols-12 gap-4">
            <div className="col-span-6">
              <label className="block text-sm font-medium mb-1">เลขบิลอ้างอิง</label>
              <select
                value={billNo}
                onChange={(e) => setBillNo(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg bg-white"
              >
                <option value="">เลือกเลขบิล</option>
                {shippedBills.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </div>
            <div className="col-span-6">
              <label className="block text-sm font-medium mb-1">เหตุผลตีกลับ</label>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg"
                placeholder="ระบุเหตุผล"
              />
            </div>
          </div>

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
              onClick={createReturn}
              disabled={saving}
              className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50"
            >
              {saving ? 'กำลังบันทึก...' : 'บันทึกใบรับคืน'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={!!viewing} onClose={() => setViewing(null)} contentClassName="max-w-2xl">
        <div className="p-6 space-y-4">
          <h2 className="text-xl font-bold">รายละเอียดรับสินค้าตีกลับ</h2>
          {viewing && (
            <div className="text-sm text-gray-600">
              เลขที่: <span className="font-medium text-gray-900">{viewing.return_no}</span>
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
