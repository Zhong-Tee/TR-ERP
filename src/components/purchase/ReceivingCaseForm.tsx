import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Modal from '../ui/Modal'
import { useAuthContext } from '../../contexts/AuthContext'
import { loadPOItemsForGR } from '../../lib/purchaseApi'
import { supabase } from '../../lib/supabase'
import { loadCaseUsers, caseMethods, CaseMethod, outstandingQuantity, loadReceivingCases, errorText, uploadCaseEvidence } from '../../lib/receivingCases'

interface Row { id: string; name: string; remaining: number; qty: string; checked: boolean }
export default function ReceivingCaseForm({ po, onClose, onSaved }: {
  po: { id: string; po_no: string }; onClose: () => void; onSaved: () => void
}) {
  const { user } = useAuthContext()
  const [rows, setRows] = useState<Row[]>([])
  const [users, setUsers] = useState<Record<string, string>>({})
  const [assigned, setAssigned] = useState(user?.id || '')
  const [method, setMethod] = useState<CaseMethod>('refund')
  const [reason, setReason] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [savedId, setSavedId] = useState('')
  useEffect(() => {
    let active = true
    Promise.all([loadPOItemsForGR(po.id), loadReceivingCases(), loadCaseUsers()]).then(([items, cases, names]) => {
      if (!active) return
      setUsers(names)
      setRows(items.map(item => {
        const reserved = cases.filter(c => ['pending', 'dispute'].includes(c.status)).flatMap(c => c.inv_receiving_case_items).filter(i => i.po_item_id === item.id).reduce((sum, i) => sum + Number(i.qty), 0)
        const remaining = outstandingQuantity(item, reserved)
        return { id: item.id, name: `${item.pr_products?.product_code || ''} ${item.pr_products?.product_name || ''}`, remaining, qty: String(remaining), checked: false }
      }).filter(i => i.remaining > 0))
    }).catch(e => active && setError(errorText(e))).finally(() => active && setLoading(false))
    return () => { active = false }
  }, [po.id])
  async function save() {
    const selected = rows.filter(r => r.checked)
    if (!savedId && (!reason.trim() || !assigned || !selected.length || selected.some(r => !Number.isFinite(Number(r.qty)) || Number(r.qty) <= 0 || Number(r.qty) > r.remaining))) {
      setError('เลือกรายการ ระบุจำนวนไม่เกินยอดค้างรับ ผู้รับผิดชอบ และเหตุผลให้ครบ'); return
    }
    setBusy(true); setError('')
    try {
      let id = savedId
      if (!id) {
        const { data, error: rpcError } = await supabase.rpc('rpc_create_receiving_case', {
          p_po_id: po.id, p_method: method, p_reason: reason.trim(), p_assigned_to: assigned,
          p_items: selected.map(r => ({ po_item_id: r.id, qty: Number(r.qty) })),
        })
        if (rpcError) throw rpcError
        id = String(data); setSavedId(id)
      }
      for (const file of files) {
        await uploadCaseEvidence(id, user!.id, file)
        setFiles(previous => previous.filter(f => f !== file))
      }
      onSaved(); onClose()
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return <Modal open onClose={() => { if (!busy) { if (savedId) onSaved(); onClose() } }} stackClassName="z-[70]" contentClassName="max-w-4xl">
    <div className="p-6 space-y-4 text-gray-900">
      <h2 className="text-xl font-bold">ปิดยอดค้างรับ · {po.po_no}</h2>
      <p className="text-sm text-gray-600">ส่งคำขอให้ผู้อนุมัติตรวจสอบ แล้วติดตามผลใน <Link className="text-blue-600 underline" to="/purchase/receiving-cases">ติดตามยอดค้างรับ</Link></p>
      {error && <p role="alert" className="p-3 bg-red-50 text-red-700 rounded-lg">{error}</p>}
      {savedId && <p className="text-amber-700">สร้างคำขอแล้ว หากแนบไฟล์ไม่สำเร็จ สามารถกดแนบไฟล์ที่เหลืออีกครั้ง หรือปิดแล้วแนบจากเมนูติดตามได้</p>}
      {loading ? <p>กำลังโหลด...</p> : <fieldset disabled={busy || !!savedId} className="space-y-4 disabled:opacity-60">
        <table className="w-full text-sm"><thead className="bg-gray-100"><tr><th className="p-2 text-left">เลือก / สินค้า</th><th>ค้างรับที่ยังไม่ส่งคำขอ</th><th>จำนวนที่ขอปิด</th></tr></thead>
          <tbody>{rows.map((r, index) => <tr key={r.id} className="border-b"><td className="p-3"><label><input type="checkbox" checked={r.checked} onChange={e => setRows(prev => prev.map((v, n) => n === index ? { ...v, checked: e.target.checked } : v))} className="mr-2" />{r.name}</label></td><td className="text-center">{r.remaining}</td><td className="p-2"><input aria-label={`จำนวน ${r.name}`} type="number" min="0.01" step="0.01" max={r.remaining} disabled={!r.checked} value={r.qty} onChange={e => setRows(prev => prev.map((v, n) => n === index ? { ...v, qty: e.target.value } : v))} className="w-28 border rounded p-2" /></td></tr>)}</tbody>
        </table>
        {!rows.length && <p>ไม่มียอดค้างรับที่ส่งคำขอได้ อาจมีคำขอรอตรวจสอบอยู่แล้ว</p>}
        <div className="grid sm:grid-cols-2 gap-3"><label>วิธีจัดการ<select value={method} onChange={e => setMethod(e.target.value as CaseMethod)} className="mt-1 w-full border rounded p-2">{Object.entries(caseMethods).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
          <label>ผู้รับผิดชอบ<select value={assigned} onChange={e => setAssigned(e.target.value)} className="mt-1 w-full border rounded p-2">{Object.entries(users).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label></div>
        <p className="text-sm text-amber-700">{method === 'dispute' ? 'ยังไม่ตัดยอดค้างรับ เมื่อได้ข้อสรุปจึงส่งอนุมัติ' : method === 'cancel_unpaid' ? 'ใช้กับส่วนที่ยังไม่ได้จ่ายเงิน และตกลงว่าไม่ต้องจ่ายแล้ว ผู้อนุมัติจะตรวจสอบยอดก่อนปิด' : 'ยอดรับจริงและสต็อกไม่เปลี่ยน ยอดค้างรับจะลดเมื่ออนุมัติแล้ว'}</p>
        <label className="block">เหตุผล / ข้อตกลง<textarea value={reason} onChange={e => setReason(e.target.value)} className="mt-1 w-full border rounded p-2" rows={3} placeholder="บันทึกเหตุผลโดยไม่ใส่ราคาต้นทุนในข้อความที่ทุกคนเห็น" /></label>
      </fieldset>}
      <label className="block text-sm">หลักฐาน (JPG, PNG, PDF ไม่เกิน 10 MB/ไฟล์)<input disabled={busy} type="file" multiple accept="image/jpeg,image/png,application/pdf" onChange={e => setFiles(Array.from(e.target.files || []))} className="block mt-2" /></label>
      <p className="text-xs text-gray-500">ไฟล์หลักฐานเปิดได้เฉพาะผู้แนบและ superadmin, admin, account เพื่อป้องกันข้อมูลต้นทุนในเอกสาร</p>
      <div className="flex justify-end"><button disabled={busy || loading || (!savedId && !rows.length)} onClick={save} className="rounded-lg bg-blue-600 px-5 py-2 text-white disabled:opacity-50">{busy ? 'กำลังบันทึก...' : savedId ? 'แนบไฟล์ที่เหลือ' : method === 'dispute' ? 'เปิดรายการติดตาม' : 'ส่งขออนุมัติ'}</button></div>
    </div>
  </Modal>
}
