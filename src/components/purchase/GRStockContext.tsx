import { grOrderStockNote } from '../../lib/grCurrentStock'
import type { GRCurrentStock } from '../../lib/grCurrentStock'

export default function GRStockContext({ note = '', stock, unitName }: {
  note?: string; stock?: GRCurrentStock; unitName: string
}) {
  const orderNote = grOrderStockNote(note)
  return <div className="mt-0.5 space-y-0.5 text-xs leading-snug break-words">
    {note && <div className="text-amber-700 whitespace-pre-line">* {orderNote}</div>}
    {!orderNote.includes('คงเหลือตอนสั่งซื้อ') && <div className="text-amber-700">คงเหลือตอนสั่งซื้อ: ไม่ได้บันทึก</div>}
    {stock?.status === 'loaded'
      ? <div className="font-semibold text-green-600" title="ยอดคลังหลักปกติ ณ เปิดหน้ารับ GR ก่อนรับเข้าครั้งนี้ ไม่รวม Safety และคลังย่อย">คงเหลือปัจจุบัน: {stock.qty.toLocaleString('en-US', { maximumFractionDigits: 2 })} {unitName}</div>
      : <div className="text-red-600" role="status">คงเหลือปัจจุบัน: โหลดไม่สำเร็จ</div>}
  </div>
}
