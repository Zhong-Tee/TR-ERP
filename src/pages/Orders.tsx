import { useState, useEffect } from 'react'
import { useMenuAccess } from '../contexts/MenuAccessContext'
import { useAuthContext } from '../contexts/AuthContext'
import OrderList from '../components/order/OrderList'
import OrderForm from '../components/order/OrderForm'
import WorkOrderSelectionList from '../components/order/WorkOrderSelectionList'
import WorkOrderManageList from '../components/order/WorkOrderManageList'
import OrderConfirmBoard from '../components/order/OrderConfirmBoard'
import IssueBoard from '../components/order/IssueBoard'
import { Order } from '../types'
import { supabase } from '../lib/supabase'

type Tab =
  | 'create'
  | 'waiting'
  | 'complete'
  | 'verified'
  | 'confirm'
  | 'issue'
  | 'work-orders'
  | 'work-orders-manage'
  | 'data-error'
  | 'shipped'
  | 'cancelled'
  

export default function Orders() {
  const { hasAccess } = useMenuAccess()
  const { user } = useAuthContext()
  const [activeTab, setActiveTab] = useState<Tab>('create')
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [channelFilter, setChannelFilter] = useState('')
  const [waitingCount, setWaitingCount] = useState(0)
  const [completeCount, setCompleteCount] = useState(0)
  const [verifiedCount, setVerifiedCount] = useState(0)
  const [dataErrorCount, setDataErrorCount] = useState(0)
  const [cancelledCount, setCancelledCount] = useState(0)
  
  const [confirmCount, setConfirmCount] = useState(0)
  const [workOrdersCount, setWorkOrdersCount] = useState(0)
  const [workOrdersManageCount, setWorkOrdersManageCount] = useState(0)
  const [shippedCount, setShippedCount] = useState(0)
  const [issueCount, setIssueCount] = useState(0)
  const [channels, setChannels] = useState<{ channel_code: string; channel_name: string }[]>([])
  const [listRefreshKey, setListRefreshKey] = useState(0)
  const [shippedDateFrom, setShippedDateFrom] = useState(() => new Date().toISOString().split('T')[0])
  const [shippedDateTo, setShippedDateTo] = useState(() => new Date().toISOString().split('T')[0])

  function handleOrderClick(order: Order) {
    setSelectedOrder(order)
    setActiveTab('create')
  }

  /** คลิกที่รายการใน ตรวจสอบแล้ว/ยกเลิก → แสดงรายละเอียดเพื่อดู (read-only) โดยไม่สลับแท็บ */
  function handleOrderClickViewOnly(order: Order) {
    setSelectedOrder(order)
  }

  /** options.switchToTab: หลัง save แล้วให้สลับไปแท็บนั้น (เช่น ปฏิเสธโอนเกิน → ตรวจสอบไม่ผ่าน) */
  function handleSave(options?: { switchToTab?: 'complete' }) {
    setSelectedOrder(null)
    setActiveTab(options?.switchToTab === 'complete' ? 'complete' : 'waiting')
    // Refresh counts immediately
    refreshCounts()
  }

  async function refreshCounts() {
    // Helper: เพิ่มเงื่อนไข admin_user สำหรับ admin-pump / admin-tr
    const adminName = (user?.role === 'admin-pump' || user?.role === 'admin-tr')
      ? (user.username ?? user.email ?? '')
      : ''
    function applyOwnerFilter(query: any) {
      return adminName ? query.eq('admin_user', adminName) : query
    }

    try {
      // Load waiting count
      const { count: waitingCount } = await applyOwnerFilter(
        supabase.from('or_orders').select('id', { count: 'exact', head: true }).eq('status', 'รอลงข้อมูล')
      )
      
      // Load complete count (รวม ตรวจสอบไม่ผ่าน และ ตรวจสอบไม่สำเร็จ)
      const { count: completeCount } = await applyOwnerFilter(
        supabase.from('or_orders').select('id', { count: 'exact', head: true }).in('status', ['ตรวจสอบไม่ผ่าน', 'ตรวจสอบไม่สำเร็จ'])
      )

      // Load verified count
      const { count: verifiedCount } = await applyOwnerFilter(
        supabase.from('or_orders').select('id', { count: 'exact', head: true }).eq('status', 'ตรวจสอบแล้ว')
      )

      // Load data error count
      const { count: dataErrorCount } = await applyOwnerFilter(
        supabase.from('or_orders').select('id', { count: 'exact', head: true }).eq('status', 'ลงข้อมูลผิด')
      )

      // Load cancelled count
      const { count: cancelledCount } = await applyOwnerFilter(
        supabase.from('or_orders').select('id', { count: 'exact', head: true }).eq('status', 'ยกเลิก')
      )

      // Load shipped count
      const { count: shippedCount } = await applyOwnerFilter(
        supabase.from('or_orders').select('id', { count: 'exact', head: true }).eq('status', 'จัดส่งแล้ว')
      )

      // Load confirm count: งานใหม่ + รอออกแบบ + ออกแบบแล้ว + รอคอนเฟิร์ม + คอนเฟิร์มแล้ว (PUMP) - กรองวันนี้
      const todayStr = new Date().toISOString().split('T')[0]
      const { count: confirmCountTotal } = await applyOwnerFilter(
        supabase.from('or_orders').select('id', { count: 'exact', head: true })
          .eq('channel_code', 'PUMP')
          .in('status', ['ตรวจสอบแล้ว', 'รอออกแบบ', 'ออกแบบแล้ว', 'รอคอนเฟิร์ม', 'คอนเฟิร์มแล้ว'])
          .gte('created_at', `${todayStr}T00:00:00.000Z`)
          .lte('created_at', `${todayStr}T23:59:59.999Z`)
      )

      // Load work orders count (ใบสั่งงาน)
      const { count: workOrdersPumpCount } = await applyOwnerFilter(
        supabase.from('or_orders').select('id', { count: 'exact', head: true })
          .eq('channel_code', 'PUMP')
          .in('status', ['คอนเฟิร์มแล้ว', 'เสร็จสิ้น'])
          .is('work_order_name', null)
      )
      const { count: workOrdersOtherCount } = await applyOwnerFilter(
        supabase.from('or_orders').select('id', { count: 'exact', head: true })
          .neq('channel_code', 'PUMP')
          .eq('status', 'ใบสั่งงาน')
          .is('work_order_name', null)
      )
      const workOrdersTotal = (workOrdersPumpCount ?? 0) + (workOrdersOtherCount ?? 0)

      // Load work orders manage count (จำนวนใบงานทั้งหมด)
      const { count: workOrdersManageCount } = await supabase
        .from('or_work_orders')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'กำลังผลิต')

      // Load issue count (On) — issue นับตาม role (RLS จะกรองให้)
      const { count: issueCount } = await supabase
        .from('or_issues')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'On')

      setWaitingCount(waitingCount || 0)
      setCompleteCount(completeCount || 0)
      setVerifiedCount(verifiedCount || 0)
      setDataErrorCount(dataErrorCount || 0)
      setCancelledCount(cancelledCount || 0)
      setConfirmCount(confirmCountTotal ?? 0)
      setWorkOrdersCount(workOrdersTotal)
      setWorkOrdersManageCount(workOrdersManageCount || 0)
      setShippedCount(shippedCount || 0)
      setIssueCount(issueCount || 0)
      // แจ้ง Sidebar ให้อัปเดตตัวเลขเมนูทันที
      window.dispatchEvent(new CustomEvent('sidebar-refresh-counts'))
    } catch (error) {
      console.error('Error refreshing counts:', error)
    }
  }

  function handleCancel() {
    setSelectedOrder(null)
  }

  async function handleMoveToWaiting(order: Order) {
    try {
      const { error } = await supabase
        .from('or_orders')
        .update({ status: 'รอลงข้อมูล' })
        .eq('id', order.id)
      if (error) throw error
      refreshCounts()
      setListRefreshKey((k) => k + 1)
    } catch (err: any) {
      console.error('Error moving order to waiting:', err)
      alert('เกิดข้อผิดพลาด: ' + (err?.message || err))
    }
  }

  /** ลบบิล (รอลงข้อมูล): ลบรูปใน bucket slip-images/slip{bill_no} แล้วลบ or_orders (cascade ลบ items, reviews, slips, refunds) */
  async function handleDeleteOrder(order: Order) {
    try {
      const billNo = order.bill_no
      if (billNo) {
        const folderName = `slip${billNo}`
        const { data: files, error: listError } = await supabase.storage
          .from('slip-images')
          .list(folderName, { limit: 200 })
        if (!listError && files && files.length > 0) {
          const filePaths = files
            .filter((f) => f.name && !f.name.endsWith('/'))
            .map((f) => `${folderName}/${f.name}`)
          if (filePaths.length > 0) {
            const { error: removeError } = await supabase.storage
              .from('slip-images')
              .remove(filePaths)
            if (removeError) console.warn('ลบรูปสลิปไม่ครบ:', removeError)
          }
        }
      }
      const { error: deleteError } = await supabase
        .from('or_orders')
        .delete()
        .eq('id', order.id)
      if (deleteError) throw deleteError
      if (selectedOrder?.id === order.id) setSelectedOrder(null)
      refreshCounts()
      setListRefreshKey((k) => k + 1)
    } catch (err: any) {
      console.error('Error deleting order:', err)
      alert('เกิดข้อผิดพลาดในการลบบิล: ' + (err?.message || err))
      throw err
    }
  }

  // โหลด channels จากตาราง
  useEffect(() => {
    async function loadChannels() {
      try {
        const { data, error } = await supabase
          .from('channels')
          .select('channel_code, channel_name')
          .order('channel_code', { ascending: true })

        if (error) throw error
        setChannels(data || [])
      } catch (error) {
        console.error('Error loading channels:', error)
      }
    }

    loadChannels()
  }, [])

  // โหลดตัวเลขทุกแท็บทันทีเมื่อเปิดหน้า (แบบขนาน) + realtime เมื่อ or_orders / ac_refunds เปลี่ยน
  useEffect(() => {
    async function loadCounts() {
      try {
        await refreshCounts()
      } catch (error) {
        console.error('Error loading counts:', error)
      }
    }

    loadCounts()

    const channel = supabase
      .channel('orders-count-updates')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_orders' }, () => loadCounts())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ac_refunds' }, () => loadCounts())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_issues' }, () => loadCounts())
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [searchTerm, channelFilter])

  // ฟัง event จาก TopBar เพื่อเปลี่ยนไปแท็บ Issue
  useEffect(() => {
    const onNavigateToIssue = () => {
      setActiveTab('issue')
      setSelectedOrder(null)
    }
    window.addEventListener('navigate-to-issue', onNavigateToIssue)
    return () => window.removeEventListener('navigate-to-issue', onNavigateToIssue)
  }, [])

  return (
    <div
      className="w-full"
    >
      {/* หัวเมนูย่อย — sticky ภายใน scroll container ไม่ทะลุ */}
      <div
        className="sticky top-0 z-10 bg-white border-b border-surface-200 shadow-soft -mx-6 px-6"
      >
        {/* Navigation Tabs */}
        <div className="w-full px-4 sm:px-6 lg:px-8 overflow-x-auto scrollbar-thin">
          <nav className="flex gap-1 sm:gap-3 flex-nowrap min-w-max py-3" aria-label="Tabs">
            {[
              { id: 'create', label: 'สร้าง/แก้ไข' },
              { id: 'waiting', label: `รอลงข้อมูล (${waitingCount})` },
              { id: 'data-error', label: `ลงข้อมูลผิด (${dataErrorCount})` },
              { id: 'complete', label: 'ตรวจสอบไม่ผ่าน', count: completeCount, countColor: 'text-red-600' },
              { id: 'verified', label: 'ตรวจสอบแล้ว', count: verifiedCount, countColor: 'text-green-600' },
              { id: 'confirm', label: 'Confirm', count: confirmCount, countColor: 'text-blue-600' },
              { id: 'work-orders', label: 'ใบสั่งงาน', count: workOrdersCount, countColor: 'text-blue-600' },
              { id: 'work-orders-manage', label: 'จัดการใบงาน', count: workOrdersManageCount, countColor: 'text-blue-600' },
              { id: 'shipped', label: 'จัดส่งแล้ว', count: shippedCount, countColor: 'text-blue-600' },
              { id: 'cancelled', label: `ยกเลิก (${cancelledCount})`, labelColor: 'text-orange-600' },
              { id: 'issue', label: 'Issue', count: issueCount, countColor: 'text-blue-600' },
            ].filter((tab) => hasAccess(`orders-${tab.id}`)).map((tab) => (
              <button
                key={tab.id}
                onClick={() => {
                  setActiveTab(tab.id as Tab)
                  setSelectedOrder(null)
                }}
                className={`py-3 px-3 sm:px-4 rounded-t-xl border-b-2 font-semibold text-base whitespace-nowrap flex-shrink-0 transition-colors ${
                  activeTab === tab.id
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-blue-600'
                }`}
              >
                {'count' in tab && tab.count !== undefined && 'countColor' in tab
                  ? <>
                      {tab.label}{' '}
                      <span className={`font-semibold ${tab.countColor}`}>({tab.count})</span>
                    </>
                  : tab.label
                }
              </button>
            ))}
          </nav>
        </div>

        {/* Search and Filter - แสดงเมื่อไม่ใช่แท็บสร้าง/แก้ไข */}
        {activeTab !== 'create' && activeTab !== 'confirm' && (
          <div className="w-full px-4 sm:px-6 lg:px-8 py-3 bg-surface-100 border-t border-surface-200">
            <div className="flex flex-wrap gap-3">
              <input
                type="text"
                placeholder="ค้นหา..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="flex-1 min-w-[200px] px-4 py-2.5 border border-surface-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-200 focus:border-primary-300 bg-surface-50 text-base"
              />
              <select
                value={channelFilter}
                onChange={(e) => setChannelFilter(e.target.value)}
                className="px-4 py-2.5 border border-surface-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-200 bg-surface-50 text-base"
              >
                <option value="">ทั้งหมด</option>
                {channels.map((ch) => (
                  <option key={ch.channel_code} value={ch.channel_code}>
                    {ch.channel_name || ch.channel_code}
                  </option>
                ))}
              </select>
              {activeTab === 'shipped' && (
                <>
                  <input
                    type="date"
                    value={shippedDateFrom}
                    onChange={(e) => setShippedDateFrom(e.target.value)}
                    className="px-4 py-2.5 border border-surface-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-200 bg-surface-50 text-base"
                  />
                  <input
                    type="date"
                    value={shippedDateTo}
                    onChange={(e) => setShippedDateTo(e.target.value)}
                    className="px-4 py-2.5 border border-surface-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-200 bg-surface-50 text-base"
                  />
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ส่วนเนื้อหาทุกเมนู — อยู่ใต้ sticky เมนูย่อยปกติ */}
      <main
        className="w-full pb-6 min-h-0 pt-4"
        aria-label="เนื้อหาออเดอร์"
      >
        {selectedOrder ? (
          <OrderForm
            order={selectedOrder}
            onSave={handleSave}
            onCancel={handleCancel}
            onOpenOrder={(o) => { setSelectedOrder(o); setActiveTab('create') }}
            readOnly={activeTab !== 'create'}
            viewOnly={activeTab === 'verified' || activeTab === 'cancelled'}
          />
        ) : activeTab === 'waiting' ? (
          <OrderList
            status="รอลงข้อมูล"
            searchTerm={searchTerm}
            channelFilter={channelFilter}
            onOrderClick={handleOrderClick}
            showBillingStatus={true}
            onCountChange={setWaitingCount}
            showDeleteButton={true}
            onDelete={handleDeleteOrder}
            refreshTrigger={listRefreshKey}
          />
        ) : activeTab === 'complete' ? (
          <OrderList
            status={['ตรวจสอบไม่ผ่าน', 'ตรวจสอบไม่สำเร็จ']}
            searchTerm={searchTerm}
            channelFilter={channelFilter}
            onOrderClick={handleOrderClick}
            showBillingStatus={true}
            onCountChange={setCompleteCount}
            showMoveToWaitingButton={true}
            onMoveToWaiting={handleMoveToWaiting}
            refreshTrigger={listRefreshKey}
            useDetailViewOnClick={true}
          />
        ) : activeTab === 'verified' ? (
          <OrderList
            status="ตรวจสอบแล้ว"
            searchTerm={searchTerm}
            channelFilter={channelFilter}
            onOrderClick={handleOrderClickViewOnly}
            verifiedOnly={true}
            onCountChange={setVerifiedCount}
            showMoveToWaitingButton={true}
            onMoveToWaiting={handleMoveToWaiting}
            refreshTrigger={listRefreshKey}
            useDetailViewOnClick={true}
          />
        ) : activeTab === 'confirm' ? (
          <OrderConfirmBoard onCountChange={setConfirmCount} />
        ) : activeTab === 'issue' ? (
          <IssueBoard scope="orders" onOpenCountChange={setIssueCount} />
        ) : activeTab === 'work-orders' ? (
          <WorkOrderSelectionList
            searchTerm={searchTerm}
            channelFilter={channelFilter}
            onOrderClick={handleOrderClick}
          />
        ) : activeTab === 'work-orders-manage' ? (
          <WorkOrderManageList
            searchTerm={searchTerm}
            channelFilter={channelFilter}
            onRefresh={() => setListRefreshKey((k) => k + 1)}
          />
        ) : activeTab === 'data-error' ? (
          <OrderList
            status="ลงข้อมูลผิด"
            searchTerm={searchTerm}
            channelFilter={channelFilter}
            onOrderClick={handleOrderClick}
            showBillingStatus={true}
            onCountChange={setDataErrorCount}
          />
        ) : activeTab === 'shipped' ? (
          <OrderList
            status="จัดส่งแล้ว"
            searchTerm={searchTerm}
            channelFilter={channelFilter}
            onOrderClick={handleOrderClick}
            dateFrom={shippedDateFrom}
            dateTo={shippedDateTo}
          />
        ) : activeTab === 'cancelled' ? (
          <OrderList
            status="ยกเลิก"
            searchTerm={searchTerm}
            channelFilter={channelFilter}
            onOrderClick={handleOrderClickViewOnly}
            onCountChange={setCancelledCount}
            showMoveToWaitingButton={true}
            onMoveToWaiting={handleMoveToWaiting}
            refreshTrigger={listRefreshKey}
          />
        ) : (
          <OrderForm
            onSave={handleSave}
            onCancel={handleCancel}
            onOpenOrder={(o) => { setSelectedOrder(o); setActiveTab('create') }}
          />
        )}
      </main>
    </div>
  )
}
