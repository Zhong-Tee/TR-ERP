import OrderReviewList from '../components/order/OrderReviewList'
import { supabase } from '../lib/supabase'
import { useState, useEffect } from 'react'

export default function AdminQC() {
  const [count, setCount] = useState(0)

  useEffect(() => {
    loadCount()
    
    // Set up real-time subscription for order status changes
    const channel = supabase
      .channel('admin-qc-count-updates')
      .on('postgres_changes', 
        { event: '*', schema: 'public', table: 'or_orders' },
        () => {
          loadCount()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  async function loadCount() {
    try {
      const { count: verifiedCount } = await supabase
        .from('or_orders')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'ตรวจสอบแล้ว')
      
      setCount(verifiedCount || 0)
    } catch (error) {
      console.error('Error loading count:', error)
    }
  }

  async function refreshCounts() {
    await loadCount()
    window.dispatchEvent(new CustomEvent('sidebar-refresh-counts'))
  }

  // ส่งจำนวนไปให้ TopBar แสดงผ่าน custom event
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('topbar-menu-count', { detail: { count } }))
  }, [count])

  return (
    <div className="w-full flex-1 min-h-0 flex flex-col">
      <div className="sticky top-0 z-10 bg-white border-b border-surface-200 shadow-soft -mx-6 px-6">
        <div className="flex items-center justify-between py-3">
          <span className="text-base font-semibold text-gray-700">รายการบิลที่รอตรวจสอบ</span>
          <span className="text-sm text-gray-500">ตรวจสอบแล้ว: <strong className="text-blue-600">{count}</strong> รายการ</span>
        </div>
      </div>
      <OrderReviewList onStatusUpdate={refreshCounts} />
    </div>
  )
}
