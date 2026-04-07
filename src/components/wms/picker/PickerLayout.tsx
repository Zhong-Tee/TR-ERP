import { useState, useEffect, useRef, useMemo } from 'react'
import { useAuthContext } from '../../../contexts/AuthContext'
import { supabase } from '../../../lib/supabase'
import { fetchPlanDeptSettings } from '../../../lib/planPickingDepartments'
import type { PlanDeptSettings } from '../../../lib/planPickingDepartments'
import {
  enrichWmsRowsWithPickingDepartment,
  getDepartmentOptionsForWmsRows,
} from '../../../lib/wmsPickingDepartmentEnrichment'
import { calculateDuration, sortOrderItems, WMS_FULFILLMENT_PICK_OR_LEGACY } from '../wmsUtils'
import { dedupeWmsNotificationsForDisplay } from '../../../lib/wmsNotificationEnrichment'
import PickerOrderList from './PickerOrderList'
import PickerJobCard from './PickerJobCard'
import SentAlertsModal from './SentAlertsModal'
import ProductionParcelReturn from '../production/ProductionParcelReturn'
import PurchaseGR from '../../../pages/PurchaseGR'
import { useWmsModal } from '../useWmsModal'
import { consolidateCondoStampWmsDisplayRows, getWmsConsolidatedRowIds } from '../../../lib/wmsCondoStampConsolidation'

type ViewKey = 'menu' | 'pick' | 'parcel-return' | 'gr-receive'

const MENU_ITEMS: { key: ViewKey; label: string; icon: string; desc: string; color: string }[] = [
  { key: 'pick', label: 'หยิบของ', icon: 'fas fa-hand-holding-box fa-hand-paper', desc: 'หยิบสินค้าตามใบงาน', color: 'from-blue-600 to-blue-800' },
  { key: 'gr-receive', label: 'รับ GR', icon: 'fas fa-truck-ramp-box', desc: 'ตรวจรับสินค้าเข้าคลัง', color: 'from-emerald-600 to-emerald-800' },
  { key: 'parcel-return', label: 'รับสินค้าตีกลับ', icon: 'fas fa-barcode', desc: 'สแกนเลขพัสดุรับคืนจากลูกค้า', color: 'from-purple-600 to-purple-800' },
]

const WORKABLE_STATUSES = ['pending', 'wrong', 'not_find']
type PickerScope = { type: 'work_order' | 'order'; id: string }

