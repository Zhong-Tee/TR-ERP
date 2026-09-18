import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../../lib/supabase'
import { enrichWmsNotificationsWithOrderDetails } from '../../../lib/wmsNotificationEnrichment'
import { fetchAllSupabasePages } from '../../../lib/supabasePagination'
import CancelledBillStockModal, { type CancelledBillSummary } from './CancelledBillStockModal'

const PAGE_SIZE = 50
type Tab = 'unread' | 'fixed' | 'cancel_pending' | 'cancel_shelf' | 'cancel_recalled' | 'cancel_waste'

const TAB_LABELS: Array<{ key: Tab; label: string }> = [
  { key: 'unread', label: 'รายการใหม่' },
  { key: 'fixed', label: 'แก้ไขแล้ว' },
  { key: 'cancel_pending', label: 'รอเลือกวิธีจัดการ' },
  { key: 'cancel_shelf', label: 'รอคืนเข้าชั้น' },
  { key: 'cancel_recalled', label: 'คืนคลังแล้ว' },
  { key: 'cancel_waste', label: 'ของเสีย' },
]

const isCancellationTab = (tab: Tab) => tab.startsWith('cancel_')

function matchesCancellationTab(row: any, tab: Tab): boolean {
  if (tab === 'cancel_pending') return Number(row.pendingCancelled || 0) > 0
  if (tab === 'cancel_shelf') return Number(row.awaitingShelf || 0) > 0
  if (tab === 'cancel_recalled') return Number(row.returnedToShelf || 0) > 0
  if (tab === 'cancel_waste') return Number(row.wasteCount || 0) > 0
  return false
}

function cancellationStatus(row: any, tab: Tab): { label: string; cls: string } {
  if (tab === 'cancel_pending') return { label: `รอตัดสินใจ ${row.pendingCancelled || 0} รายการ`, cls: 'bg-amber-100 text-amber-700' }
  if (tab === 'cancel_shelf') return { label: `คืนยอดแล้ว · รอเข้าชั้น ${row.awaitingShelf || 0} รายการ`, cls: 'bg-blue-100 text-blue-700' }
  if (tab === 'cancel_recalled') return { label: `คืนเข้าชั้นแล้ว ${row.returnedToShelf || 0} รายการ`, cls: 'bg-green-100 text-green-700' }
  return { label: `ของเสีย ${row.wasteCount || 0} รายการ`, cls: 'bg-orange-100 text-orange-700' }
}

function cancellationActors(row: any, tab: Tab): string {
  const names = tab === 'cancel_shelf'
    ? row.awaitingShelfActors
    : tab === 'cancel_recalled'
      ? row.returnedToShelfActors
      : tab === 'cancel_waste'
        ? row.wasteActors
        : []
  return Array.isArray(names) && names.length > 0 ? names.join(', ') : '-'
}

