import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../../lib/supabase'
import { useAuthContext } from '../../../contexts/AuthContext'
import { isAdminOrSuperadmin } from '../../../config/accessPolicy'
import Modal from '../../ui/Modal'
import { enrichWmsNotificationsWithOrderDetails } from '../../../lib/wmsNotificationEnrichment'

export default function NotificationSection() {
  const { user } = useAuthContext()
  const canManageStock = isAdminOrSuperadmin(user?.role)
  const [currentTab, setCurrentTab] = useState('unread')
  const [notifications, setNotifications] = useState<any[]>([])
  const [stockModalOrderId, setStockModalOrderId] = useState<string | null>(null)
  const [stockModalCancelledOrders, setStockModalCancelledOrders] = useState<{ id: string; bill_no: string; customer_name: string }[]>([])
  const [selectedCancelledOrderId, setSelectedCancelledOrderId] = useState<string | null>(null)
  const [cancelledLines, setCancelledLines] = useState<any[]>([])
  const [cancelledLoading, setCancelledLoading] = useState(false)
  const [stockActionLoading, setStockActionLoading] = useState<string | null>(null)

  useEffect(() => {
    loadNotifications()

    const channel = supabase
      .channel('wms-notifications-updates')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_notifications' }, () => {
        loadNotifications()
        window.dispatchEvent(new Event('wms-data-changed'))
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [currentTab])

  const normalizeOrderKey = (value: unknown) =>
    String(value || '')
      .normalize('NFKC')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/[\u2010-\u2015]/g, '-')
      .replace(/\s+/g, '')
      .trim()
      .toUpperCase()

  /** แถวยกเลิกบิลหลายแถวอาจมี order_id ต่างกันเล็กน้อย — เทียบแบบ normalize แล้วคืน id ที่ยัง status=unread */
  const getUnreadCancelNotificationIdsForGroup = async (orderIdRaw: string | null | undefined): Promise<string[]> => {
    const targetNorm = normalizeOrderKey(orderIdRaw)
    if (!targetNorm) return []
    const { data, error } = await supabase
      .from('wms_notifications')
      .select('id, order_id')
      .eq('type', 'ยกเลิกบิล')
      .eq('status', 'unread')
    if (error) throw error
    return (data || [])
      .filter((r) => normalizeOrderKey((r as { order_id?: string }).order_id) === targetNorm)
      .map((r) => (r as { id: string }).id)
  }

  const getCancelledOrderProductCodes = useCallback(async (orderId: string): Promise<string[]> => {
    const { data: items } = await supabase
      .from('or_order_items')
      .select('product_id')
      .eq('order_id', orderId)
    const productIds = [...new Set((items || []).map((i: any) => i.product_id).filter(Boolean))]
    if (productIds.length === 0) return []

    const { data: products } = await supabase
      .from('pr_products')
      .select('id, product_code')
      .in('id', productIds)
    return [...new Set((products || []).map((p: any) => String(p.product_code || '').trim()).filter(Boolean))]
  }, [])

  const loadCancelledLines = useCallback(async (workOrderId: string, orderId?: string) => {
    setCancelledLoading(true)
    setStockModalOrderId(workOrderId)
    try {
      const { data: cancelledOrders } = await supabase
        .from('or_orders')
        .select('id, bill_no, customer_name')
        .eq('work_order_name', workOrderId)
        .eq('status', 'ยกเลิก')
        .order('created_at', { ascending: false })
      const orders = (cancelledOrders || []) as { id: string; bill_no: string; customer_name: string }[]
      setStockModalCancelledOrders(orders)

      const targetOrderId = orderId || orders[0]?.id || null
      setSelectedCancelledOrderId(targetOrderId)
      if (!targetOrderId) {
        setCancelledLines([])
        return
      }

      const targetCodes = await getCancelledOrderProductCodes(targetOrderId)
      if (targetCodes.length === 0) {
        setCancelledLines([])
        return
      }

      const targetNorm = normalizeOrderKey(workOrderId)
      let rows: any[] = []

      const { data: exactData } = await supabase
        .from('wms_orders')
        .select('id, order_id, product_code, product_name, location, qty, status, stock_action')
        .eq('order_id', workOrderId)
        .eq('status', 'cancelled')

      rows = exactData || []

      // Fallback: ดึง cancelled ทั้งหมดแล้วเทียบ key แบบ normalize
      if (rows.length === 0) {
        const { data: fallback } = await supabase
          .from('wms_orders')
          .select('id, order_id, product_code, product_name, location, qty, status, stock_action')
          .eq('status', 'cancelled')
          .limit(5000)
        rows = (fallback || []).filter((r: any) => normalizeOrderKey(r.order_id) === targetNorm)
      }

      const codeSet = new Set(targetCodes.map((c) => c.toUpperCase()))
      const filteredRows = rows.filter((r: any) => codeSet.has(String(r.product_code || '').trim().toUpperCase()))
      setCancelledLines(filteredRows)
    } catch (e) {
      console.error('loadCancelledLines error:', e)
      setCancelledLines([])
    } finally {
      setCancelledLoading(false)
    }
  }, [getCancelledOrderProductCodes])

  /** ส่ง tabOverride เมื่อเพิ่ง setCurrentTab แล้ว state ยังไม่ทัน sync (เช่น หลังกดแก้ไขแล้ว) */
  const loadNotifications = async (tabOverride?: string) => {
    const tab = tabOverride ?? currentTab
    const { data, error } = await supabase
      .from('wms_notifications')
      .select('*, us_users!picker_id(username)')
      .eq('status', tab)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('loadNotifications:', error.message)
      return
    }
    if (!data) return

    const notificationsWithDetails = await enrichWmsNotificationsWithOrderDetails(supabase, data)
    setNotifications(notificationsWithDetails)
  }

  /** ยกเลิกบิลสร้างหลายแถวต่อใบงาน — อัปเดตทุกแถวในกลุ่ม (order_id แบบ normalize) */
  const markNotifRead = async (n: { id: string; type?: string; order_id?: string }) => {
    try {
      if (n.type === 'ยกเลิกบิล' && String(n.order_id || '').trim()) {
        let ids = await getUnreadCancelNotificationIdsForGroup(n.order_id)
        if (ids.length === 0) ids = [n.id]
        const { error } = await supabase.from('wms_notifications').update({ is_read: true }).in('id', ids)
        if (error) throw error
      } else {
        const { error } = await supabase.from('wms_notifications').update({ is_read: true }).eq('id', n.id)
        if (error) throw error
      }
      await loadNotifications()
      window.dispatchEvent(new Event('wms-data-changed'))
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      alert('อัปเดตไม่สำเร็จ: ' + msg)
    }
  }

  const markNotifFixed = async (n: { id: string; type?: string; order_id?: string }) => {
    try {
      if (n.type === 'ยกเลิกบิล' && String(n.order_id || '').trim()) {
        let ids = await getUnreadCancelNotificationIdsForGroup(n.order_id)
        if (ids.length === 0) ids = [n.id]
        const { error } = await supabase
          .from('wms_notifications')
          .update({ status: 'fixed', is_read: true })
          .in('id', ids)
        if (error) throw error
      } else {
        const { error } = await supabase
          .from('wms_notifications')
          .update({ status: 'fixed', is_read: true })
          .eq('id', n.id)
        if (error) throw error
      }
      setCurrentTab('fixed')
      await loadNotifications('fixed')
      window.dispatchEvent(new Event('wms-data-changed'))
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      alert('อัปเดตไม่สำเร็จ: ' + msg)
    }
  }

  const handleStockAction = async (wmsOrderId: string, action: 'recall' | 'waste') => {
    if (!canManageStock) return
    setStockActionLoading(wmsOrderId)
    try {
      if (action === 'recall') {
        const { error } = await supabase.rpc('fn_reverse_wms_stock', { p_wms_order_id: wmsOrderId })
        if (error) throw error
      } else {
        const { error } = await supabase.rpc('rpc_record_cancellation_waste', {
          p_wms_order_id: wmsOrderId,
          p_user_id: user?.id,
        })
        if (error) throw error
      }
      if (stockModalOrderId) await loadCancelledLines(stockModalOrderId)
      await loadNotifications()
      window.dispatchEvent(new Event('wms-data-changed'))
    } catch (e: any) {
      alert('ดำเนินการไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setStockActionLoading(null)
    }
  }

  const fontSizeClass = 'text-[18.66px]'

  return (
    <section>
      <h2 className="text-3xl font-black mb-6 text-slate-800">ศูนย์แจ้งเตือน</h2>
      <div className="flex gap-2 mb-6 bg-gray-200 p-1 rounded-xl w-fit">
        <button
          onClick={() => setCurrentTab('unread')}
          className={`px-6 py-2 rounded-lg font-bold transition text-sm ${currentTab === 'unread' ? 'tab-active' : ''}`}
        >
          รายการใหม่
        </button>
        <button
          onClick={() => setCurrentTab('fixed')}
          className={`px-6 py-2 rounded-lg font-bold transition text-sm ${currentTab === 'fixed' ? 'tab-active' : ''}`}
        >
          แก้ไขแล้ว
        </button>
      </div>
      <div className="bg-white rounded-2xl shadow-sm border overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 text-[18.66px] uppercase text-slate-800 font-black border-b">
            <tr>
              <th className="p-4 text-center">ลำดับ</th>
              <th className="p-4">วัน-เวลา</th>
              <th className="p-4">พนักงาน</th>
              <th className="p-4">หัวข้อปัญหา</th>
              <th className="p-4">สินค้า</th>
              <th className="p-4">จุดจัดเก็บ</th>
              <th className="p-4 text-center">จัดการ</th>
            </tr>
          </thead>
          <tbody className="divide-y text-gray-600">
            {notifications.map((n, idx) => (
              <tr key={n.id} className={`border-b ${!n.is_read ? 'bg-blue-50' : ''}`}>
                <td className={`p-4 text-center ${fontSizeClass}`}>{idx + 1}</td>
                <td className={`p-4 ${fontSizeClass}`}>{new Date(n.created_at).toLocaleString('th-TH')}</td>
                <td className={`p-4 font-bold text-blue-600 ${fontSizeClass}`}>{n.us_users?.username || '-'}</td>
                <td className={`p-4 text-red-600 font-bold ${fontSizeClass}`}>{n.type}</td>
                <td className={`p-4 ${fontSizeClass}`}>{n.product_name}</td>
                <td className={`p-4 font-bold text-red-600 ${fontSizeClass}`}>{n.location}</td>
                <td className="p-4 text-center">
                  <div className="flex items-center justify-center gap-1">
                    {n.type === 'ยกเลิกบิล' && (
                      <button
                        onClick={() => {
                          const firstOrderId = n.cancelled_orders?.[0]?.id
                          loadCancelledLines(n.order_id, firstOrderId)
                        }}
                        className="bg-amber-500 text-white px-4 py-2 rounded-lg text-xs font-black hover:bg-amber-600"
                        title={n.pendingCancelled > 0 ? `รอดำเนินการ ${n.pendingCancelled} รายการ` : 'เปิดรายการปรับสต๊อค'}
                      >
                        ปรับสต๊อค
                      </button>
                    )}
                    {!n.is_read && (
                      <button
                        onClick={() => markNotifRead(n)}
                        className="bg-slate-200 px-4 py-2 rounded-lg text-xs font-black hover:bg-slate-300"
                      >
                        อ่านแล้ว
                      </button>
                    )}
                    {currentTab === 'unread' ? (
                      <button
                        onClick={() => markNotifFixed(n)}
                        className="bg-green-600 text-white px-4 py-2 rounded-lg text-xs font-black ml-1 hover:bg-green-700"
                      >
                        แก้ไขแล้ว
                      </button>
                    ) : (
                      <span className={`text-green-500 font-bold ${fontSizeClass}`}>✔ Fixed</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Modal
        open={!!stockModalOrderId}
        onClose={() => { setStockModalOrderId(null); setStockModalCancelledOrders([]); setSelectedCancelledOrderId(null); setCancelledLines([]) }}
        contentClassName="max-w-4xl max-h-[85vh] overflow-y-auto"
      >
        {stockModalOrderId && (
          <div className="p-6 space-y-4">
            <h3 className="text-lg font-bold text-gray-800">
              ปรับสต๊อคบิลยกเลิก — ใบงาน {stockModalOrderId}
            </h3>
            {stockModalCancelledOrders.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                <p className="text-sm font-semibold text-red-800 mb-2">บิลที่ยกเลิก:</p>
                <div className="flex flex-wrap gap-2">
                  {stockModalCancelledOrders.map((o) => (
                    <button
                      key={o.id}
                      onClick={() => loadCancelledLines(stockModalOrderId, o.id)}
                      className={`px-2 py-1 border rounded-lg text-sm transition ${
                        selectedCancelledOrderId === o.id
                          ? 'bg-red-100 border-red-300'
                          : 'bg-white border-red-200 hover:bg-red-50'
                      }`}
                    >
                      <span className="font-mono font-bold text-red-700">{o.bill_no || '-'}</span>
                      <span className="text-gray-500 ml-1">({o.customer_name || '-'})</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {cancelledLoading ? (
              <div className="text-center py-8 text-gray-500">กำลังโหลดรายการ...</div>
            ) : cancelledLines.length === 0 ? (
              <div className="text-center py-10 text-gray-500">ไม่มีรายการ WMS ที่รอดำเนินการ</div>
            ) : (
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-gray-700">
                    <tr>
                      <th className="px-3 py-2 text-left">รหัสสินค้า</th>
                      <th className="px-3 py-2 text-left">ชื่อสินค้า</th>
                      <th className="px-3 py-2 text-left">จำนวน</th>
                      <th className="px-3 py-2 text-left">สถานะ</th>
                      <th className="px-3 py-2 text-center">จัดการ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {cancelledLines.map((line) => (
                      <tr key={line.id}>
                        <td className="px-3 py-2 font-mono">{line.product_code || '-'}</td>
                        <td className="px-3 py-2">{line.product_name || '-'}</td>
                        <td className="px-3 py-2">{line.qty}</td>
                        <td className="px-3 py-2">
                          {line.stock_action === 'recalled' ? (
                            <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700">เรียกคืนแล้ว</span>
                          ) : line.stock_action === 'waste' ? (
                            <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-orange-100 text-orange-700">ของเสีย</span>
                          ) : (
                            <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700">รอดำเนินการ</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {!line.stock_action && canManageStock ? (
                            <div className="flex gap-2 justify-center">
                              <button
                                onClick={() => handleStockAction(line.id, 'recall')}
                                disabled={stockActionLoading === line.id}
                                className="px-3 py-1.5 bg-green-600 text-white rounded-lg text-xs font-bold hover:bg-green-700 disabled:opacity-50"
                              >
                                {stockActionLoading === line.id ? '...' : 'คืนสต๊อค'}
                              </button>
                              <button
                                onClick={() => handleStockAction(line.id, 'waste')}
                                disabled={stockActionLoading === line.id}
                                className="px-3 py-1.5 bg-orange-600 text-white rounded-lg text-xs font-bold hover:bg-orange-700 disabled:opacity-50"
                              >
                                {stockActionLoading === line.id ? '...' : 'ตีเป็นของเสีย'}
                              </button>
                            </div>
                          ) : !line.stock_action ? (
                            <span className="text-xs text-gray-400">รอผู้มีสิทธิ์</span>
                          ) : (
                            <span className="text-xs text-gray-400">ดำเนินการแล้ว</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex justify-end">
              <button
                onClick={() => { setStockModalOrderId(null); setStockModalCancelledOrders([]); setSelectedCancelledOrderId(null); setCancelledLines([]) }}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-semibold text-gray-600 hover:bg-gray-50"
              >
                ปิด
              </button>
            </div>
          </div>
        )}
      </Modal>
    </section>
  )
}