export default function PickerLayout() {
  const { user, signOut } = useAuthContext()
  const [activeView, setActiveView] = useState<ViewKey>('menu')
  const [currentOrderId, setCurrentOrderId] = useState<string | null>(null)
  const [pickerItems, setPickerItems] = useState<any[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [timer, setTimer] = useState('00:00:00')
  const [showOrderList, setShowOrderList] = useState(true)
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const { showMessage, showConfirm, MessageModal, ConfirmModal } = useWmsModal()
  const [loggingOut, setLoggingOut] = useState(false)
  const [showSentAlertsModal, setShowSentAlertsModal] = useState(false)
  const [pendingAlertCount, setPendingAlertCount] = useState(0)
  const [pickerPlanSettings, setPickerPlanSettings] = useState<PlanDeptSettings | null>(null)
  const [pickerDeptFilter, setPickerDeptFilter] = useState('')
  const pickerItemsRef = useRef<any[]>([])
  useEffect(() => {
    pickerItemsRef.current = pickerItems
  }, [pickerItems])

  const displayPickerItems = useMemo(() => {
    if (!pickerDeptFilter) return pickerItems
    return pickerItems.filter((i) => String(i.picking_department || '') === pickerDeptFilter)
  }, [pickerItems, pickerDeptFilter])

  const parsePickerScope = (raw: string | null): PickerScope | null => {
    if (!raw) return null
    if (raw.startsWith('wo:')) return { type: 'work_order', id: raw.slice(3) }
    if (raw.startsWith('ord:')) return { type: 'order', id: raw.slice(4) }
    return { type: 'work_order', id: raw }
  }

  const findNextWorkableIndex = (items: any[], fromIndex: number): number => {
    for (let i = fromIndex + 1; i < items.length; i++) {
      if (WORKABLE_STATUSES.includes(items[i].status)) return i
    }
    for (let i = 0; i <= fromIndex; i++) {
      if (WORKABLE_STATUSES.includes(items[i].status)) return i
    }
    return -1
  }

  useEffect(() => {
    if (currentOrderId) {
      loadPickerTask()
        .then((sortedItems) => {
          if (sortedItems) {
            const firstWorkable = sortedItems.findIndex((i) => WORKABLE_STATUSES.includes(i.status))
            if (firstWorkable >= 0) setCurrentIndex(firstWorkable)
          }
        })
        .catch((err) => {
          console.error('Error in loadPickerTask:', err)
        })
    }
  }, [currentOrderId])

  useEffect(() => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current)
    }

    if (currentOrderId && displayPickerItems.length > 0 && currentIndex < displayPickerItems.length) {
      const currentItem = displayPickerItems[currentIndex]
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
  }, [currentIndex, displayPickerItems, currentOrderId])

  useEffect(() => {
    if (!user?.id) return

    const loadPendingAlerts = async () => {
      const { data } = await supabase
        .from('wms_notifications')
        .select('id, type, order_id')
        .eq('picker_id', user.id)
        .eq('status', 'unread')
      setPendingAlertCount(dedupeWmsNotificationsForDisplay(data || []).length)
    }

    loadPendingAlerts()
    const channel = supabase
      .channel(`picker-pending-alert-count-${user.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_notifications' }, () => {
        loadPendingAlerts()
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [user?.id])

  const loadPickerTask = async (): Promise<any[] | null> => {
    const scope = parsePickerScope(currentOrderId)
    if (!scope) return null

    let query = supabase
      .from('wms_orders')
      .select('*')
      .or(WMS_FULFILLMENT_PICK_OR_LEGACY)

    if (scope.type === 'work_order') {
      query = query.eq('work_order_id', scope.id)
    } else {
      query = query.eq('order_id', scope.id)
    }

    const { data } = await query

    if (!data || data.length === 0) {
      showMessage({ message: 'ไม่พบข้อมูลใบงาน!' })
      setCurrentOrderId(null)
      setShowOrderList(true)
      return null
    }

    let sortedItems = sortOrderItems(data)
    const srcIds = [...new Set(sortedItems.map((i: any) => i.source_order_id).filter(Boolean))]
    if (srcIds.length > 0) {
      const { data: billRows } = await supabase
        .from('or_orders')
        .select('id, bill_no, plan_released_from_work_order')
        .in('id', srcIds as string[])
      const billMap = Object.fromEntries((billRows || []).map((r: any) => [r.id, r]))
      sortedItems = sortedItems.map((i: any) => {
        const b = i.source_order_id ? billMap[i.source_order_id] : null
        return {
          ...i,
          source_bill_no: b?.bill_no ?? null,
          source_bill_released_from_wo: b?.plan_released_from_work_order ?? null,
        }
      })
    }

    const planSettings = await fetchPlanDeptSettings()
    setPickerPlanSettings(planSettings)
    const enrichedItems = await enrichWmsRowsWithPickingDepartment(sortedItems, planSettings)
    const consolidatedItems = consolidateCondoStampWmsDisplayRows(enrichedItems as any[])
    setPickerItems(consolidatedItems)

    const hasWorkableItems = consolidatedItems.some((i) => WORKABLE_STATUSES.includes(i.status))
    if (!hasWorkableItems) {
      showMessage({ message: 'ใบงานนี้จัดการครบทุกรายการแล้ว!' })
      setCurrentOrderId(null)
      setShowOrderList(true)
      return null
    }

    return consolidatedItems
  }

  const selectOrder = (orderId: string) => {
    setPickerDeptFilter('')
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
    setPickerDeptFilter('')
    setPickerPlanSettings(null)
    setTimer('00:00:00')
    setShowOrderList(true)
  }

  useEffect(() => {
    if (!pickerDeptFilter) return
    const items = pickerItemsRef.current
    if (!currentOrderId || items.length === 0) return
    const display = items.filter((i) => String(i.picking_department || '') === pickerDeptFilter)
    const first = display.findIndex((i) => WORKABLE_STATUSES.includes(i.status))
    if (first >= 0) setCurrentIndex(first)
    else setCurrentIndex(0)
  }, [pickerDeptFilter, currentOrderId])

  useEffect(() => {
    if (displayPickerItems.length === 0) return
    setCurrentIndex((idx) => Math.min(idx, displayPickerItems.length - 1))
  }, [displayPickerItems.length])

  const advanceAfterWorkableUpdate = async () => {
    const sortedItems = await loadPickerTask()
    if (!sortedItems) return
    const display = pickerDeptFilter
      ? sortedItems.filter((i) => String(i.picking_department || '') === pickerDeptFilter)
      : sortedItems
    const nextIdx = findNextWorkableIndex(display, currentIndex)
    if (nextIdx >= 0) {
      setCurrentIndex(nextIdx)
    } else if (pickerDeptFilter && !display.some((i) => WORKABLE_STATUSES.includes(i.status))) {
      showMessage({
        message: 'ไม่มีรายการค้างในชุดแผนกที่เลือก — เปลี่ยนเป็น “ทั้งหมด” หรือแผนกอื่น',
      })
    }
  }

  const pickerFinishItem = async (item: { id: string; _consolidated_wms_ids?: string[] }) => {
    try {
      const ids = getWmsConsolidatedRowIds(item)
      const { error } = await supabase
        .from('wms_orders')
        .update({ status: 'picked', end_time: new Date().toISOString() })
        .in('id', ids)

      if (error) {
        showMessage({ message: 'เกิดข้อผิดพลาด: ' + error.message })
        return
      }

      await advanceAfterWorkableUpdate()
    } catch (error: any) {
      showMessage({ message: 'เกิดข้อผิดพลาด: ' + error.message })
    }
  }

  const pickerSkipMovedItem = async (item: any) => {
    try {
      const ids = getWmsConsolidatedRowIds(item)
      const { error } = await supabase
        .from('wms_orders')
        .update({
          status: 'cancelled',
          end_time: new Date().toISOString(),
        })
        .in('id', ids)

      if (error) {
        showMessage({ message: 'เกิดข้อผิดพลาด: ' + error.message })
        return
      }

      await supabase.from('wms_notifications').insert([
        {
          type: 'ข้ามรายการ (บิลถูกย้ายออก)',
          order_id: item.order_id,
          picker_id: user?.id,
          status: 'unread',
          is_read: false,
        },
      ])

      await advanceAfterWorkableUpdate()
    } catch (error: any) {
      showMessage({ message: 'เกิดข้อผิดพลาด: ' + error.message })
    }
  }

  const submitNoProduct = async (item: any) => {
    const ok = await showConfirm({ title: 'สินค้าหมด', message: 'แจ้งสินค้าหมด?' })
    if (!ok) return

    try {
      const ids = getWmsConsolidatedRowIds(item)
      const { error: updateError } = await supabase
        .from('wms_orders')
        .update({ status: 'out_of_stock', end_time: new Date().toISOString() })
        .in('id', ids)

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

      await advanceAfterWorkableUpdate()
    } catch (error: any) {
      showMessage({ message: 'เกิดข้อผิดพลาด: ' + error.message })
    }
  }

  const pickerNavigate = (dir: number) => {
    if (displayPickerItems.length === 0) return
    setCurrentIndex((prev) => {
      const newIndex = prev + dir
      if (newIndex < 0) return displayPickerItems.length - 1
      if (newIndex >= displayPickerItems.length) return 0
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

  const currentItem = displayPickerItems[currentIndex]
  const activeLabel = MENU_ITEMS.find((m) => m.key === activeView)?.label || ''

  const handleBackToMenu = () => {
    backToOrderList()
    setActiveView('menu')
  }

  return (
    <div className="min-h-screen w-full bg-slate-900 text-white flex flex-col overflow-hidden rounded-none">
      <header className="p-3 border-b border-slate-800 flex items-center justify-between bg-slate-900/90 sticky top-0 z-20">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {activeView !== 'menu' && (
            <button
              type="button"
              onClick={handleBackToMenu}
              className="shrink-0 w-9 h-9 rounded-xl bg-slate-700 text-white flex items-center justify-center hover:bg-slate-600 active:bg-slate-500"
            >
              <i className="fas fa-arrow-left text-sm" />
            </button>
          )}
          <div className="flex flex-col min-w-0">
            <span className="text-xs text-gray-500 font-bold uppercase truncate">
              {activeView === 'menu' ? 'พนักงานหยิบสินค้า' : activeLabel}
            </span>
            <span className="text-sm font-black text-blue-400 leading-tight truncate">
              {user?.username || user?.email || '---'}
            </span>
          </div>
        </div>

        {activeView === 'pick' && !showOrderList && (
          <div className="flex flex-col items-center px-2">
            <span className="text-[10px] text-gray-500 font-bold uppercase">ระยะเวลา</span>
            <span className="text-lg font-mono font-black text-yellow-400">{timer}</span>
          </div>
        )}

        <div className="flex items-center gap-2 shrink-0">
          {activeView === 'pick' && (
            <button
              type="button"
              onClick={() => setShowSentAlertsModal(true)}
              className="relative bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold px-3 py-1.5 rounded-lg"
            >
              ดูแจ้งเตือน
              {pendingAlertCount > 0 && (
                <span className="absolute -top-2 -right-2 min-w-[20px] h-5 px-1 rounded-full bg-red-500 text-white text-[10px] font-black flex items-center justify-center">
                  {pendingAlertCount}
                </span>
              )}
            </button>
          )}
          {activeView === 'pick' && !showOrderList && (
            <div className="text-xl font-black text-white leading-none">
              <span className="text-green-400">{currentIndex + 1}</span>
              <span className="text-gray-600 mx-1">/</span>
              <span className="text-gray-400">{displayPickerItems.length}</span>
            </div>
          )}
          <button
            type="button"
            onClick={handleLogout}
            disabled={loggingOut}
            className="bg-red-600 hover:bg-red-700 text-white text-xs font-bold px-3 py-1.5 rounded-lg disabled:opacity-50"
          >
            {loggingOut ? 'กำลังออก...' : 'ออกจากระบบ'}
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto flex flex-col">
        {activeView === 'menu' && (
          <div className="p-4 space-y-3">
            <div className="text-center py-4">
              <div className="text-2xl font-black text-white">พนักงานหยิบสินค้า</div>
              <div className="text-sm text-gray-400 mt-1">เลือกเมนูที่ต้องการ</div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {MENU_ITEMS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setActiveView(item.key)}
                  className={`rounded-2xl bg-gradient-to-br ${item.color} p-4 text-left transition-all hover:scale-[1.02] active:scale-[0.98] shadow-lg`}
                >
                  <i className={`${item.icon} text-2xl text-white/80 mb-3 block`} />
                  <div className="font-bold text-base text-white leading-tight">{item.label}</div>
                  <div className="text-[10px] text-white/60 mt-1 leading-tight">{item.desc}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {activeView === 'pick' && (
          <div className="flex-1 flex flex-col p-4 justify-between overflow-hidden">
            {showOrderList ? (
              <PickerOrderList onSelectOrder={selectOrder} currentUserId={user?.id} />
            ) : pickerItems.length > 0 && displayPickerItems.length === 0 ? (
              <div className="text-center text-amber-300 font-bold py-16 px-4 leading-relaxed">
                ไม่มีรายการในแผนกนี้ — เลือก &quot;ทั้งหมด (ใบงาน)&quot; หรือแผนกอื่น
              </div>
            ) : currentItem ? (
              <>
                {pickerPlanSettings && pickerItems.length > 0 && (
                  <div className="shrink-0 mb-3">
                    <label className="text-[10px] text-slate-500 font-bold uppercase block mb-1">เลือกแผนกหยิบ</label>
                    <select
                      value={pickerDeptFilter}
                      onChange={(e) => setPickerDeptFilter(e.target.value)}
                      className="w-full rounded-2xl bg-slate-800 text-white border border-slate-600 px-3 py-2.5 text-sm font-bold outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">ทั้งหมด (ใบงาน)</option>
                      {getDepartmentOptionsForWmsRows(pickerPlanSettings, pickerItems).map((d) => {
                        const pending = pickerItems.filter(
                          (i) =>
                            String(i.picking_department || '') === d && WORKABLE_STATUSES.includes(i.status)
                        ).length
                        return (
                          <option key={d} value={d}>
                            {d}
                            {pending > 0 ? ` — ค้าง ${pending}` : ''}
                          </option>
                        )
                      })}
                    </select>
                  </div>
                )}
                <PickerJobCard
                  item={currentItem}
                  allItems={displayPickerItems}
                  currentIndex={currentIndex}
                  totalItems={displayPickerItems.length}
                  onFinish={() => {
                    const moved = !!(currentItem.plan_line_released || currentItem.source_bill_released_from_wo)
                    if (moved) {
                      pickerSkipMovedItem(currentItem)
                    } else {
                      pickerFinishItem(currentItem)
                    }
                  }}
                  onNoProduct={() => submitNoProduct(currentItem)}
                  onNavigate={(dir) => pickerNavigate(dir)}
                  onJumpToItem={(itemId) => {
                    const idx = displayPickerItems.findIndex((i) => i.id === itemId)
                    if (idx >= 0) setCurrentIndex(idx)
                  }}
                />
              </>
            ) : (
              <div className="text-center text-slate-500 italic py-20">ไม่มีงานมอบหมาย</div>
            )}
          </div>
        )}

        {activeView === 'parcel-return' && <ProductionParcelReturn />}
        {activeView === 'gr-receive' && <PurchaseGR />}
      </div>
      {showSentAlertsModal && user?.id && (
        <SentAlertsModal pickerId={user.id} onClose={() => setShowSentAlertsModal(false)} />
      )}
      {MessageModal}
      {ConfirmModal}
    </div>
  )
}
