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
  }

  return (
    <div className="min-h-screen bg-gray-50 w-full">
      <div className="w-full px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-3xl font-bold">รอตรวจคำสั่งซื้อ</h1>
        </div>
        <OrderReviewList onStatusUpdate={refreshCounts} />
      </div>
    </div>
  )
}
