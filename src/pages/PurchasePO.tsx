import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import Modal from '../components/ui/Modal'
import { useAuthContext } from '../contexts/AuthContext'
import { InventoryPO, InventoryPOItem, InventoryPR } from '../types'

function generateCode(prefix: string) {
  const date = new Date()
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const rand = Math.floor(Math.random() * 9000) + 1000
  return `${prefix}-${y}${m}${d}-${rand}`
}

export default function PurchasePO() {
  const { user } = useAuthContext()
  const [prs, setPrs] = useState<InventoryPR[]>([])
  const [pos, setPos] = useState<InventoryPO[]>([])
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState<string | null>(null)
  const [viewing, setViewing] = useState<InventoryPO | null>(null)
  const [viewItems, setViewItems] = useState<InventoryPOItem[]>([])

  useEffect(() => {
    loadAll()
  }, [])

  async function loadAll() {
    setLoading(true)
    try {
      const [prRes, poRes] = await Promise.all([
        supabase.from('inv_pr').select('*').eq('status', 'approved').order('created_at', { ascending: false }),
        supabase.from('inv_po').select('*').order('created_at', { ascending: false }),
      ])
      if (prRes.error) throw prRes.error
      if (poRes.error) throw poRes.error
      setPrs((prRes.data || []) as InventoryPR[])
      setPos((poRes.data || []) as InventoryPO[])
    } catch (e) {
      console.error('Load PO failed:', e)
    } finally {
      setLoading(false)
    }
  }

  const poByPrId = useMemo(() => {
    const map: Record<string, InventoryPO> = {}
    pos.forEach((po) => {
      if (po.pr_id) map[po.pr_id] = po
    })
    return map
  }, [pos])

  async function createPO(pr: InventoryPR) {
    setUpdating(pr.id)
    try {
      const { data: prItems, error: prItemsError } = await supabase
        .from('inv_pr_items')
        .select('product_id, qty')
        .eq('pr_id', pr.id)
      if (prItemsError) throw prItemsError
      if (!prItems?.length) throw new Error('ไม่มีรายการสินค้าใน PR')

      const poNo = generateCode('PO')
      const { data: poData, error: poError } = await supabase
        .from('inv_po')
        .insert({
          po_no: poNo,
          pr_id: pr.id,
          status: 'open',
          note: pr.note || null,
        })
        .select('*')
        .single()
      if (poError) throw poError

      const itemsPayload = prItems.map((item) => ({
        po_id: poData.id,
        product_id: item.product_id,
        qty: item.qty,
      }))
      const { error: itemError } = await supabase.from('inv_po_items').insert(itemsPayload)
      if (itemError) throw itemError

      await loadAll()
      alert('สร้าง PO เรียบร้อย')
    } catch (e: any) {
      console.error('Create PO failed:', e)
      alert('สร้าง PO ไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setUpdating(null)
    }
  }

  async function markOrdered(po: InventoryPO) {
    setUpdating(po.id)
    try {
      const { error } = await supabase
        .from('inv_po')
        .update({
          status: 'ordered',
          ordered_by: user?.id || null,
          ordered_at: new Date().toISOString(),
        })
        .eq('id', po.id)
      if (error) throw error
      await loadAll()
    } catch (e) {
      console.error('Mark ordered failed:', e)
    } finally {
      setUpdating(null)
    }
  }

  async function openView(po: InventoryPO) {
    setViewing(po)
    const { data, error } = await supabase
      .from('inv_po_items')
      .select('id, po_id, product_id, qty, unit_price, note, pr_products(product_code, product_name)')
      .eq('po_id', po.id)
    if (!error) {
      setViewItems((data || []) as unknown as InventoryPOItem[])
    }
  }

  return (
    <div className="space-y-6 mt-12">
      <div className="bg-white p-6 rounded-lg shadow space-y-6">
        <div>
          <h2 className="text-lg font-semibold mb-3">PR ที่รอสร้าง PO</h2>
          {loading ? (
            <div className="flex justify-center items-center py-6">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
            </div>
          ) : prs.length === 0 ? (
            <div className="text-gray-500">ไม่มี PR ที่รอสร้าง PO</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="p-2 text-left">เลขที่ PR</th>
                    <th className="p-2 text-left">วันที่อนุมัติ</th>
                    <th className="p-2 text-right">การจัดการ</th>
                  </tr>
                </thead>
                <tbody>
                  {prs.map((pr) => (
                    <tr key={pr.id} className="border-t">
                      <td className="p-2">{pr.pr_no}</td>
                      <td className="p-2">{pr.approved_at ? new Date(pr.approved_at).toLocaleString() : '-'}</td>
                      <td className="p-2 text-right">
                        {poByPrId[pr.id] ? (
                          <span className="text-gray-500">สร้าง PO แล้ว</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => createPO(pr)}
                            disabled={updating === pr.id}
                            className="px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 text-sm disabled:opacity-50"
                          >
                            สร้าง PO
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div>
          <h2 className="text-lg font-semibold mb-3">รายการ PO</h2>
          {loading ? (
            <div className="flex justify-center items-center py-6">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
            </div>
          ) : pos.length === 0 ? (
            <div className="text-gray-500">ยังไม่มี PO</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="p-2 text-left">เลขที่ PO</th>
                    <th className="p-2 text-left">สถานะ</th>
                    <th className="p-2 text-left">วันที่สั่งซื้อ</th>
                    <th className="p-2 text-right">การจัดการ</th>
                  </tr>
                </thead>
                <tbody>
                  {pos.map((po) => (
                    <tr key={po.id} className="border-t">
                      <td className="p-2">{po.po_no}</td>
                      <td className="p-2">{po.status}</td>
                      <td className="p-2">{po.ordered_at ? new Date(po.ordered_at).toLocaleString() : '-'}</td>
                      <td className="p-2 text-right">
                        <div className="flex gap-2 justify-end">
                          <button
                            type="button"
                            onClick={() => openView(po)}
                            className="px-3 py-1 bg-gray-200 rounded hover:bg-gray-300 text-sm"
                          >
                            ดูรายละเอียด
                          </button>
                          {po.status === 'open' && (
                            <button
                              type="button"
                              onClick={() => markOrdered(po)}
                              disabled={updating === po.id}
                              className="px-3 py-1 bg-emerald-500 text-white rounded hover:bg-emerald-600 text-sm disabled:opacity-50"
                            >
                              สั่งซื้อแล้ว
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
      </div>

      <Modal open={!!viewing} onClose={() => setViewing(null)} contentClassName="max-w-2xl">
        <div className="p-6 space-y-4">
          <h2 className="text-xl font-bold">รายละเอียด PO</h2>
          {viewing && (
            <div className="text-sm text-gray-600">
              เลขที่ PO: <span className="font-medium text-gray-900">{viewing.po_no}</span>
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
