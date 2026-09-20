/* eslint-disable react-refresh/only-export-components */
import { forwardRef } from 'react'
import type { PreBillDocument, PreBillItem } from '../../types/prebill'
import { PREBILL_TYPE_LABEL } from '../../types/prebill'

type Props = {
  document: Partial<PreBillDocument>
  items: PreBillItem[]
}

const money = (value: unknown) => Number(value || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const PRODUCTION_CONFIRMATION_TERMS = [
  'กรุณาตรวจสอบ ชื่อ ข้อความ แบบสินค้า จำนวน สี ขนาด และรายละเอียดทั้งหมด ให้ถูกต้องก่อนยืนยันคำสั่งซื้อ',
  'เมื่อลูกค้ายืนยันรายละเอียดและชำระเงินแล้ว ถือว่า ยืนยันคำสั่งซื้อและอนุมัติให้เริ่มดำเนินการผลิต',
  'สินค้าสั่งผลิตเฉพาะบุคคล เมื่อเข้าสู่กระบวนการผลิตแล้ว ไม่สามารถแก้ไข เปลี่ยนแปลง หรือยกเลิกรายการได้',
  'หากต้องการแก้ไขรายละเอียดหลังยืนยัน กรุณาติดต่อแอดมินโดยเร็ว ทั้งนี้ขึ้นอยู่กับสถานะการผลิต และอาจมีค่าใช้จ่ายเพิ่มเติม',
  'ระยะเวลาผลิตเริ่มนับหลังจาก ยืนยันรายละเอียดและชำระเงินครบถ้วน',
  'ระยะเวลาจัดส่งเป็นระยะเวลาโดยประมาณ และอาจแตกต่างตามพื้นที่ปลายทางหรือบริษัทขนส่ง',
  'กรณีพื้นที่ห่างไกล อาจมี ค่าจัดส่งเพิ่มเติม ตามอัตราของบริษัทขนส่ง',
  'กรุณาเก็บใบยืนยันรายการนี้ไว้สำหรับใช้อ้างอิงคำสั่งซื้อ',
]

function shippingBreakdown(document: Partial<PreBillDocument>) {
  const snapshot = (document.shipping_snapshot || {}) as Record<string, unknown>
  const baseWaived = snapshot.base_shipping_waived === true
  const standardBeforeWaiver = Number(snapshot.standard_shipping || 0)
  const standard = snapshot.charged_standard_shipping != null
    ? Number(snapshot.charged_standard_shipping || 0)
    : baseWaived ? 0 : standardBeforeWaiver
  const special = Number(snapshot.special_area_surcharge || 0)
  const available = snapshot.automatic_shipping_active === true || snapshot.standard_shipping != null || snapshot.special_area_surcharge != null
  return { available, standard, standardBeforeWaiver, special, baseWaived }
}

export function buildPreBillCustomerText(document: Partial<PreBillDocument>, items: PreBillItem[]): string {
  const shipping = shippingBreakdown(document)
  const detail = items.map((item, index) => {
    const specs = [
      item.ink_color && `สีหมึก: ${item.ink_color}`,
      item.product_type && `ประเภท/ชั้น: ${item.product_type}`,
      item.cartoon_pattern && `ลาย: ${item.cartoon_pattern}`,
      item.line_pattern && `แบบบรรทัด: ${item.line_pattern}`,
      item.font && `ฟอนต์: ${item.font}`,
      !item.no_name_line && item.line_1 && `บรรทัด 1: ${item.line_1}`,
      !item.no_name_line && item.line_2 && `บรรทัด 2: ${item.line_2}`,
      !item.no_name_line && item.line_3 && `บรรทัด 3: ${item.line_3}`,
      item.no_name_line && 'ไม่รับชื่อ',
      item.notes && `หมายเหตุ: ${item.notes}`,
    ].filter(Boolean)
    return [
      `${index + 1}. ${item.product_name}${item.is_free ? ' (ของแถม)' : ''}`,
      `จำนวน ${item.quantity} ชิ้น${item.is_free ? '' : ` × ${money(item.unit_price)} บาท`}`,
      ...specs,
    ].join('\n')
  }).join('\n\n')
  const customerAndSeller = [
    [PREBILL_TYPE_LABEL[document.document_type || 'quotation'], document.document_no].filter(Boolean).join(' '),
    `ลูกค้า: ${document.customer_name || 'ลูกค้า'}`,
    document.recipient_name ? `ชื่อผู้รับ: ${document.recipient_name}` : '',
    document.customer_phone ? `เบอร์โทร: ${document.customer_phone}` : '',
    document.customer_address ? `ที่อยู่: ${document.customer_address}` : '',
    `ผู้ขาย: ${document.owner_name || '-'}`,
    `ช่องทาง: ${document.channel_code || '-'}`,
  ].filter(Boolean).join('\n')
  const totals = [
    `ยอดสินค้า: ${money(document.subtotal)} บาท`,
    Number(document.promotion_discount || 0) > 0 ? `ส่วนลดโปรโมชั่น: ${money(document.promotion_discount)} บาท` : '',
    Number(document.special_discount || 0) > 0 ? `ส่วนลดพิเศษ: ${money(document.special_discount)} บาท` : '',
    shipping.available ? `ค่าจัดส่งปกติ${shipping.baseWaived ? ' (ยกเว้น)' : ''}: ${money(shipping.standard)} บาท` : '',
    shipping.available ? `ค่าพื้นที่ห่างไกล/พิเศษ: ${money(shipping.special)} บาท` : '',
    `ค่าจัดส่ง${shipping.available ? 'รวม' : ''}: ${money(document.shipping_cost)} บาท`,
    `ยอดสุทธิ: ${money(document.total_amount)} บาท`,
    document.payment_method ? `วิธีชำระเงิน: ${document.payment_method}` : '',
    `ระยะเวลาจัดส่ง: ${document.delivery_term || '-'}`,
    document.valid_until ? `ยืนราคาถึงวันที่ ${new Date(`${document.valid_until}T00:00:00`).toLocaleDateString('th-TH')}` : '',
  ].filter(Boolean).join('\n')
  const terms = document.document_type === 'production_confirmation'
    ? `📌 เงื่อนไขการยืนยันคำสั่งซื้อ\n\n${PRODUCTION_CONFIRMATION_TERMS.map(term => `• ${term}`).join('\n')}`
    : ''
  return [customerAndSeller, detail, totals, terms].filter(Boolean).join('\n\n')
}

const PreBillPreview = forwardRef<HTMLDivElement, Props>(function PreBillPreview({ document, items }, ref) {
  const shipping = shippingBreakdown(document)
  return (
    <div ref={ref} className="bg-white text-slate-900 w-[794px] min-h-[1123px] p-12 font-sans">
      <div className="flex items-start justify-between border-b-4 border-blue-700 pb-5">
        <div>
          <div className="text-3xl font-black text-blue-800">{document.header_name || PREBILL_TYPE_LABEL[document.document_type || 'quotation']}</div>
          <div className="mt-1 text-sm text-slate-500">{PREBILL_TYPE_LABEL[document.document_type || 'quotation']}</div>
        </div>
        <div className="text-right text-sm">
          {document.document_no && <div className="font-bold text-lg">{document.document_no}</div>}
          <div>วันที่ {new Date().toLocaleDateString('th-TH')}</div>
          <div className="font-bold text-red-700">ยืนราคาถึงวันที่ {document.valid_until ? new Date(`${document.valid_until}T00:00:00`).toLocaleDateString('th-TH') : '-'}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6 py-6 text-sm">
        <div className="rounded-xl bg-slate-50 p-4">
          <div className="mb-2 border-b border-slate-200 pb-1 text-xs font-bold text-slate-500">ข้อมูลลูกค้า</div>
          <div className="space-y-1 leading-relaxed">
            <div><b>ชื่อลูกค้า:</b> {document.customer_name || 'ลูกค้า'}</div>
            {document.recipient_name && <div><b>ชื่อผู้รับ:</b> {document.recipient_name}</div>}
            {document.customer_phone && <div><b>เบอร์โทร:</b> {document.customer_phone}</div>}
            {document.customer_address && <div className="whitespace-pre-wrap"><b>ที่อยู่:</b> {document.customer_address}</div>}
          </div>
        </div>
        <div className="rounded-xl bg-blue-50 p-4">
          <div className="mb-2 border-b border-blue-200 pb-1 text-xs font-bold text-slate-500">ข้อมูลผู้ขาย</div>
          <div className="space-y-1 leading-relaxed">
            <div><b>ผู้ขาย:</b> {document.owner_name || '-'}</div>
            <div><b>ช่องทาง:</b> {document.channel_code || '-'}</div>
            <div><b>ระยะเวลาจัดส่ง:</b> {document.delivery_term || '-'}</div>
            <div><b>วิธีการชำระเงิน:</b> {document.payment_method || '-'}</div>
          </div>
        </div>
      </div>

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-blue-800 text-white">
            <th className="p-3 text-center w-12">#</th>
            <th className="p-3 text-left">สินค้า / รายละเอียด</th>
            <th className="p-3 text-center w-20">จำนวน</th>
            <th className="p-3 text-right w-28">ราคา/หน่วย</th>
            <th className="p-3 text-right w-28">รวม</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => {
            const leftSpecs = [
              item.cartoon_pattern && `ลาย: ${item.cartoon_pattern}`,
              item.ink_color && `สีหมึก: ${item.ink_color}`,
              item.font && `ฟอนต์: ${item.font}`,
            ].filter((value): value is string => Boolean(value))
            const rightSpecs = [
              !item.no_name_line && item.line_1 && `บรรทัด 1: ${item.line_1}`,
              !item.no_name_line && item.line_2 && `บรรทัด 2: ${item.line_2}`,
              !item.no_name_line && item.line_3 && `บรรทัด 3: ${item.line_3}`,
            ].filter((value): value is string => Boolean(value))
            const otherSpecs = [
              item.product_type && `ประเภท/ชั้น: ${item.product_type}`,
              item.line_pattern && `แบบบรรทัด: ${item.line_pattern}`,
              item.no_name_line && 'ไม่รับชื่อ',
              item.notes && `หมายเหตุ: ${item.notes}`,
            ].filter((value): value is string => Boolean(value))
            return (
              <tr key={item.id || index} className="border-b border-slate-200 align-top">
                <td className="p-3 text-center">{index + 1}</td>
                <td className="p-3">
                  <div className="font-bold">{item.product_name} {item.is_free && <span className="text-emerald-700">(ของแถม)</span>}</div>
                  {(leftSpecs.length > 0 || rightSpecs.length > 0) && <div className="mt-1 grid grid-cols-2 gap-x-5 text-xs leading-5 text-slate-600"><div>{leftSpecs.map(spec => <div key={spec}>{spec}</div>)}</div><div>{rightSpecs.map(spec => <div key={spec}>{spec}</div>)}</div></div>}
                  {otherSpecs.length > 0 && <div className="mt-1 space-y-0.5 text-xs leading-5 text-slate-600">{otherSpecs.map(spec => <div key={spec}>{spec}</div>)}</div>}
                </td>
                <td className="p-3 text-center">{item.quantity}</td>
                <td className="p-3 text-right">{item.is_free ? 'ฟรี' : money(item.unit_price)}</td>
                <td className="p-3 text-right font-semibold">{item.is_free ? '0.00' : money(item.quantity * item.unit_price)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <div className="ml-auto mt-7 w-[360px] space-y-2 text-sm">
        <div className="flex justify-between"><span>ยอดสินค้า</span><b>{money(document.subtotal)} บาท</b></div>
        {Number(document.promotion_discount || 0) > 0 && <div className="flex justify-between text-emerald-700"><span>ส่วนลดโปรโมชั่น</span><b>-{money(document.promotion_discount)} บาท</b></div>}
        {Number(document.special_discount || 0) > 0 && <div className="flex justify-between text-emerald-700"><span>ส่วนลดพิเศษ</span><b>-{money(document.special_discount)} บาท</b></div>}
        {shipping.available && <div className="flex justify-between text-sky-700"><span>ค่าจัดส่งปกติ{shipping.baseWaived ? ' (ยกเว้น)' : ''}</span><b>{money(shipping.standard)} บาท</b></div>}
        {shipping.available && <div className="flex justify-between text-violet-700"><span>ค่าพื้นที่ห่างไกล/พิเศษ</span><b>{money(shipping.special)} บาท</b></div>}
        <div className={`flex justify-between ${shipping.available ? 'border-t pt-2 font-semibold' : ''}`}><span>ค่าจัดส่ง{shipping.available ? 'รวม' : ''}</span><b>{money(document.shipping_cost)} บาท</b></div>
        <div className="flex justify-between border-t-2 border-blue-700 pt-3 text-xl text-blue-800"><span className="font-bold">ยอดสุทธิ</span><b>{money(document.total_amount)} บาท</b></div>
      </div>

      {document.document_type === 'production_confirmation' && (
        <div className="mt-10 rounded-xl border-2 border-amber-300 bg-amber-50 p-4 text-xs leading-4">
          <div className="font-bold">📌 เงื่อนไขการยืนยันคำสั่งซื้อ</div>
          <ul className="mt-2 list-disc space-y-0.5 pl-5">
            {PRODUCTION_CONFIRMATION_TERMS.map(term => <li key={term}>{term}</li>)}
          </ul>
        </div>
      )}
    </div>
  )
})

export default PreBillPreview
