import { useState, useEffect } from 'react'
import { supabase } from '../../../lib/supabase'

export default function NotificationSection() {
  const [currentTab, setCurrentTab] = useState('unread')
  const [notifications, setNotifications] = useState<any[]>([])

  useEffect(() => {
    loadNotifications()

    const channel = supabase
      .channel('wms-notifications-updates')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_notifications' }, () => {
        loadNotifications()
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [currentTab])

  const loadNotifications = async () => {
    const { data } = await supabase
      .from('wms_notifications')
      .select('*, us_users!picker_id(username)')
      .eq('status', currentTab)
      .order('created_at', { ascending: false })

    if (!data) return

    const oids = [...new Set(data.map((n: any) => n.order_id))]
    const { data: oDetails } = await supabase
      .from('wms_orders')
      .select('order_id, product_name, location')
      .in('order_id', oids)

    const notificationsWithDetails = data.map((n: any) => {
      const info = oDetails?.find((o: any) => o.order_id === n.order_id) || { product_name: '---', location: '---' }
      return { ...n, ...info }
    })

    setNotifications(notificationsWithDetails)
  }

  const markNotifRead = async (id: string) => {
    await supabase.from('wms_notifications').update({ is_read: true }).eq('id', id)
    loadNotifications()
  }

  const markNotifFixed = async (id: string) => {
    await supabase.from('wms_notifications').update({ status: 'fixed', is_read: true }).eq('id', id)
    loadNotifications()
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
                    {!n.is_read && (
                      <button
                        onClick={() => markNotifRead(n.id)}
                        className="bg-slate-200 px-4 py-2 rounded-lg text-xs font-black hover:bg-slate-300"
                      >
                        อ่านแล้ว
                      </button>
                    )}
                    {currentTab === 'unread' ? (
                      <button
                        onClick={() => markNotifFixed(n.id)}
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
    </section>
  )
}
