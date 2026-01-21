import { useState } from 'react'
import OrderList from '../components/order/OrderList'
import OrderForm from '../components/order/OrderForm'
import { Order } from '../types'
import { useAuthContext } from '../contexts/AuthContext'

type Tab = 'create' | 'waiting' | 'complete' | 'work-orders' | 'shipped' | 'cancelled'

export default function Orders() {
  const { user } = useAuthContext()
  const [activeTab, setActiveTab] = useState<Tab>('create')
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [channelFilter, setChannelFilter] = useState('')

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
              onClick={() => setActiveTab('waiting')}
              className={`px-6 py-3 font-medium ${
                activeTab === 'waiting'
                  ? 'border-b-2 border-blue-500 text-blue-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              รอลงข้อมูล
            </button>
            <button
              onClick={() => setActiveTab('complete')}
              className={`px-6 py-3 font-medium ${
                activeTab === 'complete'
                  ? 'border-b-2 border-blue-500 text-blue-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              ลงข้อมูลเสร็จสิ้น
            </button>
            <button
              onClick={() => setActiveTab('work-orders')}
              className={`px-6 py-3 font-medium ${
                activeTab === 'work-orders'
                  ? 'border-b-2 border-blue-500 text-blue-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              ใบงาน (กำลังผลิต)
            </button>
            <button
              onClick={() => setActiveTab('shipped')}
              className={`px-6 py-3 font-medium ${
                activeTab === 'shipped'
                  ? 'border-b-2 border-blue-500 text-blue-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              จัดส่งแล้ว
            </button>
            <button
              onClick={() => setActiveTab('cancelled')}
              className={`px-6 py-3 font-medium ${
                activeTab === 'cancelled'
                  ? 'border-b-2 border-blue-500 text-blue-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              ยกเลิก
            </button>
          </nav>
          <div className="flex items-center gap-4">
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
              <option value="SPTR">SPTR</option>
              <option value="FSPTR">FSPTR</option>
              <option value="LZTR">LZTR</option>
              <option value="TTTR">TTTR</option>
              <option value="SHOP">SHOP</option>
            </select>
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
          {activeTab === 'waiting' && (
            <OrderList
              status="รอลงข้อมูล"
              onOrderClick={handleOrderClick}
              searchTerm={searchTerm}
              channelFilter={channelFilter}
            />
          )}
          {activeTab === 'complete' && (
            <OrderList
              status="ลงข้อมูลเสร็จสิ้น"
              onOrderClick={handleOrderClick}
              searchTerm={searchTerm}
              channelFilter={channelFilter}
            />
          )}
          {activeTab === 'work-orders' && (
            <OrderList
              status="ใบงานกำลังผลิต"
              onOrderClick={handleOrderClick}
              searchTerm={searchTerm}
              channelFilter={channelFilter}
            />
          )}
          {activeTab === 'shipped' && (
            <OrderList
              status="จัดส่งแล้ว"
              onOrderClick={handleOrderClick}
              searchTerm={searchTerm}
              channelFilter={channelFilter}
            />
          )}
          {activeTab === 'cancelled' && (
            <OrderList
              status="ยกเลิก"
              onOrderClick={handleOrderClick}
              searchTerm={searchTerm}
              channelFilter={channelFilter}
            />
          )}
        </div>
      </div>
    </div>
  )
}
