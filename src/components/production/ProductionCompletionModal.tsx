import { useEffect, useRef, useState } from 'react'
import Modal from '../ui/Modal'
import { completeProductionOrder, fetchProductionOrderItems, fetchRecipe } from '../../lib/productionApi'
import { shortageReasons, validateProductionActuals } from '../../lib/productionCompletion'
import type { ByproductActual, MaterialActual, ProductionActual } from '../../lib/productionCompletion'
import type { PpProductionOrder } from '../../types'

const message = (e: unknown) => e instanceof Error ? e.message : (e as { message?: string })?.message || 'เกิดข้อผิดพลาด กรุณาลองใหม่'
const roundQty = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })

export default function ProductionCompletionModal({ order, onClose, onCompleted }: {
  order: PpProductionOrder; onClose: () => void; onCompleted: () => void
}) {
  const [items, setItems] = useState<ProductionActual[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [review, setReview] = useState(false)
  const [saving, setSaving] = useState(false)
  const busy = useRef(false)
  useEffect(() => {
    let active = true
    async function load() {
      try {
        const rows = await fetchProductionOrderItems(order.id)
        const actuals = await Promise.all(rows.map(async row => {
          const recipe = await fetchRecipe(row.product_id)
          if (!recipe) throw new Error(`ไม่พบสูตรสำหรับ ${row.product?.product_code}`)
          const materials = new Map<string, MaterialActual>()
          const byproducts = new Map<string, ByproductActual>()
          for (const inc of recipe.includes) {
            const qty = Number(inc.qty) * Number(row.qty)
            const existing = materials.get(inc.product_id)
            if (existing) { existing.planned_qty += qty; existing.used_qty += qty }
            else materials.set(inc.product_id, { product_id: inc.product_id, product_code: inc.product?.product_code || '-', product_name: inc.product?.product_name || '-', planned_qty: qty, used_qty: qty, returned_qty: 0, waste_qty: 0, shortage_qty: 0, reason: '' })
          }
          for (const rem of recipe.removes) {
            const qty = Number(rem.qty) * Number(row.qty)
            const existing = byproducts.get(rem.product_id)
            if (existing) { existing.planned_qty += qty; existing.qty += qty }
            else byproducts.set(rem.product_id, { product_id: rem.product_id, product_code: rem.product?.product_code || '-', product_name: rem.product?.product_name || '-', planned_qty: qty, qty })
          }
          return { item_id: row.id, product_code: row.product?.product_code || '-', product_name: row.product?.product_name || '-', planned_qty: Number(row.qty), actual_qty: NaN, reason_code: '', reason: '', materials: [...materials.values()].map(m => ({ ...m, planned_qty: roundQty(m.planned_qty), used_qty: roundQty(m.used_qty) })), byproducts: [...byproducts.values()].map(b => ({ ...b, planned_qty: roundQty(b.planned_qty), qty: roundQty(b.qty) })) }
        }))
        if (active) setItems(actuals)
      } catch (e) { if (active) setError(message(e)) }
      finally { if (active) setLoading(false) }
    }
    void load()
    return () => { active = false }
  }, [order.id])
  const patch = (index: number, change: Partial<ProductionActual>) => setItems(old => old.map((x, i) => i === index ? { ...x, ...change } : x))
  const numberInput = (label: string, value: number, change: (value: number) => void, max?: number) => (
    <label className="block text-sm font-medium">{label}<input aria-label={label} type="number" min="0" max={max} step="0.01" value={Number.isNaN(value) ? '' : value} disabled={saving || review} onChange={e => change(e.target.value === '' ? NaN : Number(e.target.value))} className="mt-1 w-full min-w-24 rounded border px-3 py-2 text-right disabled:bg-gray-100" /></label>
  )
  const submit = async () => {
    if (busy.current) return
    const invalid = validateProductionActuals(items)
    if (invalid) { setError(invalid); return }
    if (!review) { setError(''); setReview(true); return }
    busy.current = true; setSaving(true); setError('')
    try { await completeProductionOrder(order.id, items); onCompleted() }
    catch (e) { setError(message(e)); setReview(false) }
    finally { busy.current = false; setSaving(false) }
  }
  return <Modal open onClose={() => { if (!busy.current) onClose() }} contentClassName="max-w-6xl">
    <div className="p-6 space-y-5">
      <h2 className="text-xl font-bold pr-12">{review ? 'ตรวจสอบก่อนปิดงาน' : 'บันทึกผลผลิต / รับเข้า'} {order.doc_no}</h2>
      <p className="text-sm text-gray-600">รับเข้าตามจำนวนจริงและปิดใบครั้งเดียว ยอดที่ผลิตขาดจะไม่ค้างผลิต จำนวนตามเอกสารเป็นยอดจากสูตรปัจจุบัน กรุณาตรวจเทียบใบเบิกก่อนยืนยัน</p>
      {loading && <p>กำลังโหลดรายการ…</p>}
      {items.map((item, index) => <section key={item.item_id} className="border rounded-xl p-4 space-y-4">
        <h3 className="font-bold">{item.product_code} — {item.product_name}</h3>
        <div className="grid sm:grid-cols-3 gap-4 items-end">
          <p>ขอผลิต: <strong>{fmt(item.planned_qty)}</strong></p>
          {numberInput('จำนวนผลิตได้จริง / รับเข้า', item.actual_qty, actual_qty => patch(index, { actual_qty }), item.planned_qty)}
          <p>ขาดจากแผน: <strong className="text-orange-700">{Number.isFinite(item.actual_qty) ? fmt(item.planned_qty - item.actual_qty) : '—'}</strong></p>
        </div>
        {item.actual_qty < item.planned_qty && <div className="grid sm:grid-cols-2 gap-3">
          <label className="text-sm">เหตุผลที่ผลิตขาด<select value={item.reason_code} disabled={saving || review} onChange={e => patch(index, { reason_code: e.target.value })} className="block w-full mt-1 border rounded p-2"><option value="">เลือกเหตุผล</option>{shortageReasons.map(r => <option key={r}>{r}</option>)}</select></label>
          <label className="text-sm">รายละเอียดที่ผลิตขาด<textarea value={item.reason} disabled={saving || review} onChange={e => patch(index, { reason: e.target.value })} className="block w-full mt-1 border rounded p-2" /></label>
        </div>}
        <h4 className="font-semibold">ตรวจสอบวัตถุดิบ</h4>
        <p className="text-sm text-gray-600">ยอดใช้ + เหลือคืน + สูญเสีย + ขาดจากห่อ ต้องเท่ากับยอดตามเอกสาร ยอดเหลือคืนยังอยู่ในสต็อก เพราะระบบยังไม่ได้ตัดตอนเริ่มผลิต</p>
        {item.materials.map((m, mi) => {
          const change = (p: Partial<MaterialActual>) => patch(index, { materials: item.materials.map((x, i) => i === mi ? { ...x, ...p } : x) })
          return <div key={m.product_id} className="bg-orange-50 p-3 rounded-lg space-y-3">
            <p className="font-medium">{m.product_code} — {m.product_name} · ตามเอกสาร {fmt(m.planned_qty)}</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {numberInput('ใช้ผลิตจริง', m.used_qty, used_qty => change({ used_qty }))}
              {numberInput('เหลือคืนคลัง', m.returned_qty, returned_qty => change({ returned_qty }))}
              {numberInput('ชำรุด / สูญเสีย', m.waste_qty, waste_qty => change({ waste_qty }))}
              {numberInput('ขาดจากห่อ', m.shortage_qty, shortage_qty => change({ shortage_qty }))}
            </div>
            <label className="block text-sm">เหตุผลส่วนต่างวัตถุดิบ<textarea value={m.reason} disabled={saving || review} onChange={e => change({ reason: e.target.value })} className="block mt-1 w-full border rounded p-2" /></label>
            <p className="text-sm">ตัดสต็อกจริง: {fmt(m.used_qty + m.waste_qty + m.shortage_qty)} · เหลือคืนที่ไม่ตัด: {fmt(m.returned_qty)}</p>
          </div>
        })}
        {item.byproducts.length > 0 && <h4 className="font-semibold">สินค้าที่แยกคืน (รับเข้าสต็อกเพิ่ม)</h4>}
        {item.byproducts.map((b, bi) => <div key={b.product_id} className="grid sm:grid-cols-2 gap-3 bg-emerald-50 p-3 rounded-lg items-center"><p>{b.product_code} — {b.product_name}<br />ตามสูตร: {fmt(b.planned_qty)}</p>{numberInput('จำนวนแยกคืนจริง', b.qty, qty => patch(index, { byproducts: item.byproducts.map((x, i) => i === bi ? { ...x, qty } : x) }))}</div>)}
      </section>)}
      {review && <div className="p-4 bg-blue-50 rounded-lg space-y-2"><p className="font-bold">ยืนยันรับเข้า {fmt(items.reduce((sum, i) => sum + i.actual_qty, 0))} หน่วย และปิดใบ {items.some(i => i.actual_qty < i.planned_qty) ? '“ผลิตเสร็จ — ได้ไม่ครบ”' : '“ผลิตเสร็จ”'}</p><p>ต้นทุนคำนวณจาก FIFO ณ เวลาบันทึก: วัตถุดิบใช้จริงรวมสูญเสีย หักมูลค่าสินค้าแยกคืน แล้วหารจำนวนผลิตจริง ส่วนขาดจากห่อแยกเป็นผลต่างสต็อก หากผลิตได้ 0 ต้นทุนสุทธิจะแสดงเป็นสูญเสียทั้งงาน</p></div>}
      {error && <p role="alert" className="p-3 bg-red-50 text-red-700 rounded">{error}</p>}
      <div className="flex justify-end gap-3">
        <button disabled={saving} onClick={() => review ? setReview(false) : onClose()} className="border px-4 py-2 rounded">{review ? 'กลับไปแก้ไข' : 'ยกเลิก'}</button>
        <button disabled={loading || saving || !items.length} onClick={() => void submit()} className="bg-emerald-600 text-white rounded px-4 py-2 disabled:opacity-50">{saving ? 'กำลังบันทึก…' : review ? 'ยืนยันรับเข้าและปิดงาน' : 'ตรวจสอบก่อนปิดงาน'}</button>
      </div>
    </div>
  </Modal>
}
