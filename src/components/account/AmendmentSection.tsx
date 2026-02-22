import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../lib/supabase'
import { Order } from '../../types'
import { useAuthContext } from '../../contexts/AuthContext'
import { useMenuAccess } from '../../contexts/MenuAccessContext'
import { formatDateTime } from '../../lib/utils'
import Modal from '../ui/Modal'

type Props = {
  orderToAmend?: Order & { order_items?: any[] }
  onDone?: () => void
}

type AmendmentRow = {
  id: string
  amendment_no: string
  order_id: string
  bill_no: string | null
  reason_type: string
  reason_detail: string | null
  status: string
  requested_by: string | null
  approved_by: string | null
  rejected_reason: string | null
  changes_json: Record<string, unknown> | null
  items_before: unknown[] | null
  items_after: unknown[] | null
  created_at: string
  approved_at: string | null
  executed_at: string | null
  requested_by_user?: { username: string | null; email: string | null } | null
}

const REASON_OPTIONS: { value: string; label: string }[] = [
  { value: 'staff_error', label: 'พนักงานลงผิด' },
  { value: 'customer_change', label: 'ลูกค้าขอเปลี่ยน' },
]

export default function AmendmentSection({ orderToAmend, onDone }: Props) {
  const { user } = useAuthContext()
  const { hasAccess } = useMenuAccess()

  const [amendments, setAmendments] = useState<AmendmentRow[]>([])
  const [amendmentsLoading, setAmendmentsLoading] = useState(false)
  const [detailAmendment, setDetailAmendment] = useState<AmendmentRow | null>(null)
  const [detailModalOpen, setDetailModalOpen] = useState(false)
  const [detailOrder, setDetailOrder] = useState<any>(null)
  const [detailOrderLoading, setDetailOrderLoading] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const [rejectModalOpen, setRejectModalOpen] = useState(false)
  const [actionSubmitting, setActionSubmitting] = useState(false)
  const [resultModal, setResultModal] = useState<{ open: boolean; success: boolean; message: string }>({ open: false, success: false, message: '' })

  const [reasonType, setReasonType] = useState<string>('staff_error')
  const [reasonDetail, setReasonDetail] = useState('')
  const [submitLoading, setSubmitLoading] = useState(false)

  const isCreateMode = !!orderToAmend
  const isApproverRole = user?.role === 'superadmin' || user?.role === 'admin'
  const canApprove = hasAccess('account-amendment-approve') || isApproverRole

  const loadAmendments = useCallback(async () => {
    setAmendmentsLoading(true)
    try {
      const { data, error } = await supabase
        .from('or_order_amendments')
        .select('*, requested_by_user:us_users!requested_by(username, email)')
        .order('created_at', { ascending: false })
        .limit(50)
      if (error) throw error
      setAmendments((data || []) as AmendmentRow[])
    } catch (e) {
      console.error(e)
      setAmendments([])
    } finally {
      setAmendmentsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!isCreateMode) loadAmendments()
  }, [isCreateMode, loadAmendments])

  const handleSubmitCancellation = async () => {
    if (!orderToAmend || !user?.id) return
    setSubmitLoading(true)
    try {
      const { data, error } = await supabase.rpc('rpc_submit_amendment', {
        p_order_id: orderToAmend.id,
        p_reason_type: reasonType,
        p_reason_detail: reasonDetail.trim() || null,
        p_changes_json: {},
        p_items_after: [],
        p_user_id: user.id,
      })
      if (error) throw error
      setResultModal({ open: true, success: true, message: `ส่งคำขอยกเลิกบิลสำเร็จ เลขที่ ${(data as any)?.amendment_no ?? '-'}\nรออนุมัติจาก superadmin / admin` })
      onDone?.()
    } catch (e: any) {
      setResultModal({ open: true, success: false, message: e?.message || 'ส่งคำขอยกเลิกไม่สำเร็จ' })
    } finally {
      setSubmitLoading(false)
    }
  }

  const handleApprove = async () => {
    if (!detailAmendment || !user?.id || !canApprove) return
    setActionSubmitting(true)
    try {
      const { data, error } = await supabase.rpc('rpc_approve_amendment', {
        p_amendment_id: detailAmendment.id,
        p_approver_id: user.id,
      })
      if (error) throw error
      const result = data as any
      setResultModal({
        open: true,
        success: true,
        message: `ยกเลิกบิลสำเร็จ (${result?.bill_no || detailAmendment.bill_no || '-'})\nWMS ที่ยกเลิก: ${result?.cancelled_wms_count ?? 0} รายการ\n\nกรุณาสร้างบิลใหม่ในหน้าออเดอร์`,
      })
      setDetailModalOpen(false)
      setDetailAmendment(null)
      loadAmendments()
      onDone?.()
    } catch (e: any) {
      setResultModal({ open: true, success: false, message: e?.message || 'อนุมัติไม่สำเร็จ' })
    } finally {
      setActionSubmitting(false)
    }
  }

  const handleRejectSubmit = async () => {
    if (!detailAmendment || !user?.id || !canApprove) return
    setActionSubmitting(true)
    try {
      const { error } = await supabase.rpc('rpc_reject_amendment', {
        p_amendment_id: detailAmendment.id,
        p_approver_id: user.id,
        p_reason: rejectReason.trim() || 'ปฏิเสธโดยผู้มีสิทธิ์',
      })
      if (error) throw error
      setResultModal({ open: true, success: true, message: 'ปฏิเสธคำขอยกเลิกแล้ว' })
      setRejectModalOpen(false)
      setDetailModalOpen(false)
      setDetailAmendment(null)
      setRejectReason('')
      loadAmendments()
      onDone?.()
    } catch (e: any) {
      setResultModal({ open: true, success: false, message: e?.message || 'ปฏิเสธไม่สำเร็จ' })
    } finally {
      setActionSubmitting(false)
    }
  }

  const loadDetailOrder = useCallback(async (orderId: string) => {
    setDetailOrderLoading(true)
    try {
      const { data, error } = await supabase
        .from('or_orders')
        .select('*, or_order_items(*)')
        .eq('id', orderId)
        .single()
      if (error) throw error
      setDetailOrder(data)
    } catch (e) {
      console.error('Error loading order detail:', e)
      setDetailOrder(null)
    } finally {
      setDetailOrderLoading(false)
    }
  }, [])

  const openDetail = (row: AmendmentRow) => {
    setDetailAmendment(row)
    setDetailModalOpen(true)
    setRejectReason('')
    loadDetailOrder(row.order_id)
  }

  const reasonLabel = (rt: string) =>
    REASON_OPTIONS.find((o) => o.value === rt)?.label ?? rt

  const statusBadge = (status: string) => {
    const map: Record<string, string> = {
      pending: 'bg-amber-100 text-amber-800',
      executed: 'bg-emerald-100 text-emerald-800',
      approved: 'bg-emerald-100 text-emerald-800',
      rejected: 'bg-red-100 text-red-800',
    }
    const labels: Record<string, string> = {
      pending: 'รออนุมัติ',
      executed: 'ยกเลิกแล้ว',
      approved: 'อนุมัติแล้ว',
      rejected: 'ปฏิเสธ',
    }
    return (
      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${map[status] ?? 'bg-gray-100 text-gray-700'}`}>
        {labels[status] ?? status}
      </span>
    )
  }

  // ──────── Create Mode: ขอยกเลิกบิล ────────
  if (isCreateMode && orderToAmend) {
    const items = orderToAmend.order_items || (orderToAmend as any).or_order_items || []
    return (
      <div className="space-y-4">
        <div className="bg-white rounded-xl border border-surface-200 shadow-sm p-4">
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <span className="font-semibold text-gray-600">บิล:</span>
            <span className="font-mono font-bold text-blue-600">{orderToAmend.bill_no}</span>
            <span className="text-gray-400">|</span>
            <span className="font-semibold text-gray-600">ลูกค้า:</span>
            <span className="text-gray-800">{orderToAmend.customer_name}</span>
            <span className="text-gray-400">|</span>
            <span className="font-semibold text-gray-600">สถานะ:</span>
            <span>{orderToAmend.status}</span>
            <span className="text-gray-400">|</span>
            <span className="font-semibold text-gray-600">ยอดรวม:</span>
            <span>{Number(orderToAmend.total_amount ?? 0).toLocaleString('th-TH', { minimumFractionDigits: 2 })} บาท</span>
          </div>
        </div>

        {items.length > 0 && (
          <div className="bg-white rounded-xl border border-surface-200 shadow-sm p-4">
            <h4 className="text-sm font-semibold text-gray-700 mb-3">รายการสินค้าในบิล (อ่านอย่างเดียว)</h4>
            <div className="overflow-x-auto border border-gray-200 rounded-lg">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-left text-gray-600">
                    <th className="px-3 py-2 font-semibold">#</th>
                    <th className="px-3 py-2 font-semibold">ชื่อสินค้า</th>
                    <th className="px-3 py-2 font-semibold w-24">จำนวน</th>
                    <th className="px-3 py-2 font-semibold w-28">ราคา/หน่วย</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {items.map((item: any, i: number) => (
                    <tr key={item.id || i} className="text-gray-700">
                      <td className="px-3 py-2 text-gray-400">{i + 1}</td>
                      <td className="px-3 py-2">{item.product_name || '-'}</td>
                      <td className="px-3 py-2">{item.quantity ?? '-'}</td>
                      <td className="px-3 py-2">{item.unit_price != null ? Number(item.unit_price).toLocaleString('th-TH') : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="bg-white rounded-xl border border-surface-200 shadow-sm p-6 space-y-6">
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm">
            <p className="font-semibold text-amber-800 mb-1">
              <i className="fas fa-exclamation-triangle mr-1"></i>
              ยืนยันการขอยกเลิกบิลนี้
            </p>
            <p className="text-amber-700">
              บิลจะถูกยกเลิกหลังจากได้รับการอนุมัติ สินค้าที่จัดไปแล้วจะรอหัวหน้าแผนกดำเนินการ
              คุณสามารถสร้างบิลใหม่ได้ในหน้าออเดอร์หลังจากยกเลิกสำเร็จ
            </p>
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1">ประเภทเหตุผล</label>
            <select
              value={reasonType}
              onChange={(e) => setReasonType(e.target.value)}
              className="w-full max-w-xs border border-gray-200 rounded-lg px-3 py-2 bg-white text-sm"
            >
              {REASON_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1">รายละเอียดเหตุผล</label>
            <textarea
              value={reasonDetail}
              onChange={(e) => setReasonDetail(e.target.value)}
              rows={3}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
              placeholder="อธิบายสั้นๆ ว่าทำไมต้องยกเลิกบิลนี้"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => onDone?.()}
              className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-semibold text-gray-600 hover:bg-gray-50"
            >
              ย้อนกลับ
            </button>
            <button
              type="button"
              onClick={handleSubmitCancellation}
              disabled={submitLoading}
              className="px-6 py-2 bg-red-600 text-white rounded-lg text-sm font-bold hover:bg-red-700 disabled:opacity-50 flex items-center gap-2"
            >
              {submitLoading ? <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" /> : <i className="fas fa-ban" />}
              ส่งคำขอยกเลิกบิล
            </button>
          </div>
        </div>

        <Modal open={resultModal.open} onClose={() => setResultModal((m) => ({ ...m, open: false }))} contentClassName="max-w-md">
          <div className="p-6">
            <div className={`flex items-center gap-3 mb-4 ${resultModal.success ? 'text-emerald-600' : 'text-red-600'}`}>
              <i className={`fas ${resultModal.success ? 'fa-check-circle' : 'fa-exclamation-circle'} text-2xl`} />
              <p className="font-semibold">{resultModal.success ? 'สำเร็จ' : 'เกิดข้อผิดพลาด'}</p>
            </div>
            <p className="text-gray-700 text-sm whitespace-pre-line">{resultModal.message}</p>
            <div className="mt-4 flex justify-end">
              <button
                onClick={() => setResultModal((m) => ({ ...m, open: false }))}
                className="px-4 py-2 rounded-lg bg-gray-100 text-gray-700 font-medium hover:bg-gray-200"
              >
                ปิด
              </button>
            </div>
          </div>
        </Modal>
      </div>
    )
  }

  // ──────── List Mode: รายการคำขอยกเลิก ────────
  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-surface-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-surface-200 bg-surface-50/50">
          <h2 className="text-lg font-semibold text-gray-800">
            <i className="fas fa-ban mr-2 text-red-500" />
            คำขอยกเลิกบิล
          </h2>
          <p className="text-sm text-gray-500 mt-0.5">รายการคำขอยกเลิก (ล่าสุด 50 รายการ)</p>
        </div>
        {amendmentsLoading ? (
          <div className="flex justify-center py-12">
            <span className="animate-spin rounded-full h-8 w-8 border-2 border-blue-500 border-t-transparent" />
          </div>
        ) : amendments.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <i className="fas fa-inbox text-4xl mb-3 block" />
            <p>ไม่มีรายการคำขอยกเลิก</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left text-gray-600">
                  <th className="px-4 py-3 font-semibold">เลขที่คำขอ</th>
                  <th className="px-4 py-3 font-semibold">เลขบิล</th>
                  <th className="px-4 py-3 font-semibold">เหตุผล</th>
                  <th className="px-4 py-3 font-semibold">สถานะ</th>
                  <th className="px-4 py-3 font-semibold">ผู้ขอ</th>
                  <th className="px-4 py-3 font-semibold">วันที่ขอ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {amendments.map((row) => (
                  <tr
                    key={row.id}
                    className="hover:bg-blue-50/50 cursor-pointer transition-colors"
                    onClick={() => openDetail(row)}
                  >
                    <td className="px-4 py-3 font-mono text-blue-600 font-semibold">{row.amendment_no}</td>
                    <td className="px-4 py-3 font-mono">{row.bill_no ?? '-'}</td>
                    <td className="px-4 py-3">{reasonLabel(row.reason_type)}</td>
                    <td className="px-4 py-3">{statusBadge(row.status)}</td>
                    <td className="px-4 py-3">{(row.requested_by_user?.username || row.requested_by_user?.email || row.requested_by) ?? '-'}</td>
                    <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{formatDateTime(row.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Detail Modal */}
      <Modal open={detailModalOpen} onClose={() => { setDetailModalOpen(false); setDetailAmendment(null); setDetailOrder(null) }} contentClassName="max-w-4xl max-h-[90vh] overflow-y-auto">
        {detailAmendment && (
          <div className="p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-gray-200 pb-3">
              <h3 className="text-lg font-bold text-gray-800">
                <i className="fas fa-ban mr-2 text-red-500" />
                {detailAmendment.amendment_no}
              </h3>
              {statusBadge(detailAmendment.status)}
            </div>

            {/* ข้อมูลคำขอยกเลิก */}
            <div className="bg-gray-50 rounded-lg p-4">
              <h4 className="text-sm font-semibold text-gray-700 mb-2">ข้อมูลคำขอยกเลิก</h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2 text-sm">
                <div>
                  <span className="text-gray-500 block">เลขบิล</span>
                  <span className="font-mono font-bold text-blue-600">{detailAmendment.bill_no ?? '-'}</span>
                </div>
                <div>
                  <span className="text-gray-500 block">ประเภทเหตุผล</span>
                  <span className="font-semibold">{reasonLabel(detailAmendment.reason_type)}</span>
                </div>
                <div>
                  <span className="text-gray-500 block">ผู้ขอ</span>
                  <span>{(detailAmendment.requested_by_user?.username || detailAmendment.requested_by_user?.email || detailAmendment.requested_by) ?? '-'}</span>
                </div>
                <div>
                  <span className="text-gray-500 block">วันที่ขอ</span>
                  <span>{formatDateTime(detailAmendment.created_at)}</span>
                </div>
                {detailAmendment.reason_detail && (
                  <div className="col-span-2 md:col-span-4">
                    <span className="text-gray-500 block">รายละเอียดเหตุผล</span>
                    <span>{detailAmendment.reason_detail}</span>
                  </div>
                )}
                {detailAmendment.approved_at && (
                  <div>
                    <span className="text-gray-500 block">วันที่ดำเนินการ</span>
                    <span>{formatDateTime(detailAmendment.approved_at)}</span>
                  </div>
                )}
                {detailAmendment.rejected_reason && (
                  <div className="col-span-2 md:col-span-4">
                    <span className="text-gray-500 block">เหตุผลการปฏิเสธ</span>
                    <span className="text-red-600 font-semibold">{detailAmendment.rejected_reason}</span>
                  </div>
                )}
              </div>
            </div>

            {/* ข้อมูลบิลละเอียด */}
            {detailOrderLoading ? (
              <div className="flex justify-center py-6">
                <span className="animate-spin rounded-full h-6 w-6 border-2 border-blue-500 border-t-transparent" />
              </div>
            ) : detailOrder ? (
              <div className="bg-blue-50 rounded-lg p-4">
                <h4 className="text-sm font-semibold text-blue-800 mb-2">
                  <i className="fas fa-file-invoice mr-1" />
                  ข้อมูลบิล
                </h4>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2 text-sm">
                  <div>
                    <span className="text-gray-500 block">ช่องทาง</span>
                    <span className="font-semibold">{detailOrder.channel_code || '-'}</span>
                  </div>
                  <div>
                    <span className="text-gray-500 block">สถานะ</span>
                    <span className="font-semibold">{detailOrder.status || '-'}</span>
                  </div>
                  <div>
                    <span className="text-gray-500 block">ยอดรวม</span>
                    <span className="font-bold text-green-700">{Number(detailOrder.total_amount ?? 0).toLocaleString('th-TH', { minimumFractionDigits: 2 })} บาท</span>
                  </div>
                  <div>
                    <span className="text-gray-500 block">ใบสั่งงาน</span>
                    <span className="font-mono">{detailOrder.work_order_name || '-'}</span>
                  </div>
                  <div className="col-span-2">
                    <span className="text-gray-500 block">ชื่อลูกค้า</span>
                    <span className="font-semibold">{detailOrder.customer_name || '-'}</span>
                  </div>
                  <div className="col-span-2">
                    <span className="text-gray-500 block">ที่อยู่ลูกค้า</span>
                    <span className="text-gray-700">{detailOrder.customer_address || '-'}</span>
                  </div>
                  {detailOrder.recipient_name && (
                    <div>
                      <span className="text-gray-500 block">ชื่อผู้รับ</span>
                      <span>{detailOrder.recipient_name}</span>
                    </div>
                  )}
                  {detailOrder.payment_method && (
                    <div>
                      <span className="text-gray-500 block">วิธีชำระเงิน</span>
                      <span>{detailOrder.payment_method}</span>
                    </div>
                  )}
                  {(detailOrder.shipping_cost != null && Number(detailOrder.shipping_cost) > 0) && (
                    <div>
                      <span className="text-gray-500 block">ค่าขนส่ง</span>
                      <span>{Number(detailOrder.shipping_cost).toLocaleString('th-TH', { minimumFractionDigits: 2 })}</span>
                    </div>
                  )}
                  {(detailOrder.discount != null && Number(detailOrder.discount) > 0) && (
                    <div>
                      <span className="text-gray-500 block">ส่วนลด</span>
                      <span>{Number(detailOrder.discount).toLocaleString('th-TH', { minimumFractionDigits: 2 })}</span>
                    </div>
                  )}
                  {detailOrder.promotion && (
                    <div>
                      <span className="text-gray-500 block">โปรโมชั่น</span>
                      <span>{detailOrder.promotion}</span>
                    </div>
                  )}
                  {detailOrder.confirm_note && (
                    <div className="col-span-2 md:col-span-4">
                      <span className="text-gray-500 block">หมายเหตุคอนเฟิร์ม</span>
                      <span>{detailOrder.confirm_note}</span>
                    </div>
                  )}
                </div>
              </div>
            ) : null}

            {/* รายการสินค้า */}
            {(() => {
              const items = detailOrder?.or_order_items || (detailAmendment.items_before && Array.isArray(detailAmendment.items_before) ? detailAmendment.items_before : [])
              if (!items || items.length === 0) return null
              return (
                <div>
                  <h4 className="text-sm font-semibold text-gray-700 mb-2">
                    <i className="fas fa-boxes mr-1 text-gray-500" />
                    รายการสินค้าในบิล ({items.length} รายการ)
                  </h4>
                  <div className="border border-gray-200 rounded-lg overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-gray-50">
                          <th className="px-3 py-2 text-left font-semibold text-gray-600">#</th>
                          <th className="px-3 py-2 text-left font-semibold text-gray-600">ชื่อสินค้า</th>
                          <th className="px-3 py-2 text-center font-semibold text-gray-600">จำนวน</th>
                          <th className="px-3 py-2 text-right font-semibold text-gray-600">ราคา/หน่วย</th>
                          <th className="px-3 py-2 text-left font-semibold text-gray-600">สีหมึก</th>
                          <th className="px-3 py-2 text-left font-semibold text-gray-600">ลายการ์ตูน</th>
                          <th className="px-3 py-2 text-left font-semibold text-gray-600">ฟอนต์</th>
                          <th className="px-3 py-2 text-left font-semibold text-gray-600">ข้อความ</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {items.map((item: any, i: number) => (
                          <tr key={item?.id || i} className="hover:bg-gray-50/50">
                            <td className="px-3 py-2 text-gray-400">{i + 1}</td>
                            <td className="px-3 py-2 font-medium text-gray-800 max-w-[200px]">
                              {item?.product_name ?? '-'}
                              {item?.product_type && <span className="ml-1 text-xs text-gray-400">({item.product_type})</span>}
                            </td>
                            <td className="px-3 py-2 text-center font-semibold">{item?.quantity ?? '-'}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{item?.unit_price != null ? Number(item.unit_price).toLocaleString('th-TH') : '-'}</td>
                            <td className="px-3 py-2 text-gray-700">{item?.ink_color || '-'}</td>
                            <td className="px-3 py-2 text-gray-700">{item?.cartoon_pattern || '-'}</td>
                            <td className="px-3 py-2 text-gray-700">{item?.font || '-'}</td>
                            <td className="px-3 py-2 text-gray-700 max-w-[200px]">
                              {[item?.line_1, item?.line_2, item?.line_3].filter(Boolean).join(' / ') || '-'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {items.some((it: any) => it?.notes || it?.file_attachment) && (
                    <div className="mt-2 space-y-1">
                      {items.map((it: any, i: number) => (
                        (it?.notes || it?.file_attachment) ? (
                          <div key={i} className="text-xs text-gray-500 bg-gray-50 rounded px-2 py-1">
                            <span className="font-semibold">#{i + 1} {it.product_name}:</span>
                            {it.notes && <span className="ml-1">หมายเหตุ: {it.notes}</span>}
                            {it.file_attachment && <span className="ml-1">[มีไฟล์แนบ]</span>}
                          </div>
                        ) : null
                      ))}
                    </div>
                  )}
                </div>
              )
            })()}

            <div className="flex gap-2 pt-2 border-t border-gray-200">
              {canApprove && detailAmendment.status === 'pending' && (
                <>
                  <button
                    type="button"
                    onClick={handleApprove}
                    disabled={actionSubmitting}
                    className="px-4 py-2 rounded-lg bg-red-600 text-white font-semibold hover:bg-red-700 disabled:opacity-50 flex items-center gap-2"
                  >
                    {actionSubmitting ? <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" /> : <i className="fas fa-check" />}
                    อนุมัติยกเลิกบิล
                  </button>
                  <button
                    type="button"
                    onClick={() => setRejectModalOpen(true)}
                    disabled={actionSubmitting}
                    className="px-4 py-2 rounded-lg border border-red-300 text-red-600 font-semibold hover:bg-red-50 disabled:opacity-50"
                  >
                    <i className="fas fa-times mr-1" /> ปฏิเสธ
                  </button>
                </>
              )}
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => { setDetailModalOpen(false); setDetailAmendment(null); setDetailOrder(null) }}
                className="px-4 py-2 rounded-lg border border-gray-300 text-gray-600 font-semibold hover:bg-gray-50"
              >
                ปิด
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Reject Modal */}
      <Modal open={rejectModalOpen} onClose={() => setRejectModalOpen(false)} contentClassName="max-w-md">
        <div className="p-6">
          <h3 className="text-lg font-semibold text-gray-800 mb-2">เหตุผลในการปฏิเสธ</h3>
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={3}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-4"
            placeholder="ระบุเหตุผล (ถ้าไม่กรอกจะใช้ข้อความเริ่มต้น)"
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => setRejectModalOpen(false)} className="px-4 py-2 rounded-lg border border-gray-300 text-gray-600 font-medium hover:bg-gray-50">
              ยกเลิก
            </button>
            <button onClick={handleRejectSubmit} disabled={actionSubmitting} className="px-4 py-2 rounded-lg bg-red-600 text-white font-semibold hover:bg-red-700 disabled:opacity-50">
              {actionSubmitting ? <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent inline-block" /> : 'ยืนยันปฏิเสธ'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Result Modal */}
      <Modal open={resultModal.open} onClose={() => setResultModal((m) => ({ ...m, open: false }))} contentClassName="max-w-md">
        <div className="p-6">
          <div className={`flex items-center gap-3 mb-4 ${resultModal.success ? 'text-emerald-600' : 'text-red-600'}`}>
            <i className={`fas ${resultModal.success ? 'fa-check-circle' : 'fa-exclamation-circle'} text-2xl`} />
            <p className="font-semibold">{resultModal.success ? 'สำเร็จ' : 'เกิดข้อผิดพลาด'}</p>
          </div>
          <p className="text-gray-700 text-sm whitespace-pre-line">{resultModal.message}</p>
          <div className="mt-4 flex justify-end">
            <button onClick={() => setResultModal((m) => ({ ...m, open: false }))} className="px-4 py-2 rounded-lg bg-gray-100 text-gray-700 font-medium hover:bg-gray-200">
              ปิด
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
