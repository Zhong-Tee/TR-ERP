import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAuthContext } from '../contexts/AuthContext'
import type { MachineryMachine } from '../lib/machineryApi'
import type { MachineryIncident } from '../lib/machineryOperationsApi'
import {
  fetchAvailableMachineParts,
  fetchMachineryPartHistory,
  returnMachineryPart,
  useMachineryPart,
  type MachineryPartUsage,
  type MachinerySpareProduct,
} from '../lib/machinerySpareApi'
import { canUseMachinerySpares } from '../lib/machinerySpareAccess'

function currentLocalDateTimeValue(): string {
  const now = new Date()
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

export function MachineryPartUsageModal({ incident, machineName, onClose, onSaved }: {
  incident: MachineryIncident
  machineName: string
  onClose: () => void
  onSaved: () => void
}) {
  const [parts, setParts] = useState<MachinerySpareProduct[]>([])
  const [productId, setProductId] = useState('')
  const [qty, setQty] = useState('')
  const [note, setNote] = useState('')
  const [performedAt, setPerformedAt] = useState(currentLocalDateTimeValue)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    fetchAvailableMachineParts(incident.machine_id)
      .then((rows) => { setParts(rows); setProductId(rows[0]?.product_id || '') })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [incident.machine_id])
  const selected = parts.find((part) => part.product_id === productId)
  async function save() {
    const amount = Number(qty)
    if (!productId || !Number.isInteger(amount) || amount <= 0) { setError('กรุณาเลือกอะไหล่และระบุจำนวนเต็มมากกว่า 0'); return }
    const actualDateTime = new Date(performedAt)
    if (!performedAt || Number.isNaN(actualDateTime.getTime())) { setError('กรุณาระบุวันที่และเวลาใช้อะไหล่'); return }
    setSaving(true); setError('')
    try { await useMachineryPart(incident.id, productId, amount, note, actualDateTime.toISOString()); onSaved(); onClose() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setSaving(false) }
  }
  return createPortal(<div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
    <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl">
      <div className="flex items-start justify-between gap-4"><div><h3 className="text-xl font-bold">บันทึกเปลี่ยนอะไหล่</h3><p className="text-sm text-gray-500">{incident.ticket_no} · {machineName}</p></div><button onClick={onClose} className="rounded-full bg-red-600 px-3 py-1.5 font-bold text-white">×</button></div>
      {error && <div className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {loading ? <div className="py-10 text-center text-gray-500">กำลังโหลดอะไหล่...</div> : <div className="mt-4 space-y-4">
        <label className="block"><span className="mb-1 block text-sm font-semibold">อะไหล่</span><select value={productId} onChange={(event) => setProductId(event.target.value)} className="w-full rounded-xl border px-3 py-2.5"><option value="">— เลือกอะไหล่ —</option>{parts.map((part) => <option key={part.product_id} value={part.product_id}>{part.product_code} · {part.product_name} (เหลือ {part.machinery_qty.toLocaleString()})</option>)}</select></label>
        {parts.length === 0 && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">ยังไม่ได้กำหนดอะไหล่ให้เครื่องนี้ หรือไม่มีรายการที่เปิดใช้งาน</div>}
        <div className="grid grid-cols-2 gap-3"><label><span className="mb-1 block text-sm font-semibold">จำนวนที่ใช้</span><input type="number" inputMode="numeric" min="1" step="1" value={qty} onWheel={(event) => event.currentTarget.blur()} onKeyDown={(event) => { if (['.', ',', 'e', 'E', '+', '-'].includes(event.key)) event.preventDefault() }} onChange={(event) => { const value = event.target.value; if (value === '' || /^\d+$/.test(value)) setQty(value) }} className="w-full rounded-xl border px-3 py-2.5"/></label><div><span className="mb-1 block text-sm font-semibold">คงเหลือ Machinery</span><div className="rounded-xl bg-emerald-50 px-3 py-2.5 font-bold text-emerald-800">{selected?.machinery_qty.toLocaleString() || '0'} {selected?.unit_name || 'ชิ้น'}</div></div></div>
        <label className="block"><span className="mb-1 block text-sm font-semibold">วันที่และเวลาใช้อะไหล่</span><input type="datetime-local" required value={performedAt} onChange={(event) => setPerformedAt(event.target.value)} className="w-full rounded-xl border px-3 py-2.5"/></label>
        <label className="block"><span className="mb-1 block text-sm font-semibold">หมายเหตุ</span><textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} className="w-full rounded-xl border px-3 py-2.5"/></label>
        <div className="flex justify-end gap-2"><button onClick={onClose} className="rounded-lg border px-4 py-2">ยกเลิก</button><button disabled={saving || parts.length === 0} onClick={() => void save()} className="rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white disabled:opacity-50">{saving ? 'กำลังบันทึก...' : 'บันทึกการใช้อะไหล่'}</button></div>
      </div>}
    </div>
  </div>, document.body)
}

export function MachineryPartHistoryDrawer({ machine, onClose }: { machine: MachineryMachine; onClose: () => void }) {
  const { user } = useAuthContext()
  const [rows, setRows] = useState<MachineryPartUsage[]>([])
  const [loading, setLoading] = useState(true)
  const [returningId, setReturningId] = useState<string | null>(null)
  const [returnQty, setReturnQty] = useState('')
  const [error, setError] = useState('')
  const canReturn = canUseMachinerySpares(user?.role)
  const load = () => fetchMachineryPartHistory(machine.id).then(setRows).catch((e) => setError(e instanceof Error ? e.message : String(e))).finally(() => setLoading(false))
  useEffect(() => { void load() }, [machine.id])
  const returnedByUsage = useMemo(() => {
    const result: Record<string, number> = {}
    rows.filter((row) => row.event_type === 'return' && row.return_of_id).forEach((row) => { result[row.return_of_id as string] = (result[row.return_of_id as string] || 0) + row.qty })
    return result
  }, [rows])
  async function submitReturn(usage: MachineryPartUsage) {
    const amount = Number(returnQty)
    if (!Number.isInteger(amount) || amount <= 0) { setError('กรุณาระบุจำนวนคืนเป็นจำนวนเต็มมากกว่า 0'); return }
    setError('')
    try { await returnMachineryPart(usage.id, amount); setReturningId(null); setReturnQty(''); setLoading(true); await load() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  return createPortal(<div className="fixed inset-0 z-[100] bg-black/40" role="dialog" aria-modal="true"><aside className="ml-auto flex h-full w-full max-w-2xl flex-col bg-white shadow-2xl">
    <div className="flex items-start justify-between border-b p-5"><div><h3 className="text-xl font-bold">ประวัติอะไหล่</h3><p className="text-sm text-gray-500">{machine.name}</p><p className="mt-1 text-xs text-emerald-700">กด “คืนอะไหล่” ที่รายการใช้งาน เพื่อคืนจำนวนกลับเข้าสต๊อก Machinery</p></div><button onClick={onClose} className="rounded-full bg-red-600 px-3 py-1.5 font-bold text-white">×</button></div>
    {error && <div className="m-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
    <div className="flex-1 overflow-y-auto p-4">{loading ? <div className="py-12 text-center text-gray-500">กำลังโหลดประวัติ...</div> : rows.length === 0 ? <div className="py-12 text-center text-gray-500">ยังไม่มีประวัติการใช้อะไหล่</div> : <div className="space-y-3">{rows.map((row) => {
      const remainingReturnable = row.event_type === 'use' ? Math.max(0, row.qty - (returnedByUsage[row.id] || 0)) : 0
      return <article key={row.id} className={`rounded-xl border p-4 ${row.event_type === 'return' ? 'border-emerald-200 bg-emerald-50' : 'border-blue-200 bg-blue-50'}`}><div className="flex items-start justify-between gap-3"><div><div className="font-bold">{row.event_type === 'use' ? 'ใช้อะไหล่' : 'คืนอะไหล่'} · {row.product_code}</div><div>{row.product_name}</div><div className="mt-1 text-xs text-gray-500">{row.ticket_no} · {new Date(row.performed_at).toLocaleString('th-TH')} · {row.performed_by_name}</div>{row.note && <div className="mt-1 text-sm text-gray-600">{row.note}</div>}</div><div className={`shrink-0 text-lg font-black ${row.event_type === 'return' ? 'text-emerald-700' : 'text-blue-700'}`}>{row.event_type === 'return' ? '+' : '-'}{row.qty.toLocaleString()} <span className="text-xs">{row.unit_name || 'ชิ้น'}</span></div></div>
        {canReturn && row.event_type === 'use' && remainingReturnable > 0 && (returningId === row.id ? <div className="mt-3 flex gap-2 border-t pt-3"><input type="number" inputMode="numeric" min="1" max={remainingReturnable} step="1" value={returnQty} onWheel={(event) => event.currentTarget.blur()} onKeyDown={(event) => { if (['.', ',', 'e', 'E', '+', '-'].includes(event.key)) event.preventDefault() }} onChange={(event) => { const value = event.target.value; if (value === '' || /^\d+$/.test(value)) setReturnQty(value) }} placeholder={`คืนได้ ${remainingReturnable}`} className="min-w-0 flex-1 rounded-lg border bg-white px-3 py-2"/><button onClick={() => void submitReturn(row)} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white">ยืนยันคืน</button><button onClick={() => setReturningId(null)} className="rounded-lg border bg-white px-3 py-2 text-sm">ยกเลิก</button></div> : <div className="mt-3 flex justify-end"><button onClick={() => { setReturningId(row.id); setReturnQty('') }} className="rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-sm font-semibold text-emerald-700">คืนอะไหล่</button></div>)}
      </article>
    })}</div>}</div>
  </aside></div>, document.body)
}
