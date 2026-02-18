import { useEffect, useState } from 'react'
import { supabase } from '../../../lib/supabase'

interface SidebarProps {
  activeMenu: string
  setActiveMenu: (key: string) => void
  username?: string | null
  onLogout: () => void
  userRole?: string | null
}

export default function Sidebar({ activeMenu, setActiveMenu, username, onLogout, userRole }: SidebarProps) {
  const [reviewBadge, setReviewBadge] = useState(0)
  const [notifBadge, setNotifBadge] = useState(0)

  useEffect(() => {
    updateReviewBadge()
    updateNotifBadge()

    const ordersChannel = supabase
      .channel('wms-orders-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_orders' }, () => {
        updateReviewBadge()
      })
      .subscribe()

    const notifChannel = supabase
      .channel('wms-notifications-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_notifications' }, () => {
        updateNotifBadge()
      })
      .subscribe()

    return () => {
      supabase.removeChannel(ordersChannel)
      supabase.removeChannel(notifChannel)
    }
  }, [])

  const updateReviewBadge = async () => {
    const { count } = await supabase
      .from('wms_orders')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'picked')
    setReviewBadge(count || 0)
  }

  const updateNotifBadge = async () => {
    const { count } = await supabase
      .from('wms_notifications')
      .select('*', { count: 'exact', head: true })
      .eq('is_read', false)
    setNotifBadge(count || 0)
  }

  const menuItems = [
    { key: 'wms-upload', icon: 'fa-file-import', label: 'จัดสินค้า' },
    { key: 'wms-review', icon: 'fa-tasks', label: 'ตรวจสินค้า', badge: reviewBadge },
    { key: 'wms-kpi', icon: 'fa-chart-pie', label: 'KPI' },
    { key: 'wms-requisition', icon: 'fa-clipboard-list', label: 'รายการเบิก' },
    { key: 'wms-notif', icon: 'fa-bell', label: 'แจ้งเตือน', badge: notifBadge },
    ...(userRole !== 'store'
      ? [
          { key: 'wms-settings', icon: 'fa-sliders-h', label: 'ตั้งค่า' },
          { key: 'wms-no-image', icon: 'fa-image', label: 'รหัสที่ไม่มีรูป' },
        ]
      : []),
  ]

  return (
    <aside className="w-64 bg-slate-800 text-gray-300 flex flex-col shrink-0 rounded-2xl overflow-hidden">
      <div className="p-6 text-xl font-black text-white border-b border-slate-700 tracking-tighter">
        WMS SYSTEM
      </div>
      <nav className="flex-1 mt-4 text-sm font-medium">
        {menuItems.map((item) => (
          <div
            key={item.key}
            onClick={() => setActiveMenu(item.key)}
            className={`menu-link flex items-center p-4 relative ${
              activeMenu === item.key ? 'sidebar-item-active' : ''
            }`}
          >
            <i className={`fas ${item.icon} w-8`}></i>
            <span>{item.label}</span>
            {item.badge !== undefined && item.badge > 0 && (
              <span className="absolute right-4 bg-red-600 text-white text-[10px] px-1.5 py-0.5 rounded-full font-bold">
                {item.badge}
              </span>
            )}
          </div>
        ))}
      </nav>
      <div className="p-4 border-t border-slate-700 mt-auto bg-slate-900/50">
        <div className="flex items-center justify-between">
          <div className="flex items-center text-sm font-semibold text-gray-200">
            <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center mr-2 shadow-inner">
              <i className="fas fa-user text-xs text-white"></i>
            </div>
            <span className="truncate max-w-[100px]">{username || 'Admin'}</span>
          </div>
          <button
            onClick={onLogout}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-red-500/10 text-red-400 text-xs font-bold hover:bg-red-500 hover:text-white transition-all"
          >
            <span>Logout</span>
            <i className="fas fa-sign-out-alt"></i>
          </button>
        </div>
      </div>
    </aside>
  )
}
