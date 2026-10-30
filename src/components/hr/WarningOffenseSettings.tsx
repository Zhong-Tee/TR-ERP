import { useEffect, useState } from 'react'
import { useAuthContext } from '../../contexts/AuthContext'
import { fetchWarningOffenseTypes, saveWarningOffenseType, setWarningOffenseTypeActive } from '../../lib/hrApi'
import type { HRWarningOffenseType } from '../../types'
import Modal from '../ui/Modal'

type OffenseForm = { id?: string; name: string; days: string; active: boolean }
const describeError = (error: unknown) => error instanceof Error ? error.message : 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่'

export default function WarningOffenseSettings() {
  const { user } = useAuthContext()
  const canManage = ['superadmin', 'admin', 'account', 'hr'].includes(user?.role ?? '')
  const [items, setItems] = useState<HRWarningOffenseType[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [form, setForm] = useState<OffenseForm | null>(null)
  const [formError, setFormError] = useState('')
  const [toggleTarget, setToggleTarget] = useState<HRWarningOffenseType | null>(null)
  const [toggleError, setToggleError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetchWarningOffenseTypes(false)
      .then(data => { if (!cancelled) setItems(data) })
      .catch(e => { if (!cancelled) setError(describeError(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const replaceItem = (saved: HRWarningOffenseType) => {
    setItems(previous => [...previous.filter(item => item.id !== saved.id), saved]
      .sort((a, b) => a.name.localeCompare(b.name, 'th')))
  }

  const openForm = (item?: HRWarningOffenseType) => {
    setFormError('')
    setMessage('')
    setForm(item
      ? { id: item.id, name: item.name, days: String(item.lookback_days ?? 365), active: item.is_active }
      : { name: '', days: '365', active: true })
  }

  const save = async () => {
    if (!form || !canManage || busy) return
    const name = form.name.trim()
    const days = Number(form.days)
    if (!name) { setFormError('กรุณาระบุชื่อประเภทความผิด'); return }
    if (!form.days.trim() || !Number.isInteger(days) || days < 1 || days > 2147483647) {
      setFormError('ระยะเวลาย้อนหลังต้องเป็นจำนวนเต็มตั้งแต่ 1 ถึง 2,147,483,647 วัน'); return
    }
    if (items.some(item => item.id !== form.id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setFormError('มีชื่อประเภทความผิดนี้แล้ว กรุณาใช้ชื่ออื่น'); return
    }
    setBusy(true)
    setFormError('')
    try {
      replaceItem(await saveWarningOffenseType({ id: form.id, name, lookback_days: days, is_active: form.active }))
      setForm(null)
      setMessage('บันทึกประเภทความผิดเรียบร้อยแล้ว')
    } catch (e) { setFormError(describeError(e)) }
    finally { setBusy(false) }
  }

  const toggleActive = async () => {
    if (!toggleTarget || !canManage || busy) return
    setBusy(true)
    setToggleError('')
    try {
      replaceItem(await setWarningOffenseTypeActive(toggleTarget.id, !toggleTarget.is_active))
      setMessage(toggleTarget.is_active ? 'ปิดใช้งานประเภทความผิดแล้ว' : 'เปิดใช้งานประเภทความผิดแล้ว')
      setToggleTarget(null)
    } catch (e) { setToggleError(describeError(e)) }
    finally { setBusy(false) }
  }

  const inputClass = 'mt-1 w-full rounded-xl border border-surface-200 px-3 py-2'
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h3 className="text-lg font-semibold">ประเภทความผิด</h3>
        <p className="mt-1 text-sm text-gray-500">จัดการประเภทความผิดสำหรับใบเตือน รายการที่ปิดใช้งานจะไม่แสดงให้เลือกสร้างเคสใหม่ และยังเก็บประวัติใบเตือนเดิมไว้</p>
      </div>
      {canManage && <button type="button" disabled={loading || !!error} onClick={() => openForm()} className="rounded-xl bg-emerald-600 px-4 py-2 text-white disabled:opacity-50">+ เพิ่มประเภทความผิด</button>}
    </div>
    {error && <div role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}<button type="button" onClick={() => { setLoading(true); setError(''); void fetchWarningOffenseTypes(false).then(setItems).catch(e => setError(describeError(e))).finally(() => setLoading(false)) }} className="ml-3 underline">ลองใหม่</button></div>}
    {message && <div role="status" className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">{message}</div>}
    <div className="overflow-x-auto rounded-xl border border-surface-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-surface-50"><tr>
          <th className="p-3 text-left">ชื่อประเภทความผิด</th>
          <th className="p-3 text-left">ระยะเวลานับประวัติย้อนหลัง (วัน)</th>
          <th className="p-3 text-left">สถานะ</th>
          {canManage && <th className="p-3 text-left">จัดการ</th>}
        </tr></thead>
        <tbody>
          {loading ? <tr><td colSpan={canManage ? 4 : 3} className="p-8 text-center text-gray-400">กำลังโหลด...</td></tr>
            : items.map(item => <tr key={item.id} className="border-t border-surface-100">
              <td className="p-3">{item.name}</td>
              <td className="p-3">{item.lookback_days ?? 365}</td>
              <td className="p-3"><span className={`rounded-full px-2 py-1 text-xs ${item.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>{item.is_active ? 'เปิดใช้งาน' : 'ปิดใช้งาน'}</span></td>
              {canManage && <td className="p-3"><div className="flex gap-4 whitespace-nowrap">
                <button type="button" disabled={busy} onClick={() => openForm(item)} className="text-blue-600 disabled:opacity-50">แก้ไข</button>
                <button type="button" disabled={busy} onClick={() => { setToggleError(''); setMessage(''); setToggleTarget(item) }} className="text-gray-600 disabled:opacity-50">{item.is_active ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}</button>
              </div></td>}
            </tr>)}
          {!loading && !error && items.length === 0 && <tr><td colSpan={canManage ? 4 : 3} className="p-8 text-center text-gray-400">ยังไม่มีประเภทความผิด</td></tr>}
        </tbody>
      </table>
    </div>
    <Modal open={!!form} onClose={() => { if (!busy) setForm(null) }} contentClassName="max-w-lg" ariaLabelledby="offense-form-title" showCloseButton={!busy}>
      {form && <form noValidate className="space-y-4 p-6" onSubmit={e => { e.preventDefault(); void save() }}>
        <h3 id="offense-form-title" className="pr-10 text-lg font-semibold">{form.id ? 'แก้ไขประเภทความผิด' : 'เพิ่มประเภทความผิด'}</h3>
        {formError && <div role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{formError}</div>}
        <fieldset disabled={busy} className="space-y-4">
          <label className="block text-sm">ชื่อประเภทความผิด *<input autoFocus value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className={inputClass} /></label>
          <label className="block text-sm">ระยะเวลานับประวัติย้อนหลัง (วัน) *<input type="number" min={1} max={2147483647} step={1} value={form.days} onChange={e => setForm({ ...form, days: e.target.value })} className={inputClass} /></label>
          <p className="text-xs text-gray-500">ใช้พิจารณาประวัติความผิดประเภทเดียวกัน เพื่อแนะนำระดับการเตือน ค่าเริ่มต้น 365 วัน</p>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.active} onChange={e => setForm({ ...form, active: e.target.checked })} />เปิดใช้งาน</label>
        </fieldset>
        <div className="flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={() => setForm(null)} className="rounded-xl border px-4 py-2 disabled:opacity-50">ยกเลิก</button>
          <button type="submit" disabled={busy} className="rounded-xl bg-emerald-600 px-4 py-2 text-white disabled:opacity-50">{busy ? 'กำลังบันทึก...' : 'บันทึก'}</button>
        </div>
      </form>}
    </Modal>
    <Modal open={!!toggleTarget} onClose={() => { if (!busy) setToggleTarget(null) }} contentClassName="max-w-lg" ariaLabelledby="offense-toggle-title" showCloseButton={!busy}>
      {toggleTarget && <div className="space-y-4 p-6">
        <h3 id="offense-toggle-title" className="pr-10 text-lg font-semibold">{toggleTarget.is_active ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}ประเภทความผิด</h3>
        <p>ยืนยัน{toggleTarget.is_active ? 'ปิดใช้งาน' : 'เปิดใช้งาน'} “{toggleTarget.name}” หรือไม่?</p>
        {toggleTarget.is_active && <p className="text-sm text-gray-500">จะไม่แสดงประเภทนี้ให้เลือกสร้างเคสใหม่ ประวัติใบเตือนเดิมยังคงอยู่</p>}
        {toggleError && <div role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{toggleError}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={() => setToggleTarget(null)} className="rounded-xl border px-4 py-2 disabled:opacity-50">ยกเลิก</button>
          <button type="button" disabled={busy} onClick={() => void toggleActive()} className="rounded-xl bg-emerald-600 px-4 py-2 text-white disabled:opacity-50">{busy ? 'กำลังบันทึก...' : 'ยืนยัน'}</button>
        </div>
      </div>}
    </Modal>
  </div>
}
