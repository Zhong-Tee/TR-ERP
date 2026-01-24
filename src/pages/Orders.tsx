import { useState, useEffect } from 'react'
import OrderList from '../components/order/OrderList'
import OrderForm from '../components/order/OrderForm'
import { Order } from '../types'
import { useAuthContext } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'

type Tab = 'create' | 'waiting' | 'complete' | 'verified' | 'work-orders' | 'shipped' | 'cancelled'

export default function Orders() {
  const { user } = useAuthContext()
  const [activeTab, setActiveTab] = useState<Tab>('create')
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [channelFilter, setChannelFilter] = useState('')
  const [waitingCount, setWaitingCount] = useState(0)
  const [cancelledCount, setCancelledCount] = useState(0)
  const [channels, setChannels] = useState<{ channel_code: string; channel_name: string }[]>([])

  function handleOrderClick(order: Order) {
    setSelectedOrder(order)
    setActiveTab('create')
  }

  function handleSave() {
    setSelectedOrder(null)
    setActiveTab('waiting')
  }

  function handleCancel() {
    setSelectedOrder(null)
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
      } catch (error: any) {
        console.error('Error loading channels:', error)
      }
    }

    loadChannels()
  }, [])

  // โหลดจำนวนรายการ "รอลงข้อมูล" ทันทีเมื่อเข้าหน้าเว็บ
  useEffect(() => {
    async function loadWaitingCount() {
      try {
        let query = supabase
          .from('or_orders')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'รอลงข้อมูล')

        if (searchTerm) {
          query = query.or(
            `bill_no.ilike.%${searchTerm}%,customer_name.ilike.%${searchTerm}%,tracking_number.ilike.%${searchTerm}%`
          )
        }

        if (channelFilter) {
          query = query.eq('channel_code', channelFilter)
        }

        const { count, error } = await query

        if (error) throw error
        setWaitingCount(count || 0)
      } catch (error: any) {
        console.error('Error loading waiting count:', error)
        // ไม่แสดง alert เพื่อไม่รบกวนผู้ใช้
      }
    }

    loadWaitingCount()
  }, [searchTerm, channelFilter])

  // โหลดจำนวนรายการ "ยกเลิก" ทันทีเมื่อเข้าหน้าเว็บ
  useEffect(() => {
    async function loadCancelledCount() {
      try {
        let query = supabase
          .from('or_orders')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'ยกเลิก')

        if (searchTerm) {
          query = query.or(
            `bill_no.ilike.%${searchTerm}%,customer_name.ilike.%${searchTerm}%,tracking_number.ilike.%${searchTerm}%`
          )
        }

        if (channelFilter) {
          query = query.eq('channel_code', channelFilter)
        }

        const { count, error } = await query

        if (error) throw error
        setCancelledCount(count || 0)
      } catch (error: any) {
        console.error('Error loading cancelled count:', error)
        // ไม่แสดง alert เพื่อไม่รบกวนผู้ใช้
      }
    }

    loadCancelledCount()
  }, [searchTerm, channelFilter])

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">จัดการออเดอร์</h1>

      <div className="bg-white rounded-lg shadow">
        <div className="border-b">
          <div className="flex items-center justify-between px-6 py-3">
            <nav className="flex">
            <button
              onClick={() => {
                setActiveTab('create')
                setSelectedOrder(null)
              }}
              className={`px-6 py-3 font-medium ${
                activeTab === 'create'
                  ? 'border-b-2 border-blue-500 text-blue-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              สร้าง / แก้ไข
            </button>
            <button
              onClick={() => {
                setActiveTab('waiting')
                setSelectedOrder(null)
              }}
              className={`px-6 py-3 font-medium ${
                activeTab === 'waiting'
                  ? 'border-b-2 border-blue-500 text-blue-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              รอลงข้อมูล {waitingCount > 0 ? `(${waitingCount})` : ''}
            </button>
            <button
              onClick={() => {
                setActiveTab('complete')
                setSelectedOrder(null)
              }}
              className={`px-6 py-3 font-medium ${
                activeTab === 'complete'
                  ? 'border-b-2 border-blue-500 text-blue-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              ลงข้อมูลเสร็จสิ้น
            </button>
            <button
              onClick={() => {
                setActiveTab('verified')
                setSelectedOrder(null)
              }}
              className={`px-6 py-3 font-medium ${
                activeTab === 'verified'
                  ? 'border-b-2 border-blue-500 text-blue-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              ตรวจสอบแล้ว
            </button>
            <button
              onClick={() => {
                setActiveTab('work-orders')
                setSelectedOrder(null)
              }}
              className={`px-6 py-3 font-medium ${
                activeTab === 'work-orders'
                  ? 'border-b-2 border-blue-500 text-blue-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              ใบงาน (กำลังผลิต)
            </button>
            <button
              onClick={() => {
                setActiveTab('shipped')
                setSelectedOrder(null)
              }}
              className={`px-6 py-3 font-medium ${
                activeTab === 'shipped'
                  ? 'border-b-2 border-blue-500 text-blue-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              จัดส่งแล้ว
            </button>
            <button
              onClick={() => {
                setActiveTab('cancelled')
                setSelectedOrder(null)
              }}
              className={`px-6 py-3 font-medium ${
                activeTab === 'cancelled'
                  ? 'border-b-2 border-blue-500 text-blue-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              ยกเลิก {cancelledCount > 0 ? `(${cancelledCount})` : ''}
            </button>
          </nav>
          <div className="flex items-center gap-4">
            {activeTab !== 'create' && (
              <>
                <input
                  type="text"
                  placeholder="ค้นหา..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="px-4 py-2 border rounded-lg"
                />
                <select
                  value={channelFilter}
                  onChange={(e) => setChannelFilter(e.target.value)}
                  className="px-4 py-2 border rounded-lg"
                >
                  <option value="">ทุกช่องทาง</option>
                  {channels.map((ch) => (
                    <option key={ch.channel_code} value={ch.channel_code}>
                      {ch.channel_name || ch.channel_code}
                    </option>
                  ))}
                </select>
              </>
            )}
            {user && (
              <div className="text-sm font-medium text-gray-700 bg-gray-100 px-4 py-2 rounded-lg">
                <span className="text-gray-500">แอดมิน:</span> {user.username || user.email}
              </div>
            )}
          </div>
        </div>
        </div>

        <div className="p-6">
          {activeTab === 'create' && (
            <OrderForm
              order={selectedOrder}
              onSave={handleSave}
              onCancel={handleCancel}
            />
          )}
          {activeTab === 'waiting' && !selectedOrder && (
            <OrderList
              status="รอลงข้อมูล"
              onOrderClick={handleOrderClick}
              searchTerm={searchTerm}
              channelFilter={channelFilter}
              showBillingStatus={true}
              onCountChange={setWaitingCount}
            />
          )}
          {activeTab === 'waiting' && selectedOrder && (
            <OrderForm
              order={selectedOrder}
              onSave={handleSave}
              onCancel={handleCancel}
            />
          )}
          {activeTab === 'complete' && !selectedOrder && (
            <OrderList
              status="ลงข้อมูลเสร็จสิ้น"
              onOrderClick={handleOrderClick}
              searchTerm={searchTerm}
              channelFilter={channelFilter}
              showBillingStatus={true}
            />
          )}
          {activeTab === 'complete' && selectedOrder && (
            <OrderForm
              order={selectedOrder}
              onSave={handleSave}
              onCancel={handleCancel}
            />
          )}
          {activeTab === 'verified' && !selectedOrder && (
            <OrderList
              status="ลงข้อมูลเสร็จสิ้น"
              onOrderClick={handleOrderClick}
              searchTerm={searchTerm}
              channelFilter={channelFilter}
              verifiedOnly={true}
            />
          )}
          {activeTab === 'verified' && selectedOrder && (
            <OrderForm
              order={selectedOrder}
              onSave={handleSave}
              onCancel={handleCancel}
            />
          )}
          {activeTab === 'work-orders' && !selectedOrder && (
            <OrderList
              status="ใบงานกำลังผลิต"
              onOrderClick={handleOrderClick}
              searchTerm={searchTerm}
              channelFilter={channelFilter}
            />
          )}
          {activeTab === 'work-orders' && selectedOrder && (
            <OrderForm
              order={selectedOrder}
              onSave={handleSave}
              onCancel={handleCancel}
            />
          )}
          {activeTab === 'shipped' && !selectedOrder && (
            <OrderList
              status="จัดส่งแล้ว"
              onOrderClick={handleOrderClick}
              searchTerm={searchTerm}
              channelFilter={channelFilter}
            />
          )}
          {activeTab === 'shipped' && selectedOrder && (
            <OrderForm
              order={selectedOrder}
              onSave={handleSave}
              onCancel={handleCancel}
            />
          )}
          {activeTab === 'cancelled' && !selectedOrder && (
            <OrderList
              status="ยกเลิก"
              onOrderClick={handleOrderClick}
              searchTerm={searchTerm}
              channelFilter={channelFilter}
              onCountChange={setCancelledCount}
            />
          )}
          {activeTab === 'cancelled' && selectedOrder && (
            <OrderForm
              order={selectedOrder}
              onSave={handleSave}
              onCancel={handleCancel}
            />
          )}
        </div>
      </div>
    </div>
  )
}
