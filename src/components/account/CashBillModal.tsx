import { useEffect, useState } from 'react'
import { pdf } from '@react-pdf/renderer'
import { supabase } from '../../lib/supabase'
import Modal from '../ui/Modal'
import CashBillPDF from './pdf/CashBillPDF'

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
    cash_bill_no?: string | null
  } | null
}

interface CashBillModalProps {
  open: boolean
  order: CashBillOrder | null
  onClose: () => void
  /** เรียกเมื่อกดยืนยัน — ส่ง order + เลขบิลเงินสดที่สร้างอัตโนมัติ */
  onConfirm: (order: CashBillOrder, invoiceNo: string) => void
  submitting?: boolean
  /** ซ่อนปุ่มยืนยัน — ใช้สำหรับดูบิลอย่างเดียว (เมนูรายการอนุมัติ) */
  hideConfirm?: boolean
}

const TOTAL_ROWS = 12

/* ─── Auto-generate invoice number ─── */
async function generateNextInvoiceNo(companyCode: string): Promise<string> {
  const now = new Date()
  const yy = now.getFullYear().toString().slice(-2)
  const mm = (now.getMonth() + 1).toString().padStart(2, '0')
  const prefix = `CB${companyCode.toUpperCase()}${yy}${mm}`

  try {
    // Query all confirmed cash bills with cash_bill_no matching this prefix
    const { data } = await supabase
      .from('or_orders')
      .select('billing_details')
      .filter('billing_details->>cash_bill_no', 'like', `${prefix}%`)

    let maxSeq = 0
    if (data) {
      data.forEach((row: { billing_details: Record<string, unknown> | null }) => {
        const no = row.billing_details?.cash_bill_no as string | undefined
        if (no && no.startsWith(prefix)) {
          const seq = parseInt(no.slice(prefix.length), 10)
          if (!isNaN(seq) && seq > maxSeq) maxSeq = seq
        }
      })
    }

    return prefix + (maxSeq + 1).toString().padStart(4, '0')
  } catch (err) {
    console.error('Error generating invoice number:', err)
    return prefix + '0001'
  }
}

