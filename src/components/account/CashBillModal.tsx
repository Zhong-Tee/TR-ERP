import { useEffect, useRef, useState } from 'react'
import Modal from '../ui/Modal'

/* ─── Types ─── */
interface CashBillItem {
  desc: string
  qty: number
  price: number
}

interface CashBillOrder {
  id: string
  bill_no: string
  customer_name: string
  total_amount: number
  billing_details?: {
    tax_customer_name?: string | null
    tax_customer_address?: string | null
    tax_customer_phone?: string | null
    tax_id?: string | null
    tax_items?: { product_name: string; quantity: number; unit_price: number }[]
    address_line?: string | null
    sub_district?: string | null
    district?: string | null
    province?: string | null
    postal_code?: string | null
    mobile_phone?: string | null
  } | null
}

interface CashBillModalProps {
  open: boolean
  order: CashBillOrder | null
  onClose: () => void
  /** เรียกเมื่อกดยืนยัน */
  onConfirm: (order: CashBillOrder) => void
  submitting?: boolean
  /** ซ่อนปุ่มยืนยัน — ใช้สำหรับดูบิลอย่างเดียว (เมนูรายการอนุมัติ) */
  hideConfirm?: boolean
}

/* ─── Company Data (อ้างอิงจาก cashbill.html) ─── */
const companyData: Record<string, { name: string; address: string; taxId: string; phone: string }> = {
  tr: {
    name: 'ห้างหุ้นส่วนจำกัด ทีอาร์ คิดส์ช็อป (สำนักงานใหญ่)',
    address: '1641,1643 ชั้นที่ 3 ถนนเพชรเกษม แขวงหลักสอง\nเขตบางแค กรุงเทพมหานคร 10160',
    taxId: 'เลขประจำตัวผู้เสียภาษี: 0103563005345',
    phone: 'เบอร์โทร: 0829341288',
  },
  odf: {
    name: 'บริษัท ออนดีมานด์ แฟคตอรี่ จำกัด',
    address: '1641,1643 ถนนเพชรเกษม แขวงหลักสอง\nเขตบางแค กรุงเทพมหานคร 10160',
    taxId: 'เลขประจำตัวผู้เสียภาษี: 0105564109286',
    phone: 'เบอร์โทร: 0829341288',
  },
}

const TOTAL_ROWS = 12

