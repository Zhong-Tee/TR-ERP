import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../../lib/supabase'
import Modal from '../../ui/Modal'
import { useWmsModal } from '../useWmsModal'
import { fetchWorkOrderNamesWithWmsAssigned } from '../wmsUtils'

function dedupeWorkOrdersByName<T extends { work_order_name: string }>(rows: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const r of rows) {
    const n = r.work_order_name
    if (!n || seen.has(n)) continue
    seen.add(n)
    out.push(r)
  }
  return out
}

// Category matching — same groups as Plan Dashboard "เบิก" + SUBLIMATION + อะไหล่ (rubber_code)
const MAIN_KEYWORDS = ['STAMP', 'LASER', 'SUBLIMATION']
const ETC_CATEGORIES = ['CALENDAR', 'ETC', 'INK']
const isMainCategory = (cat: string, rubberCode?: string): boolean => {
  if ((rubberCode || '').trim() !== '') return true
  const upper = (cat || '').toUpperCase()
  if (MAIN_KEYWORDS.some((kw) => upper.includes(kw))) return true
  if (ETC_CATEGORIES.includes(upper)) return true
  return false
}

export default function NewOrdersSection() {
  const [workOrders, setWorkOrders] = useState<
    Array<{ id: string; work_order_name: string; order_count: number; created_at: string; plan_wo_modified?: boolean }>
  >([])
  const [pickers, setPickers] = useState<Array<{ id: string; username: string | null }>>([])
  const [selectedWorkOrder, setSelectedWorkOrder] = useState<string | null>(null)
  const [selectedPickerId, setSelectedPickerId] = useState('')
  const [loading, setLoading] = useState(true)
  const [assigning, setAssigning] = useState(false)
  const { showMessage, MessageModal } = useWmsModal()

  const ensurePlanDeptStart = async (workOrderId: string) => {
    if (!workOrderId) return
    const now = new Date().toISOString()
    const { error } = await supabase.rpc('merge_plan_tracks_by_work_order_id', {
      p_work_order_id: workOrderId,
      p_dept: 'เบิก',
      p_patch: { 'หยิบของ': { start_if_null: now } },
    })
    if (error) console.error('ensurePlanDeptStart error:', error.message)
  }

  useEffect(() => {
    loadWorkOrders()
    loadPickers()
    const woChannel = supabase
      .channel('wms-new-workorders')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_work_orders' }, () => {
        loadWorkOrders()
        window.dispatchEvent(new Event('wms-data-changed'))
      })
      .subscribe()
    const ordersChannel = supabase
      .channel('wms-new-workorders-orders')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_orders' }, () => {
        loadWorkOrders()
        window.dispatchEvent(new Event('wms-data-changed'))
      })
      .subscribe()
    const wmsChannel = supabase
      .channel('wms-new-workorders-wms')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'wms_orders' }, () => {
        loadWorkOrders()
        window.dispatchEvent(new Event('wms-data-changed'))
      })
      .subscribe()
    return () => {
      supabase.removeChannel(woChannel)
      supabase.removeChannel(ordersChannel)
      supabase.removeChannel(wmsChannel)
    }
  }, [])

  const loadWorkOrders = async () => {
    setLoading(true)
    const { data } = await supabase
      .from('or_work_orders')
      .select('id, work_order_name, order_count, created_at, plan_wo_modified')
      .eq('status', 'กำลังผลิต')
      .order('created_at', { ascending: false })

    if (!data || data.length === 0) {
      setWorkOrders([])
      setLoading(false)
      return
    }

    const deduped = dedupeWorkOrdersByName(data)
    const assignedNames = await fetchWorkOrderNamesWithWmsAssigned()
    const unassigned = deduped.filter((wo) => !assignedNames.has(wo.work_order_name))

    // กรองเฉพาะใบงานที่มีสินค้าในหมวดหมู่ที่ต้องหยิบ (STAMP/LASER/SUBLIMATION/CALENDAR/ETC/INK)
    if (unassigned.length > 0) {
      const unassignedIds = unassigned.map((wo) => wo.id)
      const { data: orders } = await supabase
        .from('or_orders')
        .select('work_order_id, or_order_items(product_id, is_free)')
        .in('work_order_id', unassignedIds as string[])

      const allItems = (orders || []).flatMap((o: any) =>
        (o.or_order_items || []).map((i: any) => ({
          product_id: i.product_id,
          work_order_id: o.work_order_id,
          is_free: i.is_free,
        }))
      )
      const productIds = [...new Set(allItems.map((i: any) => i.product_id).filter(Boolean))]

      let productCategoryMap: Record<string, string> = {}
      if (productIds.length > 0) {
        const { data: products } = await supabase
          .from('pr_products')
          .select('id, product_category, rubber_code')
          .in('id', productIds)
        productCategoryMap = (products || []).reduce((acc: Record<string, string>, p: any) => {
          const category = String(p.product_category || '')
          const rubberCode = String(p.rubber_code || '').trim()
          // เก็บ rubber_code เป็น marker ใน map เดียว เพื่อลดการแตก state/map เพิ่ม
          acc[p.id] = rubberCode ? `${category}__RUBBER__${rubberCode}` : category
          return acc
        }, {})
      }

      const woQualifiesForAssign = new Set<string>()
      allItems.forEach((item: any) => {
        if (!item.product_id) return
        const raw = productCategoryMap[item.product_id] || ''
        const marker = '__RUBBER__'
        const markerIdx = raw.indexOf(marker)
        const hasRubber = markerIdx >= 0
        const cat = hasRubber ? raw.slice(0, markerIdx) : raw
        const rubberCode = hasRubber ? raw.slice(markerIdx + marker.length) : ''
        if (isMainCategory(cat, rubberCode) && item.work_order_id) {
          woQualifiesForAssign.add(String(item.work_order_id))
        }
      })

      setWorkOrders(unassigned.filter((wo) => woQualifiesForAssign.has(wo.id)))
    } else {
      setWorkOrders([])
    }

    setLoading(false)
  }

  const loadPickers = async () => {
    const { data } = await supabase.from('us_users').select('id, username').eq('role', 'picker').order('username')
    setPickers((data || []) as Array<{ id: string; username: string | null }>)
  }

  const pickerOptions = useMemo(() => pickers, [pickers])

  const openAssignPicker = (workOrderId: string) => {
    setSelectedWorkOrder(workOrderId)
    setSelectedPickerId('')
  }

  const closeAssignPicker = () => {
    setSelectedWorkOrder(null)
    setSelectedPickerId('')
  }

  const handleAssignPicker = async () => {
    if (!selectedWorkOrder) return
    if (!selectedPickerId) {
      showMessage({ message: 'กรุณาเลือก User Picker' })
      return
    }
    setAssigning(true)
    try {
      const { count } = await supabase
        .from('wms_orders')
        .select('id', { count: 'exact', head: true })
        .eq('work_order_id', selectedWorkOrder)
      if ((count || 0) > 0) {
        showMessage({ message: 'ใบงานนี้ถูกสร้างในระบบ WMS แล้ว' })
        return
      }

      const { data: rpcResult, error: rpcError } = await supabase.rpc('rpc_assign_wms_for_work_order_v2', {
        p_work_order_id: selectedWorkOrder,
        p_picker_id: selectedPickerId,
      })
      if (rpcError) throw rpcError

      const result = rpcResult as {
        success?: boolean
        error?: string
        warehouse_pick_main?: number
        warehouse_pick_spare?: number
        system_complete?: number
      }
      if (!result || !result.success) {
        showMessage({ message: result?.error || 'มอบหมาย WMS ไม่สำเร็จ' })
        return
      }

      await ensurePlanDeptStart(selectedWorkOrder)
      const woName = workOrders.find((w) => w.id === selectedWorkOrder)?.work_order_name || selectedWorkOrder
      showMessage({ message: `มอบหมายใบงาน ${woName} ให้ Picker เรียบร้อยแล้ว` })
      closeAssignPicker()
      loadWorkOrders()
      window.dispatchEvent(new Event('wms-data-changed'))
    } catch (error: any) {
      showMessage({ message: 'เกิดข้อผิดพลาด: ' + error.message })
    } finally {
      setAssigning(false)
    }
  }

  if (loading) {
    return <div className="text-center text-slate-400 py-10">กำลังโหลด...</div>
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <h2 className="text-xl font-black mb-4">ใบงานใหม่</h2>
      <p className="text-sm text-slate-600 mb-3">
        แสดง<strong>เฉพาะ</strong>ใบงานที่ยัง<strong>ไม่ได้มอบหมาย Picker</strong> และมีสินค้าที่ต้องหยิบคลัง — ใบงานที่มอบหมายแล้วหรือปิดงานแล้วดูที่เมนู{' '}
        <strong>รายการใบงาน</strong> หรือหน้ามือถือของ Picker
      </p>
      {workOrders.length === 0 ? (
        <div className="text-center text-slate-500 italic py-10 border border-dashed border-slate-200 rounded-lg">
          ไม่มีใบงานใหม่ที่รอมอบหมาย Picker
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 overflow-y-auto pb-4">
          {workOrders.map((wo) => (
            <button
              key={wo.id}
              className="p-4 border rounded-lg text-left transition-colors bg-gray-100 border-gray-200 hover:bg-gray-200"
              onClick={() => openAssignPicker(wo.id)}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-lg font-semibold flex flex-wrap items-center gap-2">
                    <span>📦 {wo.work_order_name}</span>
                    {wo.plan_wo_modified && (
                      <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 border border-amber-300">
                        ถูกแก้ไข
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-gray-600">{wo.order_count} บิล</div>
                </div>
                <span className="text-blue-600 font-medium shrink-0">เลือก Picker</span>
              </div>
            </button>
          ))}
        </div>
      )}

      <Modal open={!!selectedWorkOrder} onClose={closeAssignPicker} closeOnBackdropClick={true} contentClassName="max-w-md">
        <div className="p-6">
          <h3 className="text-lg font-bold text-slate-800 mb-2">เลือก User Picker</h3>
          <p className="text-sm text-slate-600 mb-4">
            ใบงาน: {workOrders.find((w) => w.id === selectedWorkOrder)?.work_order_name || selectedWorkOrder}
          </p>
          <select
            value={selectedPickerId}
            onChange={(e) => setSelectedPickerId(e.target.value)}
            className="w-full border rounded-lg px-3 py-2 mb-4"
          >
            <option value="">-- เลือก User Picker --</option>
            {pickerOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.username || p.id}
              </option>
            ))}
          </select>
          {pickerOptions.length === 0 && (
            <div className="text-xs text-red-500 mb-4">ยังไม่มีผู้ใช้ Role picker กรุณาตั้งค่าในเมนู ตั้งค่า → จัดการสิทธิ์ผู้ใช้</div>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={closeAssignPicker} className="px-4 py-2 border rounded-lg">
              ยกเลิก
            </button>
            <button
              type="button"
              onClick={handleAssignPicker}
              disabled={assigning || pickerOptions.length === 0}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white disabled:opacity-50"
            >
              {assigning ? 'กำลังบันทึก...' : 'ยืนยัน'}
            </button>
          </div>
        </div>
      </Modal>
      {MessageModal}
    </div>
  )
}
