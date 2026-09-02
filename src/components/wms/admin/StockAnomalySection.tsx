import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../../lib/supabase'
import { useAuthContext } from '../../../contexts/AuthContext'
import { useWmsModal } from '../useWmsModal'
import Modal from '../../ui/Modal'

type AnomalyRow = {
  order_item_id: string
  bill_no: string
  entry_date: string
  work_order_name: string | null
  product_code: string
  product_name: string
  unit_name: string
  expected_qty: number
  wms_qty: number
  correct_qty: number
  deducted_qty: number
  anomaly_type: 'missing_wms' | 'excess_wms' | 'not_correct' | 'stock_movement_mismatch' | 'legacy_conflict' | 'unknown'
  repairable: boolean
}

type BulkRepairError = { bill_no?: string; product_code?: string; error?: string }
type BulkRepairResult = {
  repaired_rows?: number
  repaired_qty?: number
  system_complete_rows?: number
  picker_rows?: number
  skipped_rows?: number
  errors?: BulkRepairError[]
}

const readableRepairError = (message?: string) => {
  const text = String(message || '')
  const insufficient = text.match(/insufficient sellable lots for product [\w-]+, short by ([\d.]+)/i)
  if (insufficient) return { reason: 'สต๊อคล็อตพร้อมขายไม่เพียงพอ', shortage: Number(insufficient[1]) }
  if (/ไม่พบผู้หยิบ|picker/i.test(text)) return { reason: 'ไม่พบผู้รับผิดชอบ Picker ของใบงาน', shortage: null }
  if (/legacy|รุ่นเก่า|movement/i.test(text)) return { reason: 'พบข้อมูล WMS/Movement รุ่นเก่า ต้องตรวจสอบก่อน', shortage: null }
  return { reason: text || 'ไม่ทราบสาเหตุ', shortage: null }
}

const today = () => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