/* ─── Component ─── */
export default function CashBillModal({ open, order, onClose, onConfirm, submitting, hideConfirm }: CashBillModalProps) {
  const [company, setCompany] = useState('tr')
  const [invoiceNo, setInvoiceNo] = useState('')
  const [refNo, setRefNo] = useState('')
  const [invoiceDate, setInvoiceDate] = useState(() => new Date().toISOString().split('T')[0])
  const [customerName, setCustomerName] = useState('')
  const [customerAddress1, setCustomerAddress1] = useState('')
  const [customerAddress2, setCustomerAddress2] = useState('')
  const [items, setItems] = useState<CashBillItem[]>([])
  const [exporting, setExporting] = useState(false)

  /* Auto-generate invoice number when company changes */
  useEffect(() => {
    if (!open || !order) return
    const code = company === 'tr' ? 'TR' : 'ODF'

    // ถ้า order เคยมีเลขบิลแล้ว (ดูซ้ำ) ให้ใช้เลขเดิม
    const existingNo = order.billing_details?.cash_bill_no
    if (existingNo && typeof existingNo === 'string' && existingNo.includes(code)) {
      setInvoiceNo(existingNo)
    } else {
      generateNextInvoiceNo(code).then(setInvoiceNo)
    }
  }, [open, order, company])

  /* Pre-fill data from order */
  useEffect(() => {
    if (!order) return
    const bd = order.billing_details || {}
    setRefNo(order.bill_no || '')
    setCustomerName(bd.tax_customer_name || order.customer_name || '')

    // Build address
    const taxAddr = (bd.tax_customer_address || '').trim()
    let fullAddr: string
    if (taxAddr) {
      fullAddr = taxAddr
    } else {
      const addrParts = [
        bd.address_line || '',
        bd.sub_district ? 'แขวง' + bd.sub_district : '',
        bd.district ? 'เขต' + bd.district : '',
        bd.province || '',
        bd.postal_code || '',
      ].filter(Boolean)
      fullAddr = addrParts.join(' ')
    }
    if (fullAddr.length > 60) {
      const breakIdx = fullAddr.lastIndexOf(' ', 60)
      const splitAt = breakIdx > 30 ? breakIdx : 60
      setCustomerAddress1(fullAddr.substring(0, splitAt))
      setCustomerAddress2(fullAddr.substring(splitAt).trimStart())
    } else {
      setCustomerAddress1(fullAddr)
      setCustomerAddress2('')
    }

    // Build items
    const taxItems = bd.tax_items || []
    if (taxItems.length > 0) {
      const DEDUPE_KEYWORDS = ['TWP', 'TWB']
      const isDedupe = (name: string) => DEDUPE_KEYWORDS.some((kw) => name.includes(kw))
      const result: CashBillItem[] = []
      const seen = new Set<string>()
      taxItems.forEach((ti: { product_name: string; quantity: number; unit_price: number }) => {
        if (isDedupe(ti.product_name)) {
          if (!seen.has(ti.product_name)) {
            seen.add(ti.product_name)
            result.push({ desc: ti.product_name, qty: 1, price: ti.unit_price })
          }
        } else {
          result.push({ desc: ti.product_name, qty: ti.quantity, price: ti.unit_price })
        }
      })
      setItems(result)
    } else {
      setItems([{ desc: 'สินค้า', qty: 1, price: order.total_amount || 0 }])
    }
  }, [order])

  /* Padded items */
  const filledItems: CashBillItem[] = (() => {
    const arr = [...items]
    while (arr.length < TOTAL_ROWS) arr.push({ desc: '', qty: 0, price: 0 })
    return arr
  })()

  const grandTotal = filledItems.reduce((s, r) => s + (r.qty || 0) * (r.price || 0), 0)

  function handleItemChange(idx: number, field: keyof CashBillItem, value: string) {
    setItems(() => {
      const copy = [...filledItems]
      if (field === 'desc') copy[idx] = { ...copy[idx], desc: value }
      else if (field === 'qty') copy[idx] = { ...copy[idx], qty: parseFloat(value) || 0 }
      else copy[idx] = { ...copy[idx], price: parseFloat(value) || 0 }
      return copy
    })
  }

  /* Export PDF */
  async function handleExportPDF() {
    setExporting(true)
    try {
      const blob = await pdf(
        <CashBillPDF
          company={company as 'tr' | 'odf'}
          invoiceNo={invoiceNo}
          refNo={refNo}
          invoiceDate={invoiceDate}
          customerName={customerName}
          customerAddress1={customerAddress1}
          customerAddress2={customerAddress2}
          items={filledItems.filter((r) => r.desc || r.qty > 0 || r.price > 0)}
          grandTotal={grandTotal}
        />
      ).toBlob()

      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `บิลเงินสด-${invoiceNo}.pdf`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Error generating PDF:', err)
      alert('เกิดข้อผิดพลาดในการสร้าง PDF')
    } finally {
      setExporting(false)
    }
  }

  function handleConfirm() {
    if (order) onConfirm(order, invoiceNo)
  }

  if (!open || !order) return null

  return (
    <Modal open={open} onClose={onClose} contentClassName="max-w-[600px] w-full" closeOnBackdropClick>
      <div className="p-4 space-y-3 max-h-[90vh] overflow-y-auto">
        {/* ─── Controls Bar ─── */}
        <div className="flex flex-wrap items-center justify-between gap-3 bg-gray-50 rounded-xl px-4 py-3">
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium text-gray-600">บริษัท:</label>
            <select
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-sky-400"
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
              className="px-4 py-2 bg-sky-500 text-white rounded-lg hover:bg-sky-600 text-sm font-semibold transition-colors disabled:opacity-50 inline-flex items-center gap-2"
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

        {/* ─── Edit Form ─── */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-4">
          {/* Document Info */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">เลขที่ (อัตโนมัติ)</label>
              <input type="text" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-sky-400 focus:border-sky-400 text-center bg-sky-50 font-semibold text-sky-700" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">วันที่</label>
              <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-sky-400 focus:border-sky-400" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">เลขที่อ้างอิง</label>
              <input type="text" value={refNo} onChange={(e) => setRefNo(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-sky-400 focus:border-sky-400 text-center" />
            </div>
          </div>

          {/* Customer Info */}
          <div className="bg-gray-50 rounded-lg p-3 space-y-2">
            <h3 className="text-sm font-bold text-gray-700">ข้อมูลลูกค้า</h3>
            <div className="grid grid-cols-1 gap-2">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">ชื่อลูกค้า</label>
                <input type="text" value={customerName} onChange={(e) => setCustomerName(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-sky-400 focus:border-sky-400" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">ที่อยู่ บรรทัด 1</label>
                <input type="text" value={customerAddress1} onChange={(e) => setCustomerAddress1(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-sky-400 focus:border-sky-400" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">ที่อยู่ บรรทัด 2</label>
                <input type="text" value={customerAddress2} onChange={(e) => setCustomerAddress2(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-sky-400 focus:border-sky-400" />
              </div>
            </div>
          </div>

          {/* Items Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-sky-500 text-white">
                  <th className="px-2 py-2 text-left rounded-tl-lg">รายการ</th>
                  <th className="px-2 py-2 text-center w-16">จำนวน</th>
                  <th className="px-2 py-2 text-center w-24">หน่วยละ</th>
                  <th className="px-2 py-2 text-right w-24 rounded-tr-lg">จำนวนเงิน</th>
                </tr>
              </thead>
              <tbody>
                {filledItems.map((row, idx) => {
                  const lineTotal = (row.qty || 0) * (row.price || 0)
                  return (
                    <tr key={idx} className={idx % 2 === 1 ? 'bg-sky-50/40 border-t border-gray-100' : 'border-t border-gray-100'}>
                      <td className="px-1 py-0.5">
                        <input type="text" value={row.desc} onChange={(e) => handleItemChange(idx, 'desc', e.target.value)}
                          className="w-full border-0 bg-transparent px-1 py-0.5 text-sm focus:ring-1 focus:ring-sky-300 rounded"
                          placeholder={idx === 0 ? 'ชื่อสินค้า' : ''} />
                      </td>
                      <td className="px-1 py-0.5">
                        <input type="number" value={row.qty || ''} onChange={(e) => handleItemChange(idx, 'qty', e.target.value)}
                          className="w-full border-0 bg-transparent px-1 py-0.5 text-sm text-center focus:ring-1 focus:ring-sky-300 rounded [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
                      </td>
                      <td className="px-1 py-0.5">
                        <input type="number" value={row.price || ''} onChange={(e) => handleItemChange(idx, 'price', e.target.value)} step="0.01"
                          className="w-full border-0 bg-transparent px-1 py-0.5 text-sm text-right focus:ring-1 focus:ring-sky-300 rounded [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
                      </td>
                      <td className="px-2 py-0.5 text-right text-sm font-medium">
                        {lineTotal > 0 ? lineTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ''}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Total */}
          <div className="flex justify-end">
            <div className="flex items-center gap-4 bg-sky-500 text-white rounded-lg px-4 py-2">
              <span className="font-bold">รวมเงิน</span>
              <span className="font-bold text-lg tabular-nums">
                {grandTotal > 0 ? grandTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'} บาท
              </span>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  )
}
