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
    <div className="w-full">
      <OrderReviewList onStatusUpdate={refreshCounts} />
    </div>
  )
}