export default function StockAnomalySection() {
  const { user } = useAuthContext()
  const [fromDate, setFromDate] = useState(today())
  const [toDate, setToDate] = useState(today())
  const [rows, setRows] = useState<AnomalyRow[]>([])
  const [loading, setLoading] = useState(false)
  const [repairing, setRepairing] = useState<string | null>(null)
  const [bulkRepairing, setBulkRepairing] = useState(false)
  const [bulkResult, setBulkResult] = useState<BulkRepairResult | null>(null)
  const { showMessage, showConfirm, MessageModal, ConfirmModal } = useWmsModal()
  const canRepair = ['superadmin', 'admin', 'store'].includes(user?.role || '')

  const load = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase.rpc('rpc_get_wms_stock_anomalies', {
      p_from_date: fromDate,
      p_to_date: toDate,
    })
    setLoading(false)
    if (error) {
      showMessage({ message: `โหลดรายการผิดปกติไม่สำเร็จ: ${error.message}` })
      return
    }
    setRows((data || []) as AnomalyRow[])
  }, [fromDate, toDate, showMessage])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const repair = async (row: AnomalyRow) => {
    const ok = await showConfirm({
      title: 'ยืนยันการซ่อมรายการ',
      message: `สร้างรายการ WMS ที่ขาดของ ${row.product_code} ในบิล ${row.bill_no} ใช่หรือไม่?`,
    })
    if (!ok) return
    setRepairing(row.order_item_id)
    const { data, error } = await supabase.rpc('rpc_repair_wms_missing_item', { p_order_item_id: row.order_item_id })
    setRepairing(null)
    if (error) {
      showMessage({ message: `ซ่อมรายการไม่สำเร็จ: ${error.message}` })
      return
    }
    const result = data as { created_qty?: number; mode?: string }
    showMessage({ message: `ซ่อมสำเร็จ ${result.created_qty || 0} ${row.unit_name}${result.mode === 'warehouse_pick' ? ' — ส่งเข้าคิว Picker แล้ว' : ' — ตัดสต๊อคแล้ว'}` })
    window.dispatchEvent(new CustomEvent('wms-data-changed'))
    load()
  }

  const repairAll = async () => {
    const safeRows = rows.filter((row) => row.anomaly_type === 'missing_wms' && row.repairable)
    const repairQty = safeRows.reduce((sum, row) => sum + Math.max(Number(row.expected_qty) - Number(row.wms_qty), 0), 0)
    if (safeRows.length === 0) return
    const ok = await showConfirm({
      title: 'ยืนยันซ่อมรายการทั้งหมดที่ปลอดภัย',
      message: `ระบบตรวจพบ ${safeRows.length} บรรทัด รวม ${repairQty.toLocaleString('th-TH')} หน่วยที่ซ่อมได้\n\nสินค้าไม่ต้อง Picker จะถูกตัดสต๊อคทันที ส่วนสินค้าที่ต้อง Picker จะถูกส่งเข้าคิวหยิบ\nรายการที่พบ WMS/Movement รุ่นเก่าจะถูกบล็อกและไม่ตัดสต๊อค`,
      confirmText: 'ยืนยันซ่อมทั้งหมด',
    })
    if (!ok) return
    setBulkRepairing(true)
    const { data, error } = await supabase.rpc('rpc_repair_all_wms_missing_items', {
      p_from_date: fromDate,
      p_to_date: toDate,
    })
    setBulkRepairing(false)
    if (error) {
      showMessage({ message: `ซ่อมรายการทั้งหมดไม่สำเร็จ: ${error.message}` })
      return
    }
    setBulkResult(data as BulkRepairResult)
    window.dispatchEvent(new CustomEvent('wms-data-changed'))
    load()
  }

  const anomalyLabel = (row: AnomalyRow) => {
    if (row.anomaly_type === 'missing_wms') return 'รายการ WMS ขาด'
    if (row.anomaly_type === 'excess_wms') return 'รายการ WMS เกิน'
    if (row.anomaly_type === 'not_correct') return 'ยังไม่มีการหยิบถูกครบ'
    if (row.anomaly_type === 'stock_movement_mismatch') return 'ยอดตัดสต๊อคไม่ตรง'
    if (row.anomaly_type === 'legacy_conflict') return 'พบข้อมูล WMS/Movement รุ่นเก่า'
    return 'ต้องตรวจสอบ'
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <div><label className="mb-1 block text-xs font-bold text-slate-600">วันที่เริ่มต้น</label><input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="rounded-xl border px-3 py-2" /></div>
          <div><label className="mb-1 block text-xs font-bold text-slate-600">วันที่สิ้นสุด</label><input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="rounded-xl border px-3 py-2" /></div>
          <button onClick={load} disabled={loading} className="rounded-xl bg-blue-600 px-5 py-2 font-bold text-white disabled:opacity-50">{loading ? 'กำลังตรวจ...' : 'ตรวจสอบ'}</button>
          {rows.some((row) => row.anomaly_type === 'missing_wms' && row.repairable) && canRepair && <button onClick={repairAll} disabled={bulkRepairing || loading} className="ml-auto rounded-xl bg-emerald-600 px-5 py-2 font-bold text-white disabled:opacity-50">{bulkRepairing ? 'กำลังซ่อมทั้งหมด...' : `ซ่อมทั้งหมด (${rows.filter((row) => row.anomaly_type === 'missing_wms' && row.repairable).length})`}</button>}
          <div className={`${rows.some((row) => row.anomaly_type === 'missing_wms' && row.repairable) && canRepair ? '' : 'ml-auto'} rounded-xl px-4 py-2 font-bold ${rows.length ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>{rows.length ? `พบ ${rows.length} รายการ` : 'ไม่พบความผิดปกติ'}</div>
        </div>
      </div>

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-red-200 bg-white shadow-sm">
          <table className="w-full min-w-[1050px] text-sm">
            <thead className="bg-red-50 text-left text-xs font-bold text-red-800"><tr><th className="p-3">วันที่ / บิล</th><th className="p-3">ใบงาน</th><th className="p-3">สินค้า</th><th className="p-3 text-center">ขาย</th><th className="p-3 text-center">WMS</th><th className="p-3 text-center">หยิบถูก</th><th className="p-3 text-center">ตัดสต๊อค</th><th className="p-3">ปัญหา</th><th className="p-3 text-center">จัดการ</th></tr></thead>
            <tbody className="divide-y">
              {rows.map((row) => <tr key={row.order_item_id} className="hover:bg-slate-50">
                <td className="p-3"><div>{row.entry_date}</div><div className="font-bold text-blue-700">{row.bill_no}</div></td>
                <td className="p-3">{row.work_order_name || '-'}</td>
                <td className="p-3"><div className="font-bold">{row.product_name}</div><div className="text-xs text-slate-500">{row.product_code}</div></td>
                <td className="p-3 text-center font-bold">{row.expected_qty}</td><td className="p-3 text-center">{row.wms_qty}</td><td className="p-3 text-center">{row.correct_qty}</td><td className="p-3 text-center">{row.deducted_qty}</td>
                <td className="p-3"><span className="rounded-full bg-red-100 px-3 py-1 text-xs font-bold text-red-700">{anomalyLabel(row)}</span></td>
                <td className="p-3 text-center">{row.repairable && canRepair ? <button onClick={() => repair(row)} disabled={repairing === row.order_item_id} className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{repairing === row.order_item_id ? 'กำลังซ่อม...' : 'ซ่อมรายการ'}</button> : <span className="text-xs text-slate-500">ตรวจด้วยตนเอง</span>}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={bulkResult !== null} onClose={() => setBulkResult(null)} closeOnBackdropClick={false} contentClassName="max-w-4xl">
        {bulkResult && (
          <div className="p-6 sm:p-8">
            <div className="mb-5 pr-10">
              <h3 className="text-xl font-black text-slate-800">ผลการซ่อมรายการ</h3>
              <p className="mt-1 text-sm text-slate-500">สรุปผลการทำงานและรายการที่ระบบยังไม่แก้ไข</p>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-xl bg-emerald-50 p-4"><div className="text-xs font-bold text-emerald-700">ซ่อมสำเร็จ</div><div className="mt-1 text-2xl font-black text-emerald-700">{bulkResult.repaired_rows || 0}</div><div className="text-xs text-emerald-600">{bulkResult.repaired_qty || 0} หน่วย</div></div>
              <div className="rounded-xl bg-blue-50 p-4"><div className="text-xs font-bold text-blue-700">ตัดอัตโนมัติ</div><div className="mt-1 text-2xl font-black text-blue-700">{bulkResult.system_complete_rows || 0}</div><div className="text-xs text-blue-600">รายการ</div></div>
              <div className="rounded-xl bg-violet-50 p-4"><div className="text-xs font-bold text-violet-700">ส่งเข้า Picker</div><div className="mt-1 text-2xl font-black text-violet-700">{bulkResult.picker_rows || 0}</div><div className="text-xs text-violet-600">รายการ</div></div>
              <div className="rounded-xl bg-amber-50 p-4"><div className="text-xs font-bold text-amber-700">ยังไม่ได้ซ่อม</div><div className="mt-1 text-2xl font-black text-amber-700">{bulkResult.skipped_rows || 0}</div><div className="text-xs text-amber-600">รายการ</div></div>
            </div>

            {(bulkResult.repaired_rows || 0) === 0 && (bulkResult.skipped_rows || 0) > 0 && (
              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
                ยังไม่มีสต๊อคถูกตัด ระบบหยุดรายการเหล่านี้ไว้เพื่อป้องกันยอดติดลบหรือตัดซ้ำ
              </div>
            )}

            {(bulkResult.errors || []).length > 0 && (
              <div className="mt-5">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h4 className="font-bold text-slate-800">รายการที่ต้องตรวจสอบ</h4>
                  <span className="text-xs text-slate-500">แสดง {(bulkResult.errors || []).length} รายการแรกจาก {bulkResult.skipped_rows || 0}</span>
                </div>
                <div className="max-h-[42vh] overflow-auto rounded-xl border border-slate-200">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead className="sticky top-0 bg-slate-100 text-left text-xs text-slate-600">
                      <tr><th className="px-4 py-3">บิล</th><th className="px-4 py-3">รหัสสินค้า</th><th className="px-4 py-3">สาเหตุ</th><th className="px-4 py-3 text-center">จำนวนขาด</th></tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {(bulkResult.errors || []).map((item, index) => {
                        const detail = readableRepairError(item.error)
                        return <tr key={`${item.bill_no}-${item.product_code}-${index}`} className="align-top">
                          <td className="px-4 py-3 font-bold text-blue-700">{item.bill_no || '-'}</td>
                          <td className="px-4 py-3 font-mono font-semibold text-slate-700">{item.product_code || '-'}</td>
                          <td className="px-4 py-3 text-slate-700">{detail.reason}</td>
                          <td className="px-4 py-3 text-center font-bold text-red-600">{detail.shortage === null ? '-' : detail.shortage}</td>
                        </tr>
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="mt-6 flex justify-end">
              <button type="button" onClick={() => setBulkResult(null)} className="rounded-lg bg-blue-600 px-5 py-2.5 font-bold text-white hover:bg-blue-700">ตกลง</button>
            </div>
          </div>
        )}
      </Modal>
      {MessageModal}{ConfirmModal}
    </div>
  )
}
