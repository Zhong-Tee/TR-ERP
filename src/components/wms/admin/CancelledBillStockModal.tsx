import { useEffect, useState } from 'react'
import { supabase } from '../../../lib/supabase'
import { useAuthContext } from '../../../contexts/AuthContext'
import { isAdminOrSuperadmin } from '../../../config/accessPolicy'
import Modal from '../../ui/Modal'

export type CancelledBillSummary = {
  id: string
  bill_no: string
  customer_name: string
  partial?: boolean
}

type Props = {
  open: boolean
  workOrderId: string | null
  displayName: string
  cancelledBills: CancelledBillSummary[]
  onClose: () => void
  onChanged?: () => void
}

export default function CancelledBillStockModal({
  open,
  workOrderId,
  displayName,
  cancelledBills,
  onClose,
  onChanged,
}: Props) {
  const { user } = useAuthContext()
  const canManageStock = isAdminOrSuperadmin(user?.role)
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null)
  const [lines, setLines] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [error, setError] = useState('')

  const loadLines = async (orderId: string) => {
    if (!workOrderId || !orderId) return
    setLoading(true)
    setError('')
    setSelectedOrderId(orderId)
    try {
      const { data: cancelledItems, error: itemError } = await supabase
        .from('or_order_items')
        .select('id, product_id')
        .eq('order_id', orderId)
        .not('cancellation_stock_action', 'is', null)
      if (itemError) throw itemError

      const itemIds = (cancelledItems || []).map((row: any) => row.id).filter(Boolean)
      const productIds = (cancelledItems || []).map((row: any) => row.product_id).filter(Boolean)
      const { data: products } = productIds.length
        ? await supabase.from('pr_products').select('id, product_code').in('id', productIds)
        : { data: [] as any[] }
      const productCodes = new Set((products || []).map((p: any) => String(p.product_code || '').trim().toUpperCase()).filter(Boolean))

      const { data: wmsRows, error: wmsError } = await supabase
        .from('wms_orders')
        .select('id, source_order_id, source_order_item_id, product_code, product_name, location, qty, status, stock_action, assigned_to, us_users!assigned_to(username)')
        .eq('work_order_id', workOrderId)
        .eq('status', 'cancelled')
        .order('created_at', { ascending: true })
      if (wmsError) throw wmsError

      const itemIdSet = new Set(itemIds)
      const filtered = (wmsRows || []).filter((row: any) => {
        if (row.source_order_item_id) return itemIdSet.has(row.source_order_item_id)
        if (row.source_order_id) return row.source_order_id === orderId
        return productCodes.has(String(row.product_code || '').trim().toUpperCase())
      })
      setLines(filtered)
    } catch (e: any) {
      setLines([])
      setError(e?.message || 'โหลดรายการยกเลิกไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    const firstId = cancelledBills[0]?.id || null
    setSelectedOrderId(firstId)
    setLines([])
    setError('')
    if (firstId) void loadLines(firstId)
  }, [open, workOrderId, cancelledBills.map((b) => b.id).join('|')])

  const handleStockAction = async (wmsOrderId: string, action: 'recall' | 'waste') => {
    if (!canManageStock || !selectedOrderId) return
    setActionLoading(wmsOrderId)
    setError('')
    try {
      const { error: actionError } = action === 'recall'
        ? await supabase.rpc('fn_reverse_wms_stock', { p_wms_order_id: wmsOrderId })
        : await supabase.rpc('rpc_record_cancellation_waste', {
            p_wms_order_id: wmsOrderId,
            p_user_id: user?.id,
          })
      if (actionError) throw actionError
      await loadLines(selectedOrderId)
      onChanged?.()
      window.dispatchEvent(new Event('wms-data-changed'))
    } catch (e: any) {
      setError(e?.message || 'ดำเนินการไม่สำเร็จ')
    } finally {
      setActionLoading(null)
    }
  }

  const pendingCount = lines.filter((line) => !line.stock_action).length

  return (
    <Modal open={open} onClose={onClose} contentClassName="max-w-5xl max-h-[88vh] overflow-y-auto">
      <div className="p-6 space-y-4">
        <div className="border-b pb-4">
          <div>
            <h3 className="text-xl font-bold text-gray-900">รายการยกเลิกบิล — {displayName}</h3>
            <p className="mt-1 text-sm text-gray-500">ตรวจรายการที่ถูกหยุด และเลือกผลต่อสต๊อคเฉพาะรายการที่รอดำเนินการ</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {cancelledBills.map((bill) => (
            <button
              type="button"
              key={bill.id}
              onClick={() => void loadLines(bill.id)}
              className={`rounded-lg border px-3 py-2 text-left text-sm ${selectedOrderId === bill.id ? 'border-red-400 bg-red-50' : 'border-gray-200 bg-white hover:bg-gray-50'}`}
            >
              <span className="font-mono font-bold text-red-700">{bill.bill_no || '-'}</span>
              <span className="ml-2 text-gray-500">{bill.customer_name || '-'}</span>
              <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">
                {bill.partial ? 'ยกเลิกบางรายการ' : 'ยกเลิกทั้งบิล'}
              </span>
            </button>
          ))}
        </div>

        {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

        {loading ? (
          <div className="py-10 text-center text-gray-500">กำลังโหลดรายการ...</div>
        ) : lines.length === 0 ? (
          <div className="rounded-lg border border-gray-200 py-10 text-center text-gray-500">ไม่พบรายการ WMS ของบิลนี้ หรือรายการไม่เคยถูกมอบหมายให้ Picker</div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="w-full min-w-[850px] text-sm">
              <thead className="bg-gray-50 text-gray-700">
                <tr>
                  <th className="px-3 py-3 text-left">รหัสสินค้า</th>
                  <th className="px-3 py-3 text-left">สินค้า</th>
                  <th className="px-3 py-3 text-left">จุดจัดเก็บ</th>
                  <th className="px-3 py-3 text-center">จำนวน</th>
                  <th className="px-3 py-3 text-left">Picker</th>
                  <th className="px-3 py-3 text-center">ผลต่อสต๊อค</th>
                  <th className="px-3 py-3 text-center">จัดการ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {lines.map((line) => (
                  <tr key={line.id} className={!line.stock_action ? 'bg-amber-50/50' : ''}>
                    <td className="px-3 py-3 font-mono">{line.product_code || '-'}</td>
                    <td className="px-3 py-3">{line.product_name || '-'}</td>
                    <td className="px-3 py-3">{line.location || '-'}</td>
                    <td className="px-3 py-3 text-center font-semibold">{line.qty ?? '-'}</td>
                    <td className="px-3 py-3">{line.us_users?.username || '-'}</td>
                    <td className="px-3 py-3 text-center">
                      {line.stock_action === 'recalled' ? (
                        <span className="rounded-full bg-green-100 px-2 py-1 text-xs font-semibold text-green-700">คืนสต๊อคแล้ว</span>
                      ) : line.stock_action === 'waste' ? (
                        <span className="rounded-full bg-orange-100 px-2 py-1 text-xs font-semibold text-orange-700">ของเสีย/ไม่คืนสต๊อค</span>
                      ) : (
                        <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-700">รอตัดสินใจ</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-center">
                      {!line.stock_action && canManageStock ? (
                        <div className="flex justify-center gap-2">
                          <button type="button" disabled={actionLoading === line.id} onClick={() => void handleStockAction(line.id, 'recall')} className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-green-700 disabled:opacity-50">คืนสต๊อค</button>
                          <button type="button" disabled={actionLoading === line.id} onClick={() => void handleStockAction(line.id, 'waste')} className="rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-orange-700 disabled:opacity-50">ของเสีย</button>
                        </div>
                      ) : !line.stock_action ? <span className="text-xs text-gray-400">รอผู้มีสิทธิ์</span> : <span className="text-xs text-gray-400">ดำเนินการแล้ว</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-center justify-between border-t pt-4">
          <span className={`text-sm font-semibold ${pendingCount > 0 ? 'text-amber-700' : 'text-green-700'}`}>
            {pendingCount > 0 ? `รอตัดสินใจ ${pendingCount} รายการ` : lines.length > 0 ? 'ดำเนินการสต๊อคครบแล้ว' : ''}
          </span>
          <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-50">ปิด</button>
        </div>
      </div>
    </Modal>
  )
}
