import { useState, useEffect, useRef } from 'react'
import { useAuthContext } from '../../../contexts/AuthContext'
import { supabase } from '../../../lib/supabase'
import { calculateDuration, sortOrderItems } from '../wmsUtils'
import PickerOrderList from './PickerOrderList'
import PickerJobCard from './PickerJobCard'
import { useWmsModal } from '../useWmsModal'

export default function PickerLayout() {
  const { user, signOut } = useAuthContext()
  const [currentOrderId, setCurrentOrderId] = useState<string | null>(null)
  const [pickerItems, setPickerItems] = useState<any[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [timer, setTimer] = useState('00:00:00')
  const [showOrderList, setShowOrderList] = useState(true)
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const { showMessage, showConfirm, MessageModal, ConfirmModal } = useWmsModal()
  const [loggingOut, setLoggingOut] = useState(false)

  const ensurePlanDeptEnd = async (workOrderName: string) => {
    if (!workOrderName) return
    const { data, error } = await supabase.from('plan_jobs').select('id, tracks').eq('name', workOrderName).single()
    if (error || !data) return
    const tracks = (data.tracks || {}) as Record<string, Record<string, { start: string | null; end: string | null }>>
    const dept = 'เบิก'
    const procNames = ['ดึงกระดาษ/อุปกรณ์']
    tracks[dept] = tracks[dept] || {}
    procNames.forEach((p) => {
      if (!tracks[dept][p]) tracks[dept][p] = { start: null, end: null }
      if (!tracks[dept][p].start) tracks[dept][p].start = new Date().toISOString()
      tracks[dept][p].end = new Date().toISOString()
    })
    await supabase.from('plan_jobs').update({ tracks }).eq('id', data.id)
  }

  useEffect(() => {
    if (currentOrderId) {
      loadPickerTask().catch((err) => {
        console.error('Error in loadPickerTask:', err)
      })
    }
  }, [currentOrderId, currentIndex])

  useEffect(() => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current)
    }

    if (currentOrderId && pickerItems.length > 0 && currentIndex < pickerItems.length) {
      const currentItem = pickerItems[currentIndex]
      if (currentItem) {
        timerIntervalRef.current = setInterval(() => {
          setTimer(calculateDuration(currentItem.created_at, null))
        }, 1000)
      }
    } else {
      setTimer('00:00:00')
    }

    return () => {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current)
      }
    }
  }, [currentIndex, pickerItems, currentOrderId])

  const loadPickerTask = async () => {
    if (!currentOrderId) return 0

    const { data } = await supabase.from('wms_orders').select('*').eq('order_id', currentOrderId)

    if (!data || data.length === 0) {
      showMessage({ message: 'ไม่พบข้อมูลใบงาน!' })
      setCurrentOrderId(null)
      setShowOrderList(true)
      return 0
    }

    const hasWorkableItems = data.some((i) => ['pending', 'wrong', 'not_find'].includes(i.status))
    if (!hasWorkableItems) {
      showMessage({ message: 'ใบงานนี้จัดการครบทุกรายการแล้ว!' })
      setCurrentOrderId(null)
      setShowOrderList(true)
      return 0
    }

    const workableItems = data.filter((i) => ['pending', 'wrong', 'not_find'].includes(i.status))
    const sortedWorkableItems = sortOrderItems(workableItems)
    setPickerItems(sortedWorkableItems)

    if (currentIndex >= sortedWorkableItems.length) {
      setCurrentIndex(0)
    }

    return sortedWorkableItems.length
  }

  const selectOrder = (orderId: string) => {
    setCurrentOrderId(orderId)
    setCurrentIndex(0)
    setShowOrderList(false)
  }

  const backToOrderList = () => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current)
    }
    setCurrentOrderId(null)
    setCurrentIndex(0)
    setPickerItems([])
    setTimer('00:00:00')
    setShowOrderList(true)
  }

  const pickerFinishItem = async (itemId: string) => {
    try {
      const { error } = await supabase.from('wms_orders').update({ status: 'picked', end_time: new Date().toISOString() }).eq('id', itemId)

      if (error) {
        showMessage({ message: 'เกิดข้อผิดพลาด: ' + error.message })
        return
      }

      if (currentOrderId) {
        const { count } = await supabase
          .from('wms_orders')
          .select('id', { count: 'exact', head: true })
          .eq('order_id', currentOrderId)
          .neq('status', 'picked')
        if ((count || 0) === 0) {
          await ensurePlanDeptEnd(currentOrderId)
        }
      }

      const remainingCount = await loadPickerTask()
      if (remainingCount === 0) {
        return
      }

      setCurrentIndex((prev) => {
        const nextIndex = prev + 1
        if (nextIndex >= remainingCount) {
          return 0
        }
        return nextIndex
      })
    } catch (error: any) {
      showMessage({ message: 'เกิดข้อผิดพลาด: ' + error.message })
    }
  }

  const submitNoProduct = async (item: any) => {
    const ok = await showConfirm({ title: 'สินค้าหมด', message: 'แจ้งสินค้าหมด?' })
    if (!ok) return

    try {
      const { error: updateError } = await supabase
        .from('wms_orders')
        .update({ status: 'out_of_stock', end_time: new Date().toISOString() })
        .eq('id', item.id)

      if (updateError) {
        showMessage({ message: 'เกิดข้อผิดพลาด: ' + updateError.message })
        return
      }

      await supabase.from('wms_notifications').insert([
        {
          type: 'สินค้าหมด (X)',
          order_id: item.order_id,
          picker_id: user?.id,
          status: 'unread',
          is_read: false,
        },
      ])

      const remainingCount = await loadPickerTask()
      if (remainingCount === 0) {
        return
      }

      setCurrentIndex((prev) => {
        const nextIndex = prev + 1
        if (nextIndex >= remainingCount) {
          return 0
        }
        return nextIndex
      })
    } catch (error: any) {
      showMessage({ message: 'เกิดข้อผิดพลาด: ' + error.message })
    }
  }

  const pickerNavigate = (dir: number) => {
    if (pickerItems.length === 0) return
    setCurrentIndex((prev) => {
      const newIndex = prev + dir
      if (newIndex < 0) {
        return pickerItems.length - 1
      }
      if (newIndex >= pickerItems.length) {
        return 0
      }
      return newIndex
    })
  }

  const handleLogout = async () => {
    const ok = await showConfirm({ title: 'ออกจากระบบ', message: 'ยืนยันออกจากระบบ?' })
    if (!ok) return
    setLoggingOut(true)
    try {
      await signOut()
    } catch (error: any) {
      showMessage({ message: 'เกิดข้อผิดพลาด: ' + error.message })
    } finally {
      setLoggingOut(false)
    }
  }

  const currentItem = pickerItems[currentIndex]

  return (
    <div className="min-h-screen w-full bg-slate-900 text-white flex flex-col overflow-hidden rounded-none">
      <header className="p-3 border-b border-slate-800 flex items-center bg-slate-900/90 sticky top-0 z-20">
        {/* Left - fixed width */}
        <div className="flex items-center gap-2 w-1/3 min-w-0">
          {!showOrderList && (
            <button onClick={backToOrderList} className="bg-slate-700 w-8 h-8 rounded-full flex items-center justify-center shrink-0">
              <i className="fas fa-chevron-left text-xs"></i>
            </button>
          )}
          <div className="flex flex-col min-w-0">
            <span className="text-[16px] text-gray-500 font-black truncate">พนักงาน</span>
            <span className="text-[18.66px] font-bold text-blue-400 leading-tight truncate">{user?.username || user?.email || '---'}</span>
          </div>
        </div>
        {/* Center - timer always centered */}
        <div className="flex flex-col items-center w-1/3">
          <span className="text-[16px] text-gray-500 font-bold uppercase mb-1 text-center">ระยะเวลา</span>
          <span className="text-2xl font-mono font-black text-yellow-400">{timer}</span>
        </div>
        {/* Right - fixed width */}
        <div className="flex flex-col items-end gap-2 w-1/3">
          <button
            type="button"
            onClick={handleLogout}
            disabled={loggingOut}
            className="bg-red-600 hover:bg-red-700 text-white text-xs font-bold px-3 py-1.5 rounded-lg disabled:opacity-50"
          >
            {loggingOut ? 'กำลังออก...' : 'ออกจากระบบ'}
          </button>
          {!showOrderList && (
            <div className="text-2xl font-black text-white leading-none">
              <span className="text-green-400">{currentIndex + 1}</span>
              <span className="text-gray-600 mx-1">/</span>
              <span className="text-gray-400">{pickerItems.length}</span>
            </div>
          )}
        </div>
      </header>

      <div className="flex-1 flex flex-col p-4 justify-between overflow-hidden">
        {showOrderList ? (
          <PickerOrderList onSelectOrder={selectOrder} currentUserId={user?.id} />
        ) : currentItem ? (
          <PickerJobCard
            item={currentItem}
            allItems={pickerItems}
            currentIndex={currentIndex}
            totalItems={pickerItems.length}
            onFinish={() => pickerFinishItem(currentItem.id)}
            onNoProduct={() => submitNoProduct(currentItem)}
            onNavigate={(dir) => pickerNavigate(dir)}
          />
        ) : (
          <div className="text-center text-slate-500 italic py-20">ไม่มีงานมอบหมาย</div>
        )}
      </div>
      {MessageModal}
      {ConfirmModal}
    </div>
  )
}