export default function NotificationSection() {
  const [currentTab, setCurrentTab] = useState<Tab>('unread')
  const [notifications, setNotifications] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [totalCount, setTotalCount] = useState(0)
  const [stockModal, setStockModal] = useState<{
    workOrderId: string
    displayName: string
    cancelledBills: CancelledBillSummary[]
  } | null>(null)
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadRequestRef = useRef(0)

  const loadNotifications = useCallback(async (tabOverride?: Tab) => {
    const requestId = ++loadRequestRef.current
    const tab = tabOverride ?? currentTab
    setLoading(true)
    try {
      if (isCancellationTab(tab)) {
        const allRows = await fetchAllSupabasePages<any>((from, to) => supabase
          .from('wms_notifications')
          .select('id, order_id, picker_id, type, status, is_read, created_at, us_users!picker_id(username)')
          .eq('type', 'ยกเลิกบิล')
          .order('created_at', { ascending: false })
          .range(from, to))
        const enriched = await enrichWmsNotificationsWithOrderDetails(supabase, allRows)
        const filtered = enriched.filter((row) => matchesCancellationTab(row, tab))
        if (requestId !== loadRequestRef.current) return
        setTotalCount(filtered.length)
        setNotifications(filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE))
      } else {
        const { data, error, count } = await supabase
          .from('wms_notifications')
          .select('id, order_id, picker_id, type, status, is_read, created_at, us_users!picker_id(username)', { count: 'exact' })
          .eq('status', tab)
          .neq('type', 'ยกเลิกบิล')
          .order('created_at', { ascending: false })
          .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)
        if (error) throw error
        const enriched = await enrichWmsNotificationsWithOrderDetails(supabase, data || [])
        if (requestId !== loadRequestRef.current) return
        setTotalCount(count || 0)
        setNotifications(enriched)
      }
    } catch (error) {
      console.error('loadNotifications:', error)
      if (requestId === loadRequestRef.current) {
        setNotifications([])
        setTotalCount(0)
      }
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false)
    }
  }, [currentTab, page])

  useEffect(() => {
    void loadNotifications()
    const scheduleReload = () => {
      if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current)
      reloadTimerRef.current = setTimeout(() => {
        void loadNotifications()
        window.dispatchEvent(new Event('wms-data-changed'))
      }, 300)
    }
    const channel = supabase
      .channel('wms-notifications-updates')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_notifications' }, scheduleReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_orders' }, scheduleReload)
      .subscribe()
    return () => {
      if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current)
      supabase.removeChannel(channel)
    }
  }, [loadNotifications])

  const markNotifRead = async (id: string) => {
    const { error } = await supabase.from('wms_notifications').update({ is_read: true }).eq('id', id)
    if (error) return alert(`อัปเดตไม่สำเร็จ: ${error.message}`)
    await loadNotifications()
    window.dispatchEvent(new Event('wms-data-changed'))
  }

  const markNotifFixed = async (id: string) => {
    const { error } = await supabase.from('wms_notifications').update({ status: 'fixed', is_read: true }).eq('id', id)
    if (error) return alert(`อัปเดตไม่สำเร็จ: ${error.message}`)
    await loadNotifications()
    window.dispatchEvent(new Event('wms-data-changed'))
  }

  const openCancellation = (row: any) => {
    if (!row.work_order_id) {
      alert('ไม่พบรหัสใบงาน กรุณาตรวจสอบข้อมูลใบงานนี้')
      return
    }
    setStockModal({
      workOrderId: row.work_order_id,
      displayName: row.order_id,
      cancelledBills: row.cancelled_orders || [],
    })
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))
  const cancellationView = isCancellationTab(currentTab)

  return (
    <section>
      <div className="mb-6 flex w-fit max-w-full flex-wrap gap-2 rounded-xl bg-gray-200 p-1">
        {TAB_LABELS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => { setPage(1); setCurrentTab(tab.key) }}
            className={`rounded-lg px-5 py-2 text-sm font-bold transition ${currentTab === tab.key ? 'tab-active' : ''}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-2xl border bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm text-slate-700">
            <thead className="border-b border-slate-200 bg-slate-50 font-semibold">
              <tr>
                <th className="p-4 text-center">ลำดับ</th>
                <th className="p-4">วัน-เวลา</th>
                <th className="p-4">พนักงาน</th>
                <th className="p-4">{cancellationView ? 'ใบงาน' : 'หัวข้อปัญหา'}</th>
                <th className="p-4">สินค้า/สถานะ</th>
                {cancellationView && <th className="p-4">ผู้ทำรายการ</th>}
                <th className="p-4">จุดจัดเก็บ</th>
                <th className="p-4 text-center">จัดการ</th>
              </tr>
            </thead>
            <tbody className="divide-y text-gray-600">
              {loading ? (
                <tr><td colSpan={cancellationView ? 8 : 7} className="p-12 text-center text-gray-400"><i className="fas fa-spinner fa-spin text-2xl" /> <span className="ml-2">กำลังโหลดรายการ...</span></td></tr>
              ) : notifications.length === 0 ? (
                <tr><td colSpan={cancellationView ? 8 : 7} className="p-12 text-center text-gray-400">ไม่มีรายการ</td></tr>
              ) : notifications.map((row, index) => {
                const status = cancellationView ? cancellationStatus(row, currentTab) : null
                return (
                  <tr key={row.id} className={!row.is_read && !cancellationView ? 'bg-blue-50' : ''}>
                    <td className="p-4 text-center text-base">{(page - 1) * PAGE_SIZE + index + 1}</td>
                    <td className="p-4 text-base">{new Date(row.created_at).toLocaleString('th-TH')}</td>
                    <td className="p-4 text-base font-bold text-blue-600">{row.us_users?.username || '-'}</td>
                    <td className={`p-4 text-base font-bold ${cancellationView ? 'text-slate-800' : 'text-red-600'}`}>
                      {cancellationView ? row.order_id : row.type}
                    </td>
                    <td className="p-4 text-base">
                      {status ? <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${status.cls}`}>{status.label}</span> : row.product_name}
                    </td>
                    {cancellationView && <td className="p-4 text-base font-semibold text-slate-700">{cancellationActors(row, currentTab)}</td>}
                    <td className="p-4 text-base font-bold text-red-600">{row.location || '-'}</td>
                    <td className="p-4 text-center">
                      {cancellationView ? (
                        <button type="button" onClick={() => openCancellation(row)} className={`rounded-lg px-4 py-2 text-xs font-black text-white ${currentTab === 'cancel_pending' ? 'bg-amber-500 hover:bg-amber-600' : 'bg-slate-600 hover:bg-slate-700'}`}>
                          {currentTab === 'cancel_pending' ? 'ปรับสต๊อก' : 'ดูประวัติ'}
                        </button>
                      ) : (
                        <div className="flex items-center justify-center gap-2">
                          {!row.is_read && <button type="button" onClick={() => void markNotifRead(row.id)} className="rounded-lg bg-slate-200 px-4 py-2 text-xs font-black hover:bg-slate-300">อ่านแล้ว</button>}
                          {currentTab === 'unread'
                            ? <button type="button" onClick={() => void markNotifFixed(row.id)} className="rounded-lg bg-green-600 px-4 py-2 text-xs font-black text-white hover:bg-green-700">แก้ไขแล้ว</button>
                            : <span className="font-bold text-green-500">✔ Fixed</span>}
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
          <span className="text-gray-500">แสดง {notifications.length} จาก {totalCount} รายการ</span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1} className="rounded-lg border px-3 py-1.5 font-bold disabled:opacity-40">ก่อนหน้า</button>
            <span className="font-semibold">หน้า {page} / {totalPages}</span>
            <button type="button" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={page >= totalPages} className="rounded-lg border px-3 py-1.5 font-bold disabled:opacity-40">ถัดไป</button>
          </div>
        </div>
      </div>

      <CancelledBillStockModal
        open={!!stockModal}
        workOrderId={stockModal?.workOrderId || null}
        displayName={stockModal?.displayName || ''}
        cancelledBills={stockModal?.cancelledBills || []}
        onClose={() => setStockModal(null)}
        onChanged={() => void loadNotifications()}
      />
    </section>
  )
}