/* ─── Thai Baht Text Conversion (อ้างอิงจาก cashbill.html) ─── */
function convertDigits(s: string): string {
  const n = ['', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า']
  const d = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน', 'ล้าน']
  let o = ''
  const l = s.length
  for (let i = 0; i < l; i++) {
    const v = parseInt(s[i])
    const p = l - i - 1
    if (v > 0) {
      if (p === 1 && v === 1) o += 'สิบ'
      else if (p === 1 && v === 2) o += 'ยี่สิบ'
      else if (p === 0 && v === 1 && l > 1 && s[l - 2] !== '0') o += 'เอ็ด'
      else o += n[v] + d[p]
    }
  }
  return o
}

function bahtText(num: number): string {
  if (isNaN(num) || num <= 0) return '-'
  const s = num.toFixed(2)
  const [intPart, decPart] = s.split('.')
  const t = convertDigits(intPart)
  return t ? t + 'บาท' + (decPart === '00' ? 'ถ้วน' : convertDigits(decPart) + 'สตางค์') : ''
}

/* ─── Component ─── */
export default function CashBillModal({ open, order, onClose, onConfirm, submitting, hideConfirm }: CashBillModalProps) {
  const billRef = useRef<HTMLDivElement>(null)
  const [company, setCompany] = useState('tr')
  const [bookNo, setBookNo] = useState('01')
  const [invoiceNo, setInvoiceNo] = useState('0001')
  const [refNo, setRefNo] = useState('')
  const [invoiceDate, setInvoiceDate] = useState(() => new Date().toISOString().split('T')[0])
  const [customerName, setCustomerName] = useState('')
  const [customerAddress1, setCustomerAddress1] = useState('')
  const [customerAddress2, setCustomerAddress2] = useState('')
  const [taxId, setTaxId] = useState('')
  const [items, setItems] = useState<CashBillItem[]>([])
  const [exporting, setExporting] = useState(false)

  /* Pre-fill data from order */
  useEffect(() => {
    if (!order) return
    const bd = order.billing_details || {}
    setRefNo(order.bill_no || '')
    setCustomerName(bd.tax_customer_name || order.customer_name || '')
    setTaxId(bd.tax_id || '')

    // Build address
    const addrParts = [
      bd.tax_customer_address || bd.address_line || '',
      bd.sub_district ? 'แขวง' + bd.sub_district : '',
      bd.district ? 'เขต' + bd.district : '',
      bd.province || '',
      bd.postal_code || '',
    ].filter(Boolean)
    const fullAddr = addrParts.join(' ')
    if (fullAddr.length > 60) {
      setCustomerAddress1(fullAddr.substring(0, 60))
      setCustomerAddress2(fullAddr.substring(60))
    } else {
      setCustomerAddress1(fullAddr)
      setCustomerAddress2('')
    }

    // Build items from tax_items or fallback to single item
    const taxItems = bd.tax_items || []
    if (taxItems.length > 0) {
      // สินค้าที่ต้องแสดงแค่บรรทัดเดียว (จำนวน 1) แม้มีหลายรายการ
      const DEDUPE_KEYWORDS = ['TWP', 'TWB']
      const isDedupe = (name: string) => DEDUPE_KEYWORDS.some((kw) => name.includes(kw))

      const result: CashBillItem[] = []
      const seen = new Set<string>()
      taxItems.forEach((ti: { product_name: string; quantity: number; unit_price: number }) => {
        if (isDedupe(ti.product_name)) {
          // สินค้าตรายาง TWP/TWB → แสดงแค่บรรทัดเดียว จำนวน 1
          if (!seen.has(ti.product_name)) {
            seen.add(ti.product_name)
            result.push({ desc: ti.product_name, qty: 1, price: ti.unit_price })
          }
        } else {
          // สินค้าอื่น → แสดงทุกบรรทัดตามปกติ
          result.push({ desc: ti.product_name, qty: ti.quantity, price: ti.unit_price })
        }
      })
      setItems(result)
    } else {
      setItems([{ desc: 'สินค้า', qty: 1, price: order.total_amount || 0 }])
    }
  }, [order])

  /* Padded items (fill to TOTAL_ROWS) */
  const filledItems: CashBillItem[] = (() => {
    const arr = [...items]
    while (arr.length < TOTAL_ROWS) arr.push({ desc: '', qty: 0, price: 0 })
    return arr
  })()

  const grandTotal = filledItems.reduce((s, r) => s + (r.qty || 0) * (r.price || 0), 0)
  const comp = companyData[company]

  function handleItemChange(idx: number, field: keyof CashBillItem, value: string) {
    setItems(() => {
      const copy = [...filledItems]
      if (field === 'desc') copy[idx] = { ...copy[idx], desc: value }
      else if (field === 'qty') copy[idx] = { ...copy[idx], qty: parseFloat(value) || 0 }
      else copy[idx] = { ...copy[idx], price: parseFloat(value) || 0 }
      return copy
    })
  }

  /* Export PDF via html2pdf.js — ใช้ logic เดียวกับ cashbill.html */
  async function handleExportPDF() {
    if (!billRef.current) return
    setExporting(true)

    // หา scale wrapper (parent) แล้วปิด transform ชั่วคราว
    const billEl = billRef.current as HTMLElement
    const scaleWrapper = billEl.parentElement as HTMLElement | null
    const origTransform = scaleWrapper?.style.transform || ''
    const origHeight = scaleWrapper?.style.height || ''
    if (scaleWrapper) {
      scaleWrapper.style.transform = 'none'
      scaleWrapper.style.height = 'auto'
    }

    try {
      const html2pdf = (await import('html2pdf.js')).default
      const billNo = `${bookNo}/${invoiceNo}`

      // ─── options ตรงกับ cashbill.html ทุกประการ ───
      const opt = {
        margin: [0, 0, 0, 0] as [number, number, number, number],
        filename: `บิลเงินสด-${billNo.replace(/\//g, '-')}.pdf`,
        image: { type: 'jpeg' as const, quality: 1 },
        html2canvas: {
          scale: 3,
          useCORS: true,
          scrollY: 0,
          windowHeight: document.body.scrollHeight,
        },
        jsPDF: { unit: 'mm', format: [148, 210], orientation: 'portrait' as const },
      }
      await html2pdf().set(opt).from(billEl).save()
    } catch (err) {
      console.error('Error generating PDF:', err)
      alert('เกิดข้อผิดพลาดในการสร้าง PDF')
    } finally {
      // คืน scale wrapper กลับ
      if (scaleWrapper) {
        scaleWrapper.style.transform = origTransform
        scaleWrapper.style.height = origHeight
      }
      setExporting(false)
    }
  }

  function handleConfirm() {
    if (order) onConfirm(order)
  }

  if (!open || !order) return null

  return (
    <Modal open={open} onClose={onClose} contentClassName="max-w-[520px] w-full" closeOnBackdropClick>
      <div className="p-4 space-y-4">
        {/* ─── Controls Bar ─── */}
        <div className="flex flex-wrap items-center justify-between gap-3 bg-gray-50 rounded-xl px-4 py-3">
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium text-gray-600">บริษัท:</label>
            <select
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-400"
            >
              <option value="tr">TRKidsshop</option>
              <option value="odf">Ondemand Factory</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleExportPDF}
              disabled={exporting}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-semibold transition-colors disabled:opacity-50 inline-flex items-center gap-2"
            >
              {exporting ? (
                <>
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  กำลังสร้าง PDF...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  Export PDF
                </>
              )}
            </button>
            {!hideConfirm && (
              <button
                type="button"
                onClick={handleConfirm}
                disabled={submitting}
                className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm font-semibold transition-colors disabled:opacity-50 inline-flex items-center gap-2"
              >
                {submitting ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    กำลังยืนยัน...
                  </>
                ) : (
                  'ยืนยันบิลเงินสด'
                )}
              </button>
            )}
          </div>
        </div>

        {/* ─── Bill Preview (A5 layout อ้างอิง cashbill.html) ─── */}
        <div className="flex justify-center overflow-hidden bg-[#525659] rounded-xl py-3 px-2">
          {/* Outer wrapper ใช้ scale สำหรับ preview เท่านั้น - ไม่ถูก capture เข้า PDF */}
          <div style={{ transform: 'scale(0.8)', transformOrigin: 'top center', width: '148mm', height: 'calc(210mm * 0.8)' }}>
          <div
            ref={billRef}
            id="cash-bill-preview"
            style={{
              width: '148mm',
              minHeight: '210mm',
              padding: '6mm',
              boxSizing: 'border-box',
              fontFamily: "'Niramit', sans-serif",
              fontSize: '11px',
              backgroundColor: '#fff',
              display: 'flex',
              flexDirection: 'column',
              position: 'relative',
            }}
          >
            {/* Header */}
            <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: '2px' }}>
              {/* Company Stamp */}
              <div
                style={{
                  border: '0.5px solid #000',
                  width: '70mm',
                  height: '30mm',
                  padding: '5px',
                  fontSize: '10px',
                  lineHeight: 1.4,
                  boxSizing: 'border-box',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                }}
              >
                <div style={{ fontWeight: 'bold', fontSize: '11px' }}>{comp.name}</div>
                <div style={{ whiteSpace: 'pre-line' }}>{comp.address}</div>
                <div>{comp.taxId}</div>
                <div>{comp.phone}</div>
              </div>
              {/* Title + Bill Numbers */}
              <div style={{ textAlign: 'right', width: '45%' }}>
                <h2 style={{ margin: 0, fontSize: '22px', fontWeight: 'bold' }}>บิลเงินสด</h2>
                <div style={{ fontWeight: 'bold', marginBottom: '5px' }}>CASH SALE</div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '5px', marginTop: '5px' }}>
                  <label style={{ width: '80px', textAlign: 'right', fontWeight: 'bold' }}>เล่มที่:</label>
                  <input type="text" value={bookNo} onChange={(e) => setBookNo(e.target.value)} className="cb-input" style={{ width: '70px', textAlign: 'center' }} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '5px' }}>
                  <label style={{ width: '80px', textAlign: 'right', fontWeight: 'bold' }}>เลขที่:</label>
                  <input type="text" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} className="cb-input" style={{ width: '70px', textAlign: 'center' }} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '5px' }}>
                  <label style={{ width: '80px', textAlign: 'right', fontWeight: 'bold' }}>เลขที่อ้างอิง:</label>
                  <input type="text" value={refNo} onChange={(e) => setRefNo(e.target.value)} className="cb-input" style={{ width: '120px', textAlign: 'center' }} />
                </div>
              </div>
            </header>

            {/* Customer Details */}
            <section style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 10px', alignItems: 'center', marginBottom: '10px' }}>
              <label style={{ whiteSpace: 'nowrap', fontWeight: 'bold', textAlign: 'left' }}>วันที่/Date:</label>
              <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} className="cb-input" style={{ width: '140px' }} />
              <label style={{ whiteSpace: 'nowrap', fontWeight: 'bold', textAlign: 'left' }}>นาม/Customer:</label>
              <input type="text" value={customerName} onChange={(e) => setCustomerName(e.target.value)} className="cb-input" />
              <label style={{ whiteSpace: 'nowrap', fontWeight: 'bold', textAlign: 'left' }}>ที่อยู่/Address:</label>
              <input type="text" value={customerAddress1} onChange={(e) => setCustomerAddress1(e.target.value)} className="cb-input" />
              <label style={{ fontWeight: 'bold' }}>&nbsp;</label>
              <input type="text" value={customerAddress2} onChange={(e) => setCustomerAddress2(e.target.value)} className="cb-input" />
              <label style={{ whiteSpace: 'nowrap', fontWeight: 'bold', textAlign: 'left' }}>Tax ID:</label>
              <input type="text" value={taxId} onChange={(e) => setTaxId(e.target.value)} className="cb-input" />
            </section>

            {/* Items Table */}
            <table
              style={{
                width: '100%',
                marginTop: '5px',
                borderSpacing: 0,
                borderCollapse: 'collapse',
                border: '0.3px solid #444',
                tableLayout: 'fixed',
              }}
            >
              <colgroup>
                <col style={{ width: '55%' }} />
                <col style={{ width: '15%' }} />
                <col style={{ width: '15%' }} />
                <col style={{ width: '15%' }} />
              </colgroup>
              <thead>
                <tr>
                  {['รายการ / DESCRIPTION', 'จำนวน', 'หน่วยละ', 'จำนวนเงิน'].map((h, i) => (
                    <th
                      key={h}
                      style={{
                        border: '0.3px solid #444',
                        padding: 0,
                        height: '28px',
                        verticalAlign: 'middle',
                        backgroundColor: '#f2f2f2',
                        fontWeight: 'bold',
                        fontSize: '11px',
                        textAlign: i === 0 ? 'left' : i === 3 ? 'right' : 'center',
                        paddingLeft: i === 0 ? '10px' : undefined,
                        paddingRight: i === 3 ? '5px' : undefined,
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filledItems.map((row, idx) => {
                  const lineTotal = (row.qty || 0) * (row.price || 0)
                  return (
                    <tr key={idx}>
                      <td style={{ border: '0.3px solid #444', padding: 0, paddingLeft: '20px', height: '28px', verticalAlign: 'middle' }}>
                        <input
                          type="text"
                          value={row.desc}
                          onChange={(e) => handleItemChange(idx, 'desc', e.target.value)}
                          className="cb-table-input"
                          style={{ textAlign: 'left' }}
                        />
                      </td>
                      <td style={{ border: '0.3px solid #444', padding: 0, height: '28px', verticalAlign: 'middle' }}>
                        <input
                          type="number"
                          value={row.qty || ''}
                          onChange={(e) => handleItemChange(idx, 'qty', e.target.value)}
                          className="cb-table-input"
                          style={{ textAlign: 'center' }}
                        />
                      </td>
                      <td style={{ border: '0.3px solid #444', padding: 0, height: '28px', verticalAlign: 'middle' }}>
                        <input
                          type="number"
                          value={row.price || ''}
                          onChange={(e) => handleItemChange(idx, 'price', e.target.value)}
                          className="cb-table-input"
                          style={{ textAlign: 'center' }}
                          step="0.01"
                        />
                      </td>
                      <td style={{ border: '0.3px solid #444', padding: 0, height: '28px', verticalAlign: 'middle' }}>
                        <span style={{ display: 'block', textAlign: 'right', paddingRight: '5px', lineHeight: '28px', fontSize: '11px' }}>
                          {lineTotal > 0 ? lineTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ''}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{ backgroundColor: '#f2f2f2', fontWeight: 'bold' }}>
                  <td
                    colSpan={2}
                    style={{ border: '0.3px solid #444', height: '28px', verticalAlign: 'middle', textAlign: 'center', fontWeight: 'bold', fontSize: '11px' }}
                  >
                    {bahtText(grandTotal)}
                  </td>
                  <td
                    style={{ border: '0.3px solid #444', height: '28px', verticalAlign: 'middle', textAlign: 'center', fontWeight: 'bold', fontSize: '11px' }}
                  >
                    รวมเงิน
                  </td>
                  <td
                    style={{ border: '0.3px solid #444', height: '28px', verticalAlign: 'middle', textAlign: 'right', paddingRight: '5px', fontWeight: 'bold', fontSize: '11px' }}
                  >
                    {grandTotal > 0
                      ? grandTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                      : '0.00'}
                  </td>
                </tr>
              </tfoot>
            </table>

            {/* Signature */}
            <footer style={{ marginTop: 'auto', paddingTop: '10px', display: 'flex', justifyContent: 'space-around' }}>
              <div style={{ textAlign: 'center', width: '40%', marginTop: '20px', paddingTop: '5px', borderTop: '1px dotted #000' }}>
                ผู้รับเงิน / COLLECTOR
              </div>
              <div style={{ textAlign: 'center', width: '40%', marginTop: '20px', paddingTop: '5px', borderTop: '1px dotted #000' }}>
                วันที่รับเงิน
              </div>
            </footer>
          </div>
          </div>{/* end scale wrapper */}
        </div>
      </div>

      {/* ─── Scoped Styles ─── */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Niramit:wght@400;500;700&display=swap');
        #cash-bill-preview * { font-family: 'Niramit', sans-serif; }
        .cb-input {
          border: none;
          background-image: linear-gradient(to right, #888 30%, rgba(255,255,255,0) 0%);
          background-position: 0% 100%;
          background-size: 3px 1px;
          background-repeat: repeat-x;
          font-family: 'Niramit', sans-serif;
          font-size: 11px;
          width: 100%;
          box-sizing: border-box;
          background-color: transparent !important;
          height: 22px;
          line-height: 22px;
          padding: 0 5px !important;
          margin: 0 !important;
          appearance: none;
          -webkit-appearance: none;
          box-shadow: none;
          outline: none;
        }
        .cb-input:focus {
          background-image: linear-gradient(to right, #000 100%, #000 0%);
        }
        .cb-table-input {
          border: none;
          background: none !important;
          font-family: 'Niramit', sans-serif;
          font-size: 11px !important;
          height: 100%;
          width: 100%;
          display: block;
          padding: 4px 0 0 0 !important;
          margin: 0;
          outline: none;
          appearance: none;
          -webkit-appearance: none;
          box-shadow: none;
        }
        .cb-table-input::-webkit-outer-spin-button,
        .cb-table-input::-webkit-inner-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }
        .cb-table-input[type=number] {
          -moz-appearance: textfield;
        }
      `}</style>
    </Modal>
  )
}
