import { useEffect, useState } from 'react'
import { supabase } from '../../../lib/supabase'
import { sortOrderItemsForBillDisplay } from '../../../lib/orderItemExportSort'
import { FULFILLMENT_EXCLUDED_ORDER_STATUSES_IN } from '../../../lib/orderFlowFilter'
import type { OrderItem } from '../../../types'
import Modal from '../../ui/Modal'
import ModalCloseButton from '../../ui/ModalCloseButton'

type Bill = { id: string; bill_no: string | null; customer_name: string; status: string; or_order_items: OrderItem[] }

export default function NewWorkOrderViewModal({ workOrder, onClose }: {
  workOrder: { id: string; work_order_name: string }; onClose: () => void
}) {
  const [bills, setBills] = useState<Bill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    void (async () => {
      try {
        const result = await supabase.from('or_orders')
          .select('id,bill_no,customer_name,status,or_order_items(*)')
          .eq('work_order_id', workOrder.id)
          .not('status', 'in', FULFILLMENT_EXCLUDED_ORDER_STATUSES_IN)
          .neq('status', 'จัดส่งแล้ว')
          .order('created_at', { ascending: true }).order('id')
        if (result.error) throw result.error
        if (active) setBills((result.data || []) as Bill[])
      } catch {
        if (active) setError('ไม่สามารถโหลดรายละเอียดใบงานได้ กรุณาปิดแล้วเปิดใหม่')
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [workOrder.id])

  return <Modal open onClose={onClose} closeOnBackdropClick showCloseButton={false} contentClassName="max-w-6xl">
    <div className="p-6">
      <div className="flex items-start justify-between gap-4 mb-5">
        <div><h3 className="text-xl font-bold">ใบงาน {workOrder.work_order_name}</h3><p className="text-sm text-slate-500 mt-1">ดูอย่างเดียว · รายละเอียดบิลและรายการสินค้า</p></div>
        <ModalCloseButton onClick={onClose} />
      </div>
      {loading ? <p className="py-8 text-center text-slate-500">กำลังโหลด...</p> : error ? <p role="alert" className="py-8 text-center text-red-600">{error}</p> : bills.length === 0 ? <p className="py-8 text-center text-slate-500">ไม่มีบิลที่รอดำเนินการในใบงานนี้</p> :
        <div className="space-y-5 max-h-[70vh] overflow-y-auto">
          {bills.map(bill => <section key={bill.id} className="rounded-lg border overflow-hidden">
            <div className="bg-slate-100 px-4 py-3"><h4 className="font-bold">{bill.bill_no || '-'} · {bill.customer_name || '-'}</h4><p className="text-sm text-slate-600">{bill.status}</p></div>
            <div className="overflow-x-auto"><table className="w-full text-sm text-left">
              <thead className="bg-slate-50"><tr>{['UID', 'สินค้า', 'สีหมึก', 'ลาย', 'เส้น', 'ฟอนต์', 'ข้อความ', 'จำนวน', 'หมายเหตุ'].map(label => <th key={label} className="px-3 py-2 whitespace-nowrap">{label}</th>)}</tr></thead>
              <tbody className="divide-y">{sortOrderItemsForBillDisplay(bill.or_order_items || []).map(item => <tr key={item.id}>
                <td className="px-3 py-2 whitespace-nowrap">{item.item_uid || '-'}</td><td className="px-3 py-2">{item.product_name}</td>
                <td className="px-3 py-2">{item.ink_color || '-'}</td><td className="px-3 py-2">{item.cartoon_pattern || '-'}</td><td className="px-3 py-2">{item.line_pattern || '-'}</td><td className="px-3 py-2">{item.font || '-'}</td>
                <td className="px-3 py-2 whitespace-pre-wrap">{[item.line_1,item.line_2,item.line_3].filter(Boolean).join('\n') || '-'}</td><td className="px-3 py-2 text-right">{item.quantity}</td><td className="px-3 py-2 whitespace-pre-wrap">{item.notes || '-'}</td>
              </tr>)}</tbody>
            </table></div>
          </section>)}
        </div>}
    </div>
  </Modal>
}
