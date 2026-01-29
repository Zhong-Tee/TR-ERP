import { useState, useEffect } from 'react'
import OrderList from '../components/order/OrderList'
import OrderForm from '../components/order/OrderForm'
import WorkOrderSelectionList from '../components/order/WorkOrderSelectionList'
import WorkOrderManageList from '../components/order/WorkOrderManageList'
import { Order } from '../types'
import { supabase } from '../lib/supabase'

type Tab = 'create' | 'waiting' | 'complete' | 'verified' | 'work-orders' | 'work-orders-manage' | 'data-error' | 'shipped' | 'cancelled'

export default function Orders() {
  const [activeTab, setActiveTab] = useState<Tab>('create')
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [channelFilter, setChannelFilter] = useState('')
  const [waitingCount, setWaitingCount] = useState(0)
  const [completeCount, setCompleteCount] = useState(0)
  const [verifiedCount, setVerifiedCount] = useState(0)
  const [dataErrorCount, setDataErrorCount] = useState(0)
  const [cancelledCount, setCancelledCount] = useState(0)
  const [channels, setChannels] = useState<{ channel_code: string; channel_name: string }[]>([])
  const [listRefreshKey, setListRefreshKey] = useState(0)

  function handleOrderClick(order: Order) {
    setSelectedOrder(order)
    setActiveTab('create')
  }

  /** คลิกที่รายการใน ตรวจสอบแล้ว/ยกเลิก → แสดงรายละเอียดเพื่อดู (read-only) โดยไม่สลับแท็บ */
  function handleOrderClickViewOnly(order: Order) {
    setSelectedOrder(order)
  }

  function handleSave() {
    setSelectedOrder(null)
    setActiveTab('waiting')
    // Refresh counts immediately
    refreshCounts()
  }

  async function refreshCounts() {
    try {
      // Load waiting count
      const { count: waitingCount } = await supabase
        .from('or_orders')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'รอลงข้อมูล')
      
      // Load complete count
      const { count: completeCount } = await supabase
        .from('or_orders')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'ตรวจสอบไม่ผ่าน')

      // Load verified count
      const { count: verifiedCount } = await supabase
        .from('or_orders')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'ตรวจสอบแล้ว')

      // Load data error count
      const { count: dataErrorCount } = await supabase
        .from('or_orders')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'ลงข้อมูลผิด')

      // Load cancelled count
      const { count: cancelledCount } = await supabase
        .from('or_orders')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'ยกเลิก')

      setWaitingCount(waitingCount || 0)
      setCompleteCount(completeCount || 0)
      setVerifiedCount(verifiedCount || 0)
      setDataErrorCount(dataErrorCount || 0)
      setCancelledCount(cancelledCount || 0)
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

  // โหลด waiting count และ cancelled count ทันที
  useEffect(() => {
    async function loadCounts() {
      try {
        // Load waiting count
        const { count: waitingCount, error: waitingError } = await supabase
          .from('or_orders')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'รอลงข้อมูล')

        if (waitingError) throw waitingError
        
        // Load complete count
        const { count: completeCount, error: completeError } = await supabase
          .from('or_orders')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'ตรวจสอบไม่ผ่าน')

        if (completeError) throw completeError

        // Load verified count
        const { count: verifiedCount, error: verifiedError } = await supabase
          .from('or_orders')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'ตรวจสอบแล้ว')

        if (verifiedError) throw verifiedError

        // Load data error count
        const { count: dataErrorCount, error: dataErrorError } = await supabase
          .from('or_orders')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'ลงข้อมูลผิด')

        if (dataErrorError) throw dataErrorError

        // Load cancelled count
        const { count: cancelledCount, error: cancelledError } = await supabase
          .from('or_orders')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'ยกเลิก')

        if (cancelledError) throw cancelledError

        setWaitingCount(waitingCount || 0)
        setCompleteCount(completeCount || 0)
        setVerifiedCount(verifiedCount || 0)
        setDataErrorCount(dataErrorCount || 0)
        setCancelledCount(cancelledCount || 0)
      } catch (error) {
        console.error('Error loading counts:', error)
      }
    }

    loadCounts()
    
    // Set up real-time subscription for order status changes
    const channel = supabase
      .channel('orders-count-updates')
      .on('postgres_changes', 
        { event: '*', schema: 'public', table: 'or_orders' },
        () => {
          // Refresh counts when any order changes
          loadCounts()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [searchTerm, channelFilter])

  return (
    <div className="min-h-screen bg-gray-50 w-full">
      {/* Navigation Tabs */}
      <div className="bg-white border-b border-gray-200 sticky top-16 z-40">
        <div className="w-full px-4 sm:px-6 lg:px-8">
          <nav className="flex space-x-8" aria-label="Tabs">
            {[
              { id: 'create', label: 'สร้าง/แก้ไข' },
              { id: 'waiting', label: `รอลงข้อมูล (${waitingCount})` },
              { id: 'data-error', label: `ลงข้อมูลผิด (${dataErrorCount})` },
              { id: 'complete', label: 'ตรวจสอบไม่ผ่าน', count: completeCount, countColor: 'text-red-600' },
              { id: 'verified', label: 'ตรวจสอบแล้ว', count: verifiedCount, countColor: 'text-green-600' },
              { id: 'work-orders', label: 'ใบสั่งงาน' },
              { id: 'work-orders-manage', label: 'จัดการใบงาน' },
              { id: 'shipped', label: 'จัดส่งแล้ว' },
              { id: 'cancelled', label: `ยกเลิก (${cancelledCount})` },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => {
                  setActiveTab(tab.id as Tab)
                  setSelectedOrder(null)
                }}
                className={`py-4 px-1 border-b-2 font-medium text-sm ${
                  activeTab === tab.id
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
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
      </div>

      {/* Search and Filter - Hidden on Create Tab */}
      {activeTab !== 'create' && (
        <div className="bg-white border-b border-gray-200 sticky top-[73px] z-30">
          <div className="w-full px-4 sm:px-6 lg:px-8 py-4 flex gap-4">
            <input
              type="text"
              placeholder="ค้นหา..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <select
              value={channelFilter}
              onChange={(e) => setChannelFilter(e.target.value)}
              className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">ทั้งหมด</option>
              {channels.map((ch) => (
                <option key={ch.channel_code} value={ch.channel_code}>
                  {ch.channel_name || ch.channel_code}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Content Area */}
      <div className="w-full px-4 sm:px-6 lg:px-8 py-8">
        {selectedOrder ? (
          <OrderForm
            order={selectedOrder}
            onSave={handleSave}
            onCancel={handleCancel}
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
          />
        ) : activeTab === 'complete' ? (
          <OrderList
            status="ตรวจสอบไม่ผ่าน"
            searchTerm={searchTerm}
            channelFilter={channelFilter}
            onOrderClick={handleOrderClick}
            showBillingStatus={true}
            onCountChange={setCompleteCount}
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
          />
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
          <OrderForm onSave={handleSave} onCancel={handleCancel} />
        )}
      </div>
    </div>
  )
}
