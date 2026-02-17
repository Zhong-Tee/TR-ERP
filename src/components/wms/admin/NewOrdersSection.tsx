import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../../lib/supabase'
import Modal from '../../ui/Modal'
import { useWmsModal } from '../useWmsModal'

// Category matching — same groups as Plan Dashboard "เบิก"
const MAIN_KEYWORDS = ['STAMP', 'LASER']
const ETC_CATEGORIES = ['CALENDAR', 'ETC', 'INK']
const isMainCategory = (cat: string): boolean => {
  const upper = (cat || '').toUpperCase()
  if (MAIN_KEYWORDS.some((kw) => upper.includes(kw))) return true
  if (ETC_CATEGORIES.includes(upper)) return true
  return false
}

export default function NewOrdersSection() {
  const [workOrders, setWorkOrders] = useState<Array<{ id: string; work_order_name: string; order_count: number; created_at: string }>>([])
  const [pickers, setPickers] = useState<Array<{ id: string; username: string | null }>>([])
  const [selectedWorkOrder, setSelectedWorkOrder] = useState<string | null>(null)
  const [selectedPickerId, setSelectedPickerId] = useState('')
  const [loading, setLoading] = useState(true)
  const [assigning, setAssigning] = useState(false)
  const { showMessage, MessageModal } = useWmsModal()

  const ensurePlanDeptStart = async (workOrderName: string) => {
    if (!workOrderName) return
    const now = new Date().toISOString()
    const { error } = await supabase.rpc('merge_plan_tracks_by_name', {
      p_job_name: workOrderName,
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
    return () => {
      supabase.removeChannel(woChannel)
      supabase.removeChannel(ordersChannel)
    }
  }, [])

  const loadWorkOrders = async () => {
    setLoading(true)
    const { data } = await supabase
      .from('or_work_orders')
      .select('id, work_order_name, order_count, created_at')
      .eq('status', 'กำลังผลิต')
      .order('created_at', { ascending: false })

    if (!data || data.length === 0) {
      setWorkOrders([])
      setLoading(false)
      return
    }

    // กรองเฉพาะใบงานที่ยังไม่ได้มอบหมาย Picker (ไม่มีใน wms_orders)
    const woNames = data.map((wo) => wo.work_order_name)
    const { data: assignedRows } = await supabase
      .from('wms_orders')
      .select('order_id')
      .in('order_id', woNames)
    const assignedSet = new Set((assignedRows || []).map((r: any) => r.order_id))
    const unassigned = data.filter((wo) => !assignedSet.has(wo.work_order_name))

    // กรองเฉพาะใบงานที่มีสินค้าในหมวดหมู่ที่ต้องหยิบ (STAMP/LASER/ETC)
    if (unassigned.length > 0) {
      const unassignedNames = unassigned.map((wo) => wo.work_order_name)
      const { data: orders } = await supabase
        .from('or_orders')
        .select('work_order_name, or_order_items(product_id)')
        .in('work_order_name', unassignedNames)

      const allItems = (orders || []).flatMap((o: any) =>
        (o.or_order_items || []).map((i: any) => ({ product_id: i.product_id, work_order_name: o.work_order_name }))
      )
      const productIds = [...new Set(allItems.map((i: any) => i.product_id).filter(Boolean))]

      let productCategoryMap: Record<string, string> = {}
      if (productIds.length > 0) {
        const { data: products } = await supabase.from('pr_products').select('id, product_category').in('id', productIds)
        productCategoryMap = (products || []).reduce((acc: Record<string, string>, p: any) => {
          acc[p.id] = p.product_category || ''
          return acc
        }, {})
      }

      const woWithPickableItems = new Set<string>()
      allItems.forEach((item: any) => {
        if (isMainCategory(productCategoryMap[item.product_id] || '')) {
          woWithPickableItems.add(item.work_order_name)
        }
      })

      setWorkOrders(unassigned.filter((wo) => woWithPickableItems.has(wo.work_order_name)))
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

  const openAssignPicker = (workOrderName: string) => {
    setSelectedWorkOrder(workOrderName)
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
        .eq('order_id', selectedWorkOrder)
      if ((count || 0) > 0) {
        showMessage({ message: 'ใบงานนี้ถูกสร้างในระบบ WMS แล้ว' })
        return
      }

      const { data: orders } = await supabase
        .from('or_orders')
        .select('id, work_order_name, or_order_items(product_id, product_name, quantity)')
        .eq('work_order_name', selectedWorkOrder)

      const items = (orders || []).flatMap((o: any) => o.or_order_items || [])
      if (items.length === 0) {
        showMessage({ message: 'ไม่พบรายการสินค้าในใบงานนี้' })
        return
      }

      const productIds = Array.from(new Set(items.map((i: any) => i.product_id).filter(Boolean)))
      let productMap: Record<string, { product_code?: string; storage_location?: string; product_category?: string; rubber_code?: string }> = {}
      if (productIds.length > 0) {
        const { data: products } = await supabase
          .from('pr_products')
          .select('id, product_code, storage_location, product_category, rubber_code')
          .in('id', productIds)
        productMap = (products || []).reduce((acc: Record<string, any>, p: any) => {
          acc[p.id] = { product_code: p.product_code, storage_location: p.storage_location, product_category: p.product_category, rubber_code: p.rubber_code }
          return acc
        }, {})
      }

      // Normal items (filtered by category) — CONDO STAMP รวม 5 ชั้นเป็น 1 รายการ
      const filteredItems = items.filter((item: any) => {
        const cat = productMap[item.product_id]?.product_category || ''
        return isMainCategory(cat)
      })

      // Group by product_id เพื่อรวม CONDO STAMP (5 ชั้น → 1 รายการ)
      const groupedByProduct = new Map<string, { product_id: string; product_name: string; totalQty: number }>()
      filteredItems.forEach((item: any) => {
        const key = item.product_id || item.product_name
        const existing = groupedByProduct.get(key)
        if (existing) {
          existing.totalQty += item.quantity || 1
        } else {
          groupedByProduct.set(key, { product_id: item.product_id, product_name: item.product_name || 'N/A', totalQty: item.quantity || 1 })
        }
      })

      const normalRows = Array.from(groupedByProduct.values()).map((group) => {
        const cat = (productMap[group.product_id]?.product_category || '').toUpperCase()
        // CONDO STAMP: 5 ชั้น = 1 ชุด → หาร 5 แล้วปัดขึ้น
        const qty = cat.includes('CONDO STAMP') ? Math.ceil(group.totalQty / 5) : group.totalQty
        return {
          order_id: selectedWorkOrder,
          product_code: productMap[group.product_id]?.product_code || group.product_name || 'N/A',
          product_name: group.product_name,
          location: productMap[group.product_id]?.storage_location || '',
          qty,
          assigned_to: selectedPickerId,
          status: 'pending',
        }
      })

      // Spare parts (grouped by rubber_code)
      const spareMap = new Map<string, number>()
      items.forEach((item: any) => {
        const rc = productMap[item.product_id]?.rubber_code
        const cat = productMap[item.product_id]?.product_category || ''
        if (rc && isMainCategory(cat)) {
          spareMap.set(rc, (spareMap.get(rc) || 0) + (item.quantity || 1))
        }
      })
      const spareRows = Array.from(spareMap.entries()).map(([rc, spareQty]) => ({
        order_id: selectedWorkOrder,
        product_code: 'SPARE_PART',
        product_name: `หน้ายาง+โฟม ${rc}`,
        location: 'อะไหล่',
        qty: spareQty,
        assigned_to: selectedPickerId,
        status: 'pending',
      }))

      const wmsRows = [...normalRows, ...spareRows]

      if (wmsRows.length === 0) {
        showMessage({ message: 'ไม่มีสินค้าในหมวดหมู่ที่ต้องหยิบในใบงานนี้' })
        return
      }

      const { error } = await supabase.from('wms_orders').insert(wmsRows)
      if (error) throw error

      await ensurePlanDeptStart(selectedWorkOrder)
      showMessage({ message: `มอบหมายใบงาน ${selectedWorkOrder} ให้ Picker เรียบร้อยแล้ว` })
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

  if (workOrders.length === 0) {
    return <div className="text-center text-slate-500 italic py-20">ไม่มีใบงานใหม่</div>
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <h2 className="text-xl font-black mb-4">ใบงานใหม่</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 overflow-y-auto pb-4">
        {workOrders.map((wo) => (
          <button
            key={wo.id}
            className="p-4 border rounded-lg text-left transition-colors bg-gray-100 border-gray-200 hover:bg-gray-200"
            onClick={() => openAssignPicker(wo.work_order_name)}
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="text-lg font-semibold">📦 {wo.work_order_name}</div>
                <div className="text-sm text-gray-600">{wo.order_count} บิล</div>
              </div>
              <span className="text-blue-600 font-medium">เลือก Picker</span>
            </div>
          </button>
        ))}
      </div>

      <Modal open={!!selectedWorkOrder} onClose={closeAssignPicker} closeOnBackdropClick={true} contentClassName="max-w-md">
        <div className="p-6">
          <h3 className="text-lg font-bold text-slate-800 mb-2">เลือก User Picker</h3>
          <p className="text-sm text-slate-600 mb-4">ใบงาน: {selectedWorkOrder}</p>
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
