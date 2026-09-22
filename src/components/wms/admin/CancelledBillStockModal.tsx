import { useEffect, useState } from 'react'
import { supabase } from '../../../lib/supabase'
import { useAuthContext } from '../../../contexts/AuthContext'
import { isRoleInAllowedList } from '../../../config/accessPolicy'
import Modal from '../../ui/Modal'
import { fetchCancelledWmsHistory } from '../../../lib/cancelledWmsHistory'

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
  const canManageStock = isRoleInAllowedList(user?.role, ['superadmin', 'admin', 'store'])
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
      const history = await fetchCancelledWmsHistory({
        workOrderId,
        workOrderName: displayName,
        orderId,
      })
      setLines(history)
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

  const handleStockAction = async (wmsOrderId: string, action: 'not_picked' | 'recall' | 'waste') => {
    if (!canManageStock || !selectedOrderId) return
    setActionLoading(wmsOrderId)
    setError('')
    try {
      const { error: actionError } = await supabase.rpc('rpc_resolve_cancelled_wms', {
        p_wms_order_id: wmsOrderId,
        p_action: action,
      })
      if (actionError) throw actionError
      const { error: reconcileError } = await supabase.rpc('reconcile_work_order_after_cancellation', {
        p_work_order_id: workOrderId,
      })
      if (reconcileError) throw reconcileError
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
    <Modal open={open} onClose={onClose} contentClassName="w-[96vw] max-w-[1440px] max-h-[88vh] overflow-y-auto">
      <div className="p-6 space-y-4">
        <div className="border-b pb-4">
          <div>
            <h3 className="text-xl font-bold text-gray-900">รายการยกเลิกบิล — {displayName}</h3>
            <p className="mt-1 text-sm text-gray-500">ระบบปิดรายการที่ยังไม่ได้หยิบให้อัตโนมัติ ส่วนการแจ้งหาสินค้าไม่เจอยังคงรอคลังตรวจสอบแยกต่างหาก</p>
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
            <table className="w-full min-w-[1200px] text-sm">
              <thead className="bg-gray-50 text-gray-700">
                <tr>
                  <th className="px-3 py-3 text-left">รหัสสินค้า</th>
                  <th className="px-3 py-3 text-left">สินค้า</th>
                  <th className="px-3 py-3 text-left">จุดจัดเก็บ</th>
                  <th className="px-3 py-3 text-center">จำนวน</th>
                  <th className="px-3 py-3 text-left">Picker</th>
                  <th className="px-3 py-3 text-center">สถานะการยกเลิก</th>
                  <th className="px-3 py-3 text-left">ผู้ดำเนินการ/เวลา</th>
                  <th className="w-[300px] min-w-[300px] px-3 py-3 text-center">จัดการ</th>
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
                    <td className="w-[210px] px-3 py-3 text-center">
                      {line.stock_action === 'not_picked' ? (
                        <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">ไม่ได้หยิบ · ไม่ปรับสต๊อก</span>
                      ) : line.stock_action === 'recalled' && line.status === 'returned' ? (
                        <span className="rounded-full bg-green-100 px-2 py-1 text-xs font-semibold text-green-700">คืนเข้าชั้นแล้ว</span>
                      ) : line.stock_action === 'recalled' ? (
                        <span className="rounded-full bg-blue-100 px-2 py-1 text-xs font-semibold text-blue-700">คืนยอดแล้ว · รอเข้าชั้น</span>
                      ) : line.stock_action === 'waste' ? (
                        <span className="rounded-full bg-orange-100 px-2 py-1 text-xs font-semibold text-orange-700">ของเสีย/ไม่คืนสต๊อค</span>
                      ) : (
                        <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-700">รอตัดสินใจ</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-xs text-gray-600">
                      {line.stock_action_user?.username || line.shelf_return_user?.username || '-'}
                      {line.stock_action_at && (
                        <div className="mt-0.5 text-gray-400">{new Date(line.stock_action_at).toLocaleString('th-TH')}</div>
                      )}
                      {line.returned_to_shelf_at && (
                        <div className="mt-0.5 text-green-600">เข้าชั้น {new Date(line.returned_to_shelf_at).toLocaleString('th-TH')}</div>
                      )}
                      {line.status_before_cancel && (
                        <div className="mt-0.5 text-gray-400">ก่อนยกเลิก: {line.status_before_cancel}</div>
                      )}
                    </td>
                    <td className="w-[300px] min-w-[300px] px-3 py-3 text-center">
                      {!line.stock_action && canManageStock ? (
                        <div className="flex flex-nowrap justify-center gap-2">
                          <button type="button" disabled={actionLoading === line.id} onClick={() => void handleStockAction(line.id, 'not_picked')} className="whitespace-nowrap rounded-lg bg-slate-600 px-4 py-2 text-xs font-bold text-white hover:bg-slate-700 disabled:opacity-50">ไม่ได้หยิบ</button>
                          <button type="button" disabled={actionLoading === line.id} onClick={() => void handleStockAction(line.id, 'recall')} className="whitespace-nowrap rounded-lg bg-green-600 px-4 py-2 text-xs font-bold text-white hover:bg-green-700 disabled:opacity-50">คืนสต๊อค</button>
                          <button type="button" disabled={actionLoading === line.id} onClick={() => void handleStockAction(line.id, 'waste')} className="whitespace-nowrap rounded-lg bg-orange-600 px-4 py-2 text-xs font-bold text-white hover:bg-orange-700 disabled:opacity-50">ของเสีย</button>
                        </div>
                      ) : !line.stock_action ? <span className="text-xs text-gray-400">รอผู้มีสิทธิ์</span> : <span className="text-xs text-gray-400">ดำเนินการแล้ว</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-center border-t pt-4">
          <span className={`text-sm font-semibold ${pendingCount > 0 ? 'text-amber-700' : 'text-green-700'}`}>
            {pendingCount > 0 ? `รอตัดสินใจ ${pendingCount} รายการ` : lines.length > 0 ? 'ดำเนินการสต๊อคครบแล้ว' : ''}
          </span>
        </div>
      </div>
    </Modal>
  )
}
