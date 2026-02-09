import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import Modal from '../components/ui/Modal'
import { useAuthContext } from '../contexts/AuthContext'
import { InventoryGR, InventoryGRItem, InventoryPO } from '../types'
import { adjustStockBalancesBulk } from '../lib/inventory'

function generateCode(prefix: string) {
  const date = new Date()
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const rand = Math.floor(Math.random() * 9000) + 1000
  return `${prefix}-${y}${m}${d}-${rand}`
}

export default function PurchaseGR() {
  const { user } = useAuthContext()
  const [pos, setPos] = useState<InventoryPO[]>([])
  const [grs, setGrs] = useState<InventoryGR[]>([])
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState<string | null>(null)
  const [viewing, setViewing] = useState<InventoryGR | null>(null)
  const [viewItems, setViewItems] = useState<InventoryGRItem[]>([])

  useEffect(() => {
    loadAll()
  }, [])

  async function loadAll() {
    setLoading(true)
    try {
      const [poRes, grRes] = await Promise.all([
        supabase.from('inv_po').select('*').eq('status', 'ordered').order('created_at', { ascending: false }),
        supabase.from('inv_gr').select('*').order('created_at', { ascending: false }),
      ])
      if (poRes.error) throw poRes.error
      if (grRes.error) throw grRes.error
      setPos((poRes.data || []) as InventoryPO[])
      setGrs((grRes.data || []) as InventoryGR[])
    } catch (e) {
      console.error('Load GR failed:', e)
    } finally {
      setLoading(false)
    }
  }

  const grByPoId = useMemo(() => {
    const map: Record<string, InventoryGR> = {}
    grs.forEach((gr) => {
      if (gr.po_id) map[gr.po_id] = gr
    })
    return map
  }, [grs])

  async function receivePO(po: InventoryPO) {
    setUpdating(po.id)
    try {
      const { data: poItems, error: poItemsError } = await supabase
        .from('inv_po_items')
        .select('product_id, qty')
        .eq('po_id', po.id)
      if (poItemsError) throw poItemsError
      if (!poItems?.length) throw new Error('ไม่มีรายการสินค้าใน PO')

      const grNo = generateCode('GR')
      const { data: grData, error: grError } = await supabase
        .from('inv_gr')
        .insert({
          gr_no: grNo,
          po_id: po.id,
          status: 'received',
          received_by: user?.id || null,
          received_at: new Date().toISOString(),
        })
        .select('*')
        .single()
      if (grError) throw grError

      const itemsPayload = poItems.map((item) => ({
        gr_id: grData.id,
        product_id: item.product_id,
        qty_received: item.qty,
      }))
      const { error: itemError } = await supabase.from('inv_gr_items').insert(itemsPayload)
      if (itemError) throw itemError

      await adjustStockBalancesBulk(
        poItems.map((item) => ({
          productId: item.product_id,
          qtyDelta: Number(item.qty),
          movementType: 'gr',
          refType: 'inv_gr',
          refId: grData.id,
          note: `รับเข้าจาก PO ${po.po_no}`,
        }))
      )

      await loadAll()
      alert('รับเข้าคลังเรียบร้อย')
    } catch (e: any) {
      console.error('Receive GR failed:', e)
      alert('รับเข้าคลังไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setUpdating(null)
    }
  }

  async function openView(gr: InventoryGR) {
    setViewing(gr)
    const { data, error } = await supabase
      .from('inv_gr_items')
      .select('id, gr_id, product_id, qty_received, pr_products(product_code, product_name)')
      .eq('gr_id', gr.id)
    if (!error) {
      setViewItems((data || []) as unknown as InventoryGRItem[])
    }
  }

  return (
    <div className="space-y-6 mt-12">
      <div className="bg-white p-6 rounded-lg shadow space-y-6">
        <div>
          <h2 className="text-lg font-semibold mb-3">PO ที่รอรับเข้าคลัง</h2>
          {loading ? (
            <div className="flex justify-center items-center py-6">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
            </div>
          ) : pos.length === 0 ? (
            <div className="text-gray-500">ไม่มี PO ที่รอรับเข้าคลัง</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="p-2 text-left">เลขที่ PO</th>
                    <th className="p-2 text-left">วันที่สั่งซื้อ</th>
                    <th className="p-2 text-right">การจัดการ</th>
                  </tr>
                </thead>
                <tbody>
                  {pos.map((po) => (
                    <tr key={po.id} className="border-t">
                      <td className="p-2">{po.po_no}</td>
                      <td className="p-2">{po.ordered_at ? new Date(po.ordered_at).toLocaleString() : '-'}</td>
                      <td className="p-2 text-right">
                        {grByPoId[po.id] ? (
                          <span className="text-gray-500">รับเข้าแล้ว</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => receivePO(po)}
                            disabled={updating === po.id}
                            className="px-3 py-1 bg-emerald-500 text-white rounded hover:bg-emerald-600 text-sm disabled:opacity-50"
                          >
                            รับเข้าคลัง
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
          <h2 className="text-lg font-semibold mb-3">รายการ GR</h2>
          {loading ? (
            <div className="flex justify-center items-center py-6">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
            </div>
          ) : grs.length === 0 ? (
            <div className="text-gray-500">ยังไม่มี GR</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="p-2 text-left">เลขที่ GR</th>
                    <th className="p-2 text-left">สถานะ</th>
                    <th className="p-2 text-left">วันที่รับเข้า</th>
                    <th className="p-2 text-right">การจัดการ</th>
                  </tr>
                </thead>
                <tbody>
                  {grs.map((gr) => (
                    <tr key={gr.id} className="border-t">
                      <td className="p-2">{gr.gr_no}</td>
                      <td className="p-2">{gr.status}</td>
                      <td className="p-2">{gr.received_at ? new Date(gr.received_at).toLocaleString() : '-'}</td>
                      <td className="p-2 text-right">
                        <button
                          type="button"
                          onClick={() => openView(gr)}
                          className="px-3 py-1 bg-gray-200 rounded hover:bg-gray-300 text-sm"
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
      </div>

      <Modal open={!!viewing} onClose={() => setViewing(null)} contentClassName="max-w-2xl">
        <div className="p-6 space-y-4">
          <h2 className="text-xl font-bold">รายละเอียด GR</h2>
          {viewing && (
            <div className="text-sm text-gray-600">
              เลขที่ GR: <span className="font-medium text-gray-900">{viewing.gr_no}</span>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-100">
                <tr>
                  <th className="p-2 text-left">สินค้า</th>
                  <th className="p-2 text-right">จำนวนรับเข้า</th>
                </tr>
              </thead>
              <tbody>
                {viewItems.map((item: any) => (
                  <tr key={item.id} className="border-t">
                    <td className="p-2">
                      {item.pr_products?.product_code} - {item.pr_products?.product_name}
                    </td>
                    <td className="p-2 text-right">{Number(item.qty_received).toLocaleString()}</td>
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
