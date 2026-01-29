import React, { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { Order, WorkOrder } from '../../types'

interface WorkOrderManageListProps {
  searchTerm?: string
  channelFilter?: string
  onRefresh?: () => void
}

export default function WorkOrderManageList({
  searchTerm = '',
  channelFilter = '',
  onRefresh,
}: WorkOrderManageListProps) {
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedWo, setExpandedWo] = useState<string | null>(null)
  const [ordersByWo, setOrdersByWo] = useState<Record<string, Order[]>>({})
  const [selectedByWo, setSelectedByWo] = useState<Record<string, Set<string>>>({})
  const [editingTrackingId, setEditingTrackingId] = useState<string | null>(null)
  const [editingTrackingValue, setEditingTrackingValue] = useState('')
  const [updating, setUpdating] = useState(false)
  const [channels, setChannels] = useState<{ channel_code: string; channel_name: string }[]>([])

  useEffect(() => {
    loadWorkOrders()
  }, [channelFilter, searchTerm])

  useEffect(() => {
    async function loadChannels() {
      const { data } = await supabase.from('channels').select('channel_code, channel_name').order('channel_code')
      setChannels(data || [])
    }
    loadChannels()
  }, [])

  async function loadWorkOrders() {
    setLoading(true)
    try {
      let query = supabase
        .from('or_work_orders')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200)

      if (channelFilter) {
        query = query.like('work_order_name', `${channelFilter}-%`)
      }

      const { data, error } = await query
      if (error) throw error
      let list: WorkOrder[] = (data || []) as WorkOrder[]
      if (searchTerm.trim()) {
        const { data: orderMatch } = await supabase
          .from('or_orders')
          .select('work_order_name')
          .not('work_order_name', 'is', null)
          .or(`bill_no.ilike.%${searchTerm}%,customer_name.ilike.%${searchTerm}%`)
        const woNames = new Set((orderMatch || []).map((r: { work_order_name: string }) => r.work_order_name))
        list = list.filter((w) => woNames.has(w.work_order_name))
      }
      setWorkOrders(list)
      setOrdersByWo({})
      setSelectedByWo({})
      setExpandedWo(null)
    } catch (error: any) {
      console.error('Error loading work orders:', error)
      alert('เกิดข้อผิดพลาดในการโหลดข้อมูล: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  async function loadOrdersForWo(workOrderName: string) {
    try {
      const { data, error } = await supabase
        .from('or_orders')
        .select('id, bill_no, customer_name, tracking_number, channel_code, customer_address, status')
        .eq('work_order_name', workOrderName)
        .order('created_at', { ascending: false })

      if (error) throw error
      const list = (data || []) as Order[]
      setOrdersByWo((prev) => ({ ...prev, [workOrderName]: list }))
      setSelectedByWo((prev) => ({ ...prev, [workOrderName]: new Set<string>() }))
    } catch (error: any) {
      console.error('Error loading orders for WO:', error)
      alert('เกิดข้อผิดพลาด: ' + error.message)
    }
  }

  function toggleExpand(wo: WorkOrder) {
    if (expandedWo === wo.work_order_name) {
      setExpandedWo(null)
      return
    }
    setExpandedWo(wo.work_order_name)
    if (!ordersByWo[wo.work_order_name]) {
      loadOrdersForWo(wo.work_order_name)
    }
  }

  function toggleBillSelect(workOrderName: string, orderId: string) {
    setSelectedByWo((prev) => {
      const set = new Set(prev[workOrderName] || [])
      if (set.has(orderId)) set.delete(orderId)
      else set.add(orderId)
      return { ...prev, [workOrderName]: set }
    })
  }

  function selectAllBills(workOrderName: string) {
    const orders = ordersByWo[workOrderName] || []
    setSelectedByWo((prev) => ({ ...prev, [workOrderName]: new Set(orders.map((o) => o.id)) }))
  }

  function clearBillSelection(workOrderName: string) {
    setSelectedByWo((prev) => ({ ...prev, [workOrderName]: new Set<string>() }))
  }

  async function moveSelectedTo(workOrderName: string, newStatus: string) {
    const ids = Array.from(selectedByWo[workOrderName] || [])
    if (ids.length === 0) {
      alert('กรุณาเลือกบิลอย่างน้อย 1 รายการ')
      return
    }
    if (!confirm(`ต้องการย้าย ${ids.length} บิล ไปสถานะ "${newStatus}" หรือไม่?`)) return
    setUpdating(true)
    try {
      const updates: Record<string, unknown> = { status: newStatus }
      if (newStatus === 'รอลงข้อมูล' || newStatus === 'ตรวจสอบแล้ว') {
        updates.work_order_name = null
      }
      if (newStatus === 'ยกเลิก') {
        updates.work_order_name = null
      }
      const { error } = await supabase.from('or_orders').update(updates).in('id', ids)
      if (error) throw error
      await loadOrdersForWo(workOrderName)
      clearBillSelection(workOrderName)
      onRefresh?.()
    } catch (error: any) {
      alert('เกิดข้อผิดพลาด: ' + error.message)
    } finally {
      setUpdating(false)
    }
  }

  async function saveTrackingNumber(orderId: string) {
    const value = editingTrackingValue.trim()
    setUpdating(true)
    try {
      const { error } = await supabase
        .from('or_orders')
        .update({ tracking_number: value || null })
        .eq('id', orderId)
      if (error) throw error
      setEditingTrackingId(null)
      setEditingTrackingValue('')
      const woName = Object.keys(ordersByWo).find((wo) => ordersByWo[wo].some((o) => o.id === orderId))
      if (woName) await loadOrdersForWo(woName)
    } catch (error: any) {
      alert('เกิดข้อผิดพลาด: ' + error.message)
    } finally {
      setUpdating(false)
    }
  }

  if (loading && workOrders.length === 0) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {workOrders.length === 0 ? (
        <div className="text-center py-12 text-gray-500 bg-white rounded-lg border">
          ยังไม่มีใบงานที่สร้าง — สร้างได้ที่เมนู ใบสั่งงาน
        </div>
      ) : (
        <div className="space-y-2">
          {workOrders.map((wo) => {
            const orders = ordersByWo[wo.work_order_name] || []
            const selectedIds = selectedByWo[wo.work_order_name] || new Set<string>()
            const isExpanded = expandedWo === wo.work_order_name
            const hasShippingAddress = orders.some((o) => o.customer_address && o.customer_address.trim() !== '')
            const hasTrackingNumbers = orders.some((o) => o.tracking_number && o.tracking_number.trim() !== '')

            return (
              <div key={wo.id} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                {/* หัวใบงาน + ปุ่มด้านขวา */}
                <div
                  className="flex items-center justify-between gap-4 p-4 cursor-pointer hover:bg-gray-50 border-b border-gray-100"
                  onClick={() => toggleExpand(wo)}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-gray-400 select-none">{isExpanded ? '▼' : '▶'}</span>
                    <span className="font-semibold text-gray-900 truncate">
                      {wo.work_order_name} ({wo.order_count} บิล)
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="px-3 py-1.5 bg-green-100 text-green-800 rounded text-xs font-medium hover:bg-green-200">
                      ทำใบเบิก
                    </button>
                    <button type="button" className="px-3 py-1.5 bg-blue-100 text-blue-800 rounded text-xs font-medium hover:bg-blue-200">
                      Export (ไฟล์ผลิต)
                    </button>
                    <button type="button" className="px-3 py-1.5 bg-amber-100 text-amber-800 rounded text-xs font-medium hover:bg-amber-200">
                      ทำ Barcode
                    </button>
                    {hasShippingAddress && (
                      <button type="button" className="px-3 py-1.5 bg-yellow-100 text-yellow-800 rounded text-xs font-medium hover:bg-yellow-200">
                        Export (ใบปะหน้า)
                      </button>
                    )}
                    {hasTrackingNumbers && (
                      <button type="button" className="px-3 py-1.5 bg-orange-100 text-orange-800 rounded text-xs font-medium hover:bg-orange-200">
                        เรียงใบปะหน้า
                      </button>
                    )}
                    <button type="button" className="px-3 py-1.5 bg-cyan-100 text-cyan-800 rounded text-xs font-medium hover:bg-cyan-200">
                      นำเข้าเลขพัสดุ
                    </button>
                    <button type="button" className="px-3 py-1.5 bg-red-100 text-red-800 rounded text-xs font-medium hover:bg-red-200">
                      ยกเลิกใบงาน
                    </button>
                  </div>
                </div>

                {/* รายการบิล (เมื่อเปิด) */}
                {isExpanded && (
                  <div className="p-4 bg-gray-50 border-t border-gray-100">
                    {orders.length === 0 ? (
                      <div className="text-center py-6 text-gray-500">กำลังโหลด...</div>
                    ) : (
                      <>
                        {/* ปุ่มกลุ่ม: เลือกทั้งหมด, คืนไป รอลงข้อมูล, คืนไป ตรวจสอบแล้ว, ยกเลิกบิลที่เลือก */}
                        <div className="flex flex-wrap items-center gap-2 mb-4">
                          <button
                            type="button"
                            onClick={() => selectAllBills(wo.work_order_name)}
                            className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm hover:bg-gray-100"
                          >
                            เลือกทั้งหมด
                          </button>
                          <button
                            type="button"
                            onClick={() => moveSelectedTo(wo.work_order_name, 'รอลงข้อมูล')}
                            disabled={updating || selectedIds.size === 0}
                            className="px-3 py-1.5 bg-amber-100 text-amber-800 rounded-lg text-sm font-medium hover:bg-amber-200 disabled:opacity-50"
                          >
                            คืนไป &quot;รอลงข้อมูล&quot;
                          </button>
                          <button
                            type="button"
                            onClick={() => moveSelectedTo(wo.work_order_name, 'ตรวจสอบแล้ว')}
                            disabled={updating || selectedIds.size === 0}
                            className="px-3 py-1.5 bg-cyan-100 text-cyan-800 rounded-lg text-sm font-medium hover:bg-cyan-200 disabled:opacity-50"
                          >
                            คืนไป &quot;ตรวจสอบแล้ว&quot;
                          </button>
                          <button
                            type="button"
                            onClick={() => moveSelectedTo(wo.work_order_name, 'ยกเลิก')}
                            disabled={updating || selectedIds.size === 0}
                            className="px-3 py-1.5 bg-red-100 text-red-800 rounded-lg text-sm font-medium hover:bg-red-200 disabled:opacity-50"
                          >
                            ยกเลิกบิลที่เลือก
                          </button>
                        </div>

                        {/* ตารางบิล: checkbox | เลขบิล + ชื่อลูกค้า | เลขพัสดุ (คลิกแก้ไข) */}
                        <div className="bg-white rounded-lg border overflow-hidden">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="bg-gray-100 border-b">
                                <th className="w-10 p-2 text-left">
                                  <input
                                    type="checkbox"
                                    checked={selectedIds.size === orders.length && orders.length > 0}
                                    onChange={(e) => (e.target.checked ? selectAllBills(wo.work_order_name) : clearBillSelection(wo.work_order_name))}
                                    className="rounded border-gray-300"
                                  />
                                </th>
                                <th className="p-2 text-left font-medium">เลขบิล / ชื่อลูกค้า</th>
                                <th className="p-2 text-left font-medium w-48">เลขพัสดุ</th>
                              </tr>
                            </thead>
                            <tbody>
                              {orders.map((order) => (
                                <tr key={order.id} className="border-b border-gray-100 hover:bg-gray-50">
                                  <td className="p-2 align-middle">
                                    <input
                                      type="checkbox"
                                      checked={selectedIds.has(order.id)}
                                      onChange={() => toggleBillSelect(wo.work_order_name, order.id)}
                                      className="rounded border-gray-300"
                                    />
                                  </td>
                                  <td className="p-2 align-middle">
                                    <span className="text-blue-600 font-medium">{order.bill_no}</span>
                                    <span className="text-gray-600 ml-1">{order.customer_name ?? '-'}</span>
                                  </td>
                                  <td className="p-2 align-middle">
                                    {editingTrackingId === order.id ? (
                                      <div className="flex items-center gap-1">
                                        <input
                                          type="text"
                                          value={editingTrackingValue}
                                          onChange={(e) => setEditingTrackingValue(e.target.value)}
                                          onKeyDown={(e) => {
                                            if (e.key === 'Enter') saveTrackingNumber(order.id)
                                            if (e.key === 'Escape') setEditingTrackingId(null)
                                          }}
                                          className="flex-1 px-2 py-1 border rounded text-sm"
                                          autoFocus
                                        />
                                        <button
                                          type="button"
                                          onClick={() => saveTrackingNumber(order.id)}
                                          disabled={updating}
                                          className="px-2 py-1 bg-blue-500 text-white rounded text-xs"
                                        >
                                          บันทึก
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => setEditingTrackingId(null)}
                                          className="px-2 py-1 border rounded text-xs"
                                        >
                                          ยกเลิก
                                        </button>
                                      </div>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setEditingTrackingId(order.id)
                                          setEditingTrackingValue(order.tracking_number || '')
                                        }}
                                        className="flex items-center gap-1 text-left w-full px-2 py-1 rounded hover:bg-gray-100 text-gray-700"
                                      >
                                        {order.tracking_number ? (
                                          <span>{order.tracking_number}</span>
                                        ) : (
                                          <span className="text-gray-400">ยังไม่มีเลขพัสดุ</span>
                                        )}
                                        <span className="text-gray-400 text-xs">✎</span>
                                      </button>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
