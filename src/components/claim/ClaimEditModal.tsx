import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import Modal from '../ui/Modal'
import type { ClaimCompareDetail } from './claimCompareShared'

/** รายการในบิลเคลม (proposed_snapshot.items) — คงฟิลด์เดิมทั้งหมดตอนแก้ไข */
type EditClaimItemRow = Record<string, unknown> & {
  product_name?: string | null
  quantity?: number | null
  unit_price?: number | null
  is_free?: boolean | null
  ink_color?: string | null
  cartoon_pattern?: string | null
  line_pattern?: string | null
  font?: string | null
  line_1?: string | null
  line_2?: string | null
  line_3?: string | null
}

type Props = {
  open: boolean
  /** คำขอเคลมที่จะแก้ไข (ต้องเป็นสถานะ pending) */
  detail: ClaimCompareDetail | null
  /** ยอดรวมบิลเก่า (แสดงเทียบในการ์ดสรุป) */
  refOrderTotal?: number | null
  onClose: () => void
  /** เรียกหลังบันทึกสำเร็จ — ให้หน้าแม่รีโหลดรายการ/รายละเอียด */
  onSaved: () => void | Promise<void>
}

/** Modal แก้ไขบิลเคลม (proposed_snapshot) — แก้ได้จนกว่าคำขอจะถูกอนุมัติหรือปฏิเสธ */
export default function ClaimEditModal({ open, detail, refOrderTotal, onClose, onSaved }: Props) {
  const [rows, setRows] = useState<EditClaimItemRow[]>([])
  const [shipping, setShipping] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || !detail) return
    const items = (detail.proposed_snapshot?.items || []) as EditClaimItemRow[]
    setRows(items.map((it) => ({ ...it })))
    setShipping(Number(detail.proposed_snapshot?.order?.shipping_cost) || 0)
    setError('')
  }, [open, detail])

  const setField = (idx: number, field: string, value: unknown) =>
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, [field]: value } : r)))

  const setTextField = (idx: number, field: string, raw: string) =>
    setField(idx, field, raw.trim() ? raw : null)

  async function save() {
    if (!detail) return
    if (rows.length === 0) {
      setError('ต้องมีสินค้าอย่างน้อย 1 รายการ')
      return
    }
    for (const r of rows) {
      const q = Number(r.quantity)
      if (!Number.isFinite(q) || q < 1) {
        setError('จำนวนของทุกรายการต้องอย่างน้อย 1')
        return
      }
    }
    setSaving(true)
    setError('')
    try {
      const prevOrder = (detail.proposed_snapshot?.order || {}) as Record<string, unknown>
      const itemsTotal = rows.reduce(
        (s, r) => s + (r.is_free ? 0 : (Number(r.quantity) || 0) * (Number(r.unit_price) || 0)),
        0,
      )
      const ship = Number(shipping) || 0
      // บิลเคลมใหม่ไม่คิดส่วนลดจากบิลเก่า — ล้างส่วนลดและคิดยอดจากรายการ + ค่าส่ง
      const nextSnapshot = {
        order: {
          ...prevOrder,
          price: itemsTotal,
          shipping_cost: ship,
          discount: 0,
          total_amount: itemsTotal + ship,
        },
        items: rows,
      }
      const { data, error: upErr } = await supabase
        .from('or_claim_requests')
        .update({ proposed_snapshot: nextSnapshot })
        .eq('id', detail.id)
        .eq('status', 'pending')
        .select('id')
      if (upErr) throw upErr
      if (!data || data.length === 0) {
        throw new Error('คำขอนี้ถูกอนุมัติหรือปฏิเสธไปแล้ว — แก้ไขไม่ได้')
      }
      await onSaved()
      onClose()
    } catch (e: unknown) {
      setError((e as Error)?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  const itemsTotal = rows.reduce(
    (s, r) => s + (r.is_free ? 0 : (Number(r.quantity) || 0) * (Number(r.unit_price) || 0)),
    0,
  )
  const fmt = (n: number) => n.toLocaleString('th-TH', { minimumFractionDigits: 2 })

  return (
    <Modal
      open={open}
      onClose={() => !saving && onClose()}
      contentClassName="max-w-7xl w-full max-h-[90vh] flex flex-col"
      closeOnBackdropClick={false}
    >
      <div className="p-5 flex flex-col flex-1 min-h-0">
        <h3 className="text-lg font-bold mb-1">แก้ไขบิลเคลม</h3>
        <p className="text-sm text-gray-600 mb-3">
          บิลอ้างอิง: <strong className="font-mono">{detail?.ref_snapshot?.bill_no || '–'}</strong>{' '}
          — แก้ไขได้จนกว่าคำขอจะถูกอนุมัติหรือปฏิเสธ
        </p>
        <div className="border rounded-lg overflow-auto flex-1 min-h-[160px] max-h-[46vh] mb-3">
          <table className="w-full text-xs sm:text-sm min-w-[1100px]">
            <thead className="bg-gray-100 sticky top-0">
              <tr>
                <th className="text-left p-2 min-w-[140px]">สินค้า</th>
                <th className="text-left p-2 min-w-[90px]">สีหมึก</th>
                <th className="text-left p-2 min-w-[100px]">ลาย</th>
                <th className="text-left p-2 min-w-[100px]">เส้น</th>
                <th className="text-left p-2 min-w-[80px]">ฟอนต์</th>
                <th className="text-left p-2 min-w-[100px]">บรรทัด 1</th>
                <th className="text-left p-2 min-w-[100px]">บรรทัด 2</th>
                <th className="text-left p-2 min-w-[100px]">บรรทัด 3</th>
                <th className="text-right p-2 w-16">จำนวน</th>
                <th className="text-right p-2 w-20">ราคา/หน่วย</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => (
                <tr key={idx} className="border-t">
                  <td className="p-2 text-gray-800">{String(row.product_name ?? '') || '–'}</td>
                  {(['ink_color', 'cartoon_pattern', 'line_pattern', 'font', 'line_1', 'line_2', 'line_3'] as const).map(
                    (field) => (
                      <td key={field} className="p-1">
                        <input
                          value={String(row[field] ?? '')}
                          onChange={(e) => setTextField(idx, field, e.target.value)}
                          className="w-full px-2 py-1 border rounded"
                        />
                      </td>
                    ),
                  )}
                  <td className="p-1">
                    <input
                      type="number"
                      min={1}
                      value={Number(row.quantity) || 1}
                      onChange={(e) => {
                        const q = parseInt(e.target.value, 10)
                        setField(idx, 'quantity', Number.isFinite(q) ? q : 1)
                      }}
                      className="w-full px-2 py-1 border rounded text-right"
                    />
                  </td>
                  <td className="p-1">
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={Number(row.unit_price) || 0}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value)
                        setRows((prev) =>
                          prev.map((r, i) =>
                            i === idx ? { ...r, unit_price: Number.isFinite(v) ? v : 0, is_free: false } : r,
                          ),
                        )
                      }}
                      className="w-full px-2 py-1 border rounded text-right"
                    />
                  </td>
                  <td className="p-1">
                    <button
                      type="button"
                      className="text-red-600 text-xs hover:underline"
                      onClick={() => setRows((prev) => prev.filter((_, i) => i !== idx))}
                    >
                      ลบ
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex justify-end mb-3 shrink-0">
          <div className="w-full sm:w-80 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm space-y-1.5">
            <div className="flex items-center justify-between text-gray-500">
              <span>ยอดรวมบิลเก่า</span>
              <span className="tabular-nums">{fmt(Number(refOrderTotal) || 0)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>ยอดรวมบิลเคลม</span>
              <strong className="tabular-nums">{fmt(itemsTotal)}</strong>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span>ค่าขนส่ง</span>
              <input
                type="number"
                min={0}
                step="0.01"
                value={shipping}
                onChange={(e) => {
                  const v = parseFloat(e.target.value)
                  setShipping(Number.isFinite(v) && v >= 0 ? v : 0)
                }}
                className="w-24 px-2 py-1 border rounded text-right tabular-nums"
              />
            </div>
            <div className="flex items-center justify-between border-t border-gray-300 pt-1.5">
              <span className="font-semibold">ยอดสุทธิเสนอ</span>
              <strong className="text-base tabular-nums">{fmt(itemsTotal + (Number(shipping) || 0))}</strong>
            </div>
          </div>
        </div>
        {error && <p className="text-sm text-red-600 mb-2 shrink-0">{error}</p>}
        <div className="flex justify-end gap-2 shrink-0">
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            className="px-4 py-2 border rounded-lg hover:bg-gray-100 disabled:opacity-50"
          >
            ยกเลิก
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className="px-4 py-2 rounded-lg bg-amber-500 text-white font-medium hover:bg-amber-600 disabled:opacity-50"
          >
            {saving ? 'กำลังบันทึก...' : 'บันทึกการแก้ไข'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
