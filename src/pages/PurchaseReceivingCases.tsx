import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Modal from '../components/ui/Modal'
import { useAuthContext } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { loadCaseUsers, CaseFinance, CaseMethod, CaseSettlement, ReceivingCase, canViewPurchaseCost, caseAction, caseMethods, caseStatuses, errorText, loadReceivingCases, uploadCaseEvidence } from '../lib/receivingCases'

const actions: Record<string, string> = { created: 'สร้างคำขอ', approve: 'อนุมัติปิดยอดค้างรับ', reject: 'ไม่อนุมัติ', resubmit: 'ส่งขออนุมัติหลังติดตาม', settle: 'บันทึกการคืนเงิน / ปรับยอด', note: 'บันทึกผลติดตาม' }
const money = (n: number) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2 })
const date = (s: string) => new Date(s).toLocaleString('th-TH')
const inputClass = 'w-full rounded-lg border p-2 mt-1'

export default function PurchaseReceivingCases() {
  const { user } = useAuthContext()
  const financial = canViewPurchaseCost(user?.role)
  const [cases, setCases] = useState<ReceivingCase[]>([])
  const [users, setUsers] = useState<Record<string, string>>({})
  const [tab, setTab] = useState('pending')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<ReceivingCase | null>(null)
  const [finance, setFinance] = useState<CaseFinance | null>(null)
  const [settlements, setSettlements] = useState<CaseSettlement[]>([])
  const [grs, setGrs] = useState<{ id: string; gr_no: string; received_at: string }[]>([])
  const [evidence, setEvidence] = useState<{ name: string; url: string }[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [note, setNote] = useState('')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState('THB')
  const [reference, setReference] = useState('')
  const [settledOn, setSettledOn] = useState(() => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10))
  const [method, setMethod] = useState<CaseMethod>('refund')
  const [confirmed, setConfirmed] = useState(false)
  const [files, setFiles] = useState<File[]>([])

  async function refresh(id?: string) {
    const list = await loadReceivingCases(); setCases(list)
    if (id) setSelected(list.find(c => c.id === id) || null)
  }
  useEffect(() => {
    Promise.all([refresh(), loadCaseUsers().then(setUsers)]).catch(e => setError(errorText(e))).finally(() => setLoading(false))
  }, [])
  useEffect(() => {
    if (!selected) return
    let active = true
    setDetailLoading(true); setFinance(null); setSettlements([]); setGrs([]); setEvidence([])
    const c = selected
    async function detail() {
      const tasks = await Promise.all([
        supabase.from('inv_gr').select('id,gr_no,received_at').eq('po_id', c.po_id).order('received_at'),
        financial ? supabase.from('inv_receiving_case_finance').select('*').eq('case_id', c.id).maybeSingle() : Promise.resolve({ data: null, error: null }),
        financial ? supabase.from('inv_receiving_case_settlements').select('*').eq('case_id', c.id).order('created_at') : Promise.resolve({ data: [], error: null }),
      ])
      tasks.forEach(r => { if (r.error) throw r.error })
      const storage = supabase.storage.from('receiving-case-evidence')
      // Prefix listing honours RLS: non-financial staff see only their uploads.
      const { data: folders, error: folderError } = await storage.list(c.id)
      if (folderError) throw folderError
      const links: { name: string; url: string }[] = []
      for (const folder of folders || []) {
        const { data: entries, error: listError } = await storage.list(`${c.id}/${folder.name}`)
        if (listError) throw listError
        for (const file of entries || []) {
          const { data, error: urlError } = await storage.createSignedUrl(`${c.id}/${folder.name}/${file.name}`, 300)
          if (urlError) throw urlError
          links.push({ name: file.name.substring(37), url: data.signedUrl })
        }
      }
      if (active) { setGrs(tasks[0].data || []); setFinance(tasks[1].data as CaseFinance | null); setSettlements((tasks[2].data || []) as CaseSettlement[]); setEvidence(links) }
    }
    detail().catch(e => active && setError(errorText(e))).finally(() => active && setDetailLoading(false))
    return () => { active = false }
  }, [selected, financial])

  function open(c: ReceivingCase) {
    setSelected(c); setError(''); setAmount(''); setNote(''); setReference(''); setConfirmed(false); setFiles([]); setMethod('refund')
  }
  async function run(action: string) {
    if (!selected || busy) return
    if (['approve', 'reject', 'settle'].includes(action) && !confirmed) { setError('กรุณายืนยันว่าตรวจสอบข้อมูลและหลักฐานแล้ว'); return }
    if (action === 'approve' && ['refund', 'cancel_unpaid'].includes(selected.method) && (!Number.isFinite(Number(amount)) || Number(amount) <= 0)) { setError('ระบุยอดเงินตามข้อตกลงก่อนอนุมัติ'); return }
    if (action === 'settle' && (!Number.isFinite(Number(amount)) || Number(amount) <= 0 || !reference.trim() || !settledOn)) { setError('ระบุจำนวนเงิน วันที่ และเลขอ้างอิงให้ครบ'); return }
    setBusy(true); setError('')
    try {
      await caseAction(selected.id, action, { note: note.trim(), amount: amount ? Number(amount) : null, currency, reference: reference.trim(), settled_on: settledOn, method })
      setConfirmed(false); setAmount(''); setNote(''); setReference('')
      await refresh(selected.id)
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  async function attach() {
    if (!selected || !user) return
    setBusy(true); setError('')
    try {
      for (const file of files) { await uploadCaseEvidence(selected.id, user.id, file); setFiles(prev => prev.filter(f => f !== file)) }
      await refresh(selected.id)
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const visible = cases.filter(c => (tab === 'all' || c.status === tab) && `${c.case_no} ${c.inv_po?.po_no} ${c.inv_po?.supplier_name}`.toLowerCase().includes(search.toLowerCase()))
  return <div className="p-4 md:p-6 space-y-4">
    <div className="flex flex-wrap justify-between gap-3"><div><h1 className="text-xl font-bold">ติดตามยอดค้างรับ</h1><p className="text-sm text-gray-500">ตรวจสอบคำขอปิดยอดรับสินค้าและติดตามผลจากผู้ขาย</p></div><Link className="text-blue-600 underline" to="/purchase/gr">กลับไป GR</Link></div>
    {error && !selected && <p role="alert" className="text-red-700 bg-red-50 p-3">{error}</p>}
    <div className="flex gap-2 flex-wrap">{Object.entries({ all: 'ทั้งหมด', ...caseStatuses }).map(([key, label]) => <button key={key} onClick={() => setTab(key)} className={`rounded-lg px-3 py-2 text-sm ${tab === key ? 'bg-blue-600 text-white' : 'bg-white border'}`}>{label} ({cases.filter(c => key === 'all' || c.status === key).length})</button>)}</div>
    <input aria-label="ค้นหารายการติดตาม" value={search} onChange={e => setSearch(e.target.value)} className="w-full max-w-lg border rounded-lg p-2" placeholder="ค้นหาเลขรายการ PO หรือผู้ขาย" />
    <div className="overflow-x-auto bg-white rounded-xl border"><table className="w-full text-sm"><thead className="bg-gray-50"><tr>{['เลขติดตาม / PO', 'ผู้ขาย', 'วิธีจัดการ', 'สถานะ', 'ผู้รับผิดชอบ', 'วันที่สร้าง', ''].map((h, i) => <th key={i} className="text-left p-3">{h}</th>)}</tr></thead><tbody>
      {visible.map(c => <tr key={c.id} className="border-t"><td className="p-3">RC-{c.case_no}<div className="text-blue-700">{c.inv_po?.po_no}</div></td><td className="p-3">{c.inv_po?.supplier_name || '-'}</td><td className="p-3">{caseMethods[c.method]}</td><td className="p-3"><span className="rounded bg-blue-50 text-blue-800 px-2 py-1">{caseStatuses[c.status]}</span></td><td className="p-3">{users[c.assigned_to] || '-'}</td><td className="p-3">{date(c.created_at)}</td><td className="p-3"><button onClick={() => open(c)} className="text-blue-600 font-semibold">ดู / ดำเนินการ</button></td></tr>)}
      {!visible.length && <tr><td colSpan={7} className="text-center p-8 text-gray-500">{loading ? 'กำลังโหลด...' : 'ไม่พบรายการ'}</td></tr>}
    </tbody></table></div>
    <Modal open={!!selected} onClose={() => !busy && setSelected(null)} contentClassName="max-w-4xl">
      {selected && <div className="p-6 space-y-4 text-gray-900">
        <h2 className="text-xl font-bold pr-10">RC-{selected.case_no} · {selected.inv_po?.po_no}</h2>
        <p>{caseMethods[selected.method]} · <strong>{caseStatuses[selected.status]}</strong></p>
        {error && <p role="alert" className="p-3 rounded bg-red-50 text-red-700">{error}</p>}
        <div className="p-3 bg-gray-50 rounded text-sm space-y-1"><p>ผู้ขาย: {selected.inv_po?.supplier_name || '-'}</p><p>ผู้สร้าง: {users[selected.created_by]} · ผู้รับผิดชอบ: {users[selected.assigned_to]}</p><p>เหตุผล: {selected.reason}</p>{selected.approved_at && <p>อนุมัติโดย {users[selected.approved_by || '']} เมื่อ {date(selected.approved_at)}</p>}<p>PO: <Link className="text-blue-600 underline" to={`/purchase/po?search=${encodeURIComponent(selected.inv_po?.po_no || '')}`}>{selected.inv_po?.po_no}</Link></p><p>GR ที่เกี่ยวข้อง: {grs.length ? grs.map(g => <Link key={g.id} className="text-blue-600 underline mr-3" to={`/purchase/gr?search=${encodeURIComponent(g.gr_no)}`}>{g.gr_no}</Link>) : '-'}</p></div>
        <table className="w-full text-sm"><thead className="bg-gray-100"><tr><th className="p-2 text-left">สินค้า</th><th>จำนวนที่ขอปิด</th><th>รับจริงสะสม</th></tr></thead><tbody>{selected.inv_receiving_case_items.map(i => <tr key={i.id} className="border-b"><td className="p-2">{i.inv_po_items?.pr_products?.product_code} {i.inv_po_items?.pr_products?.product_name}</td><td className="text-center">{i.qty} {i.inv_po_items?.unit}</td><td className="text-center">{i.inv_po_items?.qty_received_total}</td></tr>)}</tbody></table>
        {financial && finance && <div className="bg-blue-50 p-3 rounded text-sm">ยอดตามข้อตกลง {money(finance.expected_amount)} · ดำเนินการแล้ว {money(finance.settled_amount)} · คงเหลือ <strong>{money(finance.expected_amount - finance.settled_amount)} {finance.currency}</strong></div>}
        {financial && settlements.length > 0 && <div className="space-y-1 text-sm">{settlements.map(s => <p key={s.id}>{s.settled_on} · {money(s.amount)} {finance?.currency} · อ้างอิง {s.reference}</p>)}</div>}
        <div className="border rounded p-3 space-y-2"><h3 className="font-semibold">หลักฐาน</h3><p className="text-xs text-gray-500">เห็นเฉพาะไฟล์ของคุณ หรือทุกไฟล์เมื่อเป็น superadmin, admin, account</p>
          {evidence.map(e => <a key={e.url} href={e.url} target="_blank" rel="noreferrer" className="block text-blue-600 underline text-sm">{e.name}</a>)}
          {!evidence.length && <p className="text-sm text-gray-500">{detailLoading ? 'กำลังโหลด...' : 'ไม่มีหลักฐานที่คุณเปิดดูได้'}</p>}
          <input type="file" disabled={busy} multiple accept="image/jpeg,image/png,application/pdf" onChange={e => setFiles(Array.from(e.target.files || []))} />
          <button disabled={busy || !files.length} onClick={attach} className="rounded bg-gray-100 border px-3 py-2 text-sm disabled:opacity-50">แนบหลักฐาน ({files.length})</button>
        </div>
        <fieldset disabled={busy || detailLoading} className="space-y-3 disabled:opacity-60">
          <label className="block text-sm">ผลการติดตาม / เหตุผล<textarea className={inputClass} value={note} onChange={e => setNote(e.target.value)} placeholder="ข้อความนี้ทุกบทบาทที่เข้าถึงเมนูเห็นได้ กรุณาไม่ใส่ราคาต้นทุน" /></label>
          <button onClick={() => run('note')} disabled={!note.trim()} className="border rounded px-3 py-2 text-sm disabled:opacity-50">บันทึกผลติดตาม</button>
          {selected.status === 'dispute' && <div className="flex gap-2"><select aria-label="วิธีจัดการหลังติดตาม" value={method} onChange={e => setMethod(e.target.value as CaseMethod)} className="border rounded p-2">{Object.entries(caseMethods).filter(([key]) => key !== 'dispute').map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><button onClick={() => run('resubmit')} className="bg-blue-600 text-white rounded px-3 py-2">ส่งขออนุมัติ</button></div>}
          {financial && ['pending', 'dispute', 'refund_pending', 'adjustment_pending'].includes(selected.status) && <div className="border-t pt-3 space-y-3">
            {((selected.status === 'pending' && ['refund', 'cancel_unpaid'].includes(selected.method)) || ['refund_pending', 'adjustment_pending'].includes(selected.status)) && <div className="grid sm:grid-cols-2 gap-3"><label>จำนวนเงิน {selected.status === 'pending' ? 'ตามข้อตกลงที่ตรวจสอบแล้ว' : 'ที่ได้รับคืน / ปรับยอดครั้งนี้'}<input type="number" min="0.01" step="0.01" className={inputClass} value={amount} onChange={e => setAmount(e.target.value)} /></label>{selected.status === 'pending' ? <label>สกุลเงิน<select className={inputClass} value={currency} onChange={e => setCurrency(e.target.value)}>{['THB','CNY','USD'].map(v => <option key={v}>{v}</option>)}</select></label> : <label>วันที่ดำเนินการ<input type="date" value={settledOn} onChange={e => setSettledOn(e.target.value)} className={inputClass} /></label>}</div>}
            {['refund_pending', 'adjustment_pending'].includes(selected.status) && <label className="block">เลขอ้างอิงการโอน / เอกสารปรับยอด<input value={reference} onChange={e => setReference(e.target.value)} className={inputClass} /></label>}
            <label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />ตรวจสอบยอด ข้อตกลง และหลักฐานแล้ว{selected.method === 'cancel_unpaid' && selected.status === 'pending' ? ' ยืนยันว่าเป็นยอดที่ยังไม่ได้ชำระ' : ''}</label>
            <div className="flex gap-2">{selected.status === 'pending' && <button onClick={() => run('approve')} className="rounded bg-green-600 text-white px-4 py-2">อนุมัติปิดยอดค้างรับ</button>}{['pending','dispute'].includes(selected.status) && <button onClick={() => run('reject')} className="rounded border border-red-300 text-red-700 px-4 py-2">ไม่อนุมัติ</button>}{['refund_pending','adjustment_pending'].includes(selected.status) && <button onClick={() => run('settle')} className="rounded bg-green-600 text-white px-4 py-2">{selected.status === 'refund_pending' ? 'บันทึกรับเงินคืน' : 'บันทึกปรับยอดชำระ'}</button>}</div>
          </div>}
        </fieldset>
        <div className="border-t pt-3 space-y-2"><h3 className="font-semibold">ประวัติการดำเนินการ</h3>{[...selected.inv_receiving_case_events].sort((a,b) => a.created_at.localeCompare(b.created_at)).map(e => <div key={e.id} className="text-sm border-l-2 pl-3"><p>{actions[e.action] || e.action} · {users[e.actor_id]} · {date(e.created_at)}</p>{e.note && <p className="text-gray-600">{caseMethods[e.note as CaseMethod] || e.note}</p>}</div>)}</div>
      </div>}
    </Modal>
  </div>
}
