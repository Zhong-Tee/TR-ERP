import { useCallback, useEffect, useRef, useState } from 'react'
import { pdf } from '@react-pdf/renderer'
import Modal from '../ui/Modal'
import TaxInvoicePDF from './pdf/TaxInvoicePDF'
import type { TaxInvoiceItem } from './pdf/TaxInvoicePDF'

/* ─── Types ─── */
interface TaxInvoiceOrder {
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

interface TaxInvoiceModalProps {
  open: boolean
  order: TaxInvoiceOrder | null
  onClose: () => void
  /** เรียกเมื่อกดยืนยัน */
  onConfirm: (order: TaxInvoiceOrder) => void
  submitting?: boolean
  /** ซ่อนปุ่มยืนยัน — ใช้สำหรับดูอย่างเดียว (เมนูรายการอนุมัติ) */
  hideConfirm?: boolean
}

const VAT_RATE = 7
const TOTAL_ROWS = 10

/* ─── Company Data ─── */
const companyOptions: { value: string; label: string }[] = [
  { value: 'tr', label: 'TRKidsshop' },
  { value: 'odf', label: 'Ondemand Factory' },
]

/* ─── Component ─── */
export default function TaxInvoiceModal({
  open,
  order,
  onClose,
  onConfirm,
  submitting,
  hideConfirm,
}: TaxInvoiceModalProps) {
  const [company, setCompany] = useState('tr')
  const [invoiceNo, setInvoiceNo] = useState('')
  const [invoiceDate, setInvoiceDate] = useState(() => new Date().toISOString().split('T')[0])
  const [dueDate, setDueDate] = useState('')
  const [paymentTerms, setPaymentTerms] = useState('ชำระเงินสด')
  const [customerName, setCustomerName] = useState('')
  const [customerAddress, setCustomerAddress] = useState('')
  const [customerTaxId, setCustomerTaxId] = useState('')
  const [customerBranch, setCustomerBranch] = useState('สำนักงานใหญ่')
  const [customerPhone, setCustomerPhone] = useState('')
  const [refBillNo, setRefBillNo] = useState('')
  const [items, setItems] = useState<TaxInvoiceItem[]>([])
  const [isCopy, setIsCopy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const prevUrlRef = useRef<string | null>(null)

  /* Pre-fill data from order */
  useEffect(() => {
    if (!order) return
    const bd = order.billing_details || {}
    setRefBillNo(order.bill_no || '')
    setCustomerName(bd.tax_customer_name || order.customer_name || '')
    setCustomerTaxId(bd.tax_id || '')
    setCustomerPhone(bd.tax_customer_phone || bd.mobile_phone || '')

    // Generate invoice number
    const now = new Date()
    const yy = now.getFullYear().toString().slice(-2)
    const mm = (now.getMonth() + 1).toString().padStart(2, '0')
    setInvoiceNo(`TINV${yy}${mm}0001`)

    // Build address — ใช้ tax_customer_address ตรงๆ ถ้ามี (เป็นที่อยู่เต็มรูปแบบจากฟอร์มบิล)
    const taxAddr = (bd.tax_customer_address || '').trim()
    if (taxAddr) {
      setCustomerAddress(taxAddr)
    } else {
      const addrParts = [
        bd.address_line || '',
        bd.sub_district ? 'แขวง' + bd.sub_district : '',
        bd.district ? 'เขต' + bd.district : '',
        bd.province || '',
        bd.postal_code || '',
      ].filter(Boolean)
      setCustomerAddress(addrParts.join(' '))
    }

    // Build items from tax_items or fallback
    const taxItems = bd.tax_items || []
    if (taxItems.length > 0) {
      const result: TaxInvoiceItem[] = taxItems.map(
        (ti: { product_name: string; quantity: number; unit_price: number }) => ({
          description: ti.product_name,
          quantity: ti.quantity,
          unitPrice: ti.unit_price,
          amount: ti.quantity * ti.unit_price,
        })
      )
      setItems(result)
    } else {
      setItems([
        {
          description: 'สินค้า',
          quantity: 1,
          unitPrice: order.total_amount || 0,
          amount: order.total_amount || 0,
        },
      ])
    }
  }, [order])

  /* Fill items to TOTAL_ROWS for display */
  const filledItems: TaxInvoiceItem[] = (() => {
    const arr = [...items]
    while (arr.length < TOTAL_ROWS) {
      arr.push({ description: '', quantity: 0, unitPrice: 0, amount: 0 })
    }
    return arr
  })()

  /* Calculations */
  const subtotal = filledItems.reduce((s, r) => s + (r.amount || 0), 0)
  const vatAmount = Math.round((subtotal * VAT_RATE) / 100 * 100) / 100
  const grandTotal = subtotal + vatAmount

  function handleItemChange(
    idx: number,
    field: keyof TaxInvoiceItem,
    value: string
  ) {
    setItems(() => {
      const copy = [...filledItems]
      const row = { ...copy[idx] }
      if (field === 'description') {
        row.description = value
      } else if (field === 'quantity') {
        row.quantity = parseFloat(value) || 0
        row.amount = row.quantity * row.unitPrice
      } else if (field === 'unitPrice') {
        row.unitPrice = parseFloat(value) || 0
        row.amount = row.quantity * row.unitPrice
      } else if (field === 'amount') {
        row.amount = parseFloat(value) || 0
      }
      copy[idx] = row
      return copy
    })
  }

  /* Build the PDF element (shared between export and preview) */
  const buildPdfElement = useCallback(() => (
    <TaxInvoicePDF
      company={company as 'tr' | 'odf'}
      invoiceNo={invoiceNo}
      invoiceDate={invoiceDate}
      dueDate={dueDate || undefined}
      paymentTerms={paymentTerms || undefined}
      customerName={customerName}
      customerAddress={customerAddress}
      customerTaxId={customerTaxId}
      customerBranch={customerBranch || undefined}
      customerPhone={customerPhone || undefined}
      items={filledItems.filter((r) => r.description && r.quantity > 0)}
      subtotal={subtotal}
      vatRate={VAT_RATE}
      vatAmount={vatAmount}
      grandTotal={grandTotal}
      refBillNo={refBillNo || undefined}
      isCopy={isCopy}
    />
  ), [company, invoiceNo, invoiceDate, dueDate, paymentTerms, customerName, customerAddress, customerTaxId, customerBranch, customerPhone, filledItems, subtotal, vatAmount, grandTotal, refBillNo, isCopy])

  /* Generate PDF preview when switching to preview mode */
  useEffect(() => {
    if (mode !== 'preview') return
    let cancelled = false
    setPreviewLoading(true)

    ;(async () => {
      try {
        const blob = await pdf(buildPdfElement()).toBlob()
        if (cancelled) return
        const url = URL.createObjectURL(blob)
        if (prevUrlRef.current) URL.revokeObjectURL(prevUrlRef.current)
        prevUrlRef.current = url
        setPreviewUrl(url)
      } catch (err) {
        console.error('Preview generation error:', err)
      } finally {
        if (!cancelled) setPreviewLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [mode, buildPdfElement])

  /* Cleanup URL on unmount */
  useEffect(() => {
    return () => {
      if (prevUrlRef.current) URL.revokeObjectURL(prevUrlRef.current)
    }
  }, [])

  /* Export PDF via @react-pdf/renderer */
  async function handleExportPDF() {
    setExporting(true)
    try {
      const blob = await pdf(buildPdfElement()).toBlob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `ใบกำกับภาษี-${invoiceNo}.pdf`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Error generating Tax Invoice PDF:', err)
      alert('เกิดข้อผิดพลาดในการสร้าง PDF')
    } finally {
      setExporting(false)
    }
  }

  function handleConfirm() {
    if (order) onConfirm(order)
  }

  if (!open || !order) return null

  return (
    <Modal
      open={open}
      onClose={onClose}
      contentClassName="max-w-[780px] w-full"
      closeOnBackdropClick
    >
      <div className="p-4 space-y-4 max-h-[90vh] overflow-y-auto">
        {/* ─── Controls Bar ─── */}
        <div className="flex flex-wrap items-center justify-between gap-3 bg-gray-50 rounded-xl px-4 py-3">
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium text-gray-600">บริษัท:</label>
            <select
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-400"
            >
              {companyOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer">
              <input
                type="checkbox"
                checked={isCopy}
                onChange={(e) => setIsCopy(e.target.checked)}
                className="rounded border-gray-300"
              />
              สำเนา
            </label>
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
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                    />
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
                  'ยืนยันใบกำกับภาษี'
                )}
              </button>
            )}
          </div>
        </div>

        {/* ─── Mode Toggle ─── */}
        <div className="flex rounded-lg bg-gray-100 p-0.5">
          <button
            type="button"
            onClick={() => setMode('edit')}
            className={`flex-1 py-2 text-sm font-medium rounded-md transition-colors ${mode === 'edit' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
          >
            แก้ไข
          </button>
          <button
            type="button"
            onClick={() => setMode('preview')}
            className={`flex-1 py-2 text-sm font-medium rounded-md transition-colors ${mode === 'preview' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
          >
            พรีวิว PDF
          </button>
        </div>

        {/* ─── Preview Mode ─── */}
        {mode === 'preview' && (
          <div className="bg-[#525659] rounded-xl p-3 flex justify-center">
            {previewLoading ? (
              <div className="flex flex-col items-center justify-center py-20 text-white/70 gap-3">
                <div className="w-8 h-8 border-3 border-white/30 border-t-white rounded-full animate-spin" />
                <span className="text-sm">กำลังสร้างพรีวิว...</span>
              </div>
            ) : previewUrl ? (
              <iframe
                src={previewUrl + '#toolbar=0&navpanes=0'}
                title="Tax Invoice Preview"
                style={{ width: '595px', height: '842px', border: 'none', borderRadius: '8px', backgroundColor: '#fff' }}
              />
            ) : (
              <div className="py-20 text-white/50 text-sm">ไม่สามารถสร้างพรีวิวได้</div>
            )}
          </div>
        )}

        {/* ─── Tax Invoice Form ─── */}
        {mode === 'edit' && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-5">
          {/* Document Header */}
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-bold text-gray-800">
              ใบกำกับภาษี / TAX INVOICE
            </h2>
            <span className="text-sm text-blue-600 font-semibold bg-blue-50 px-3 py-1 rounded-full">
              {isCopy ? 'สำเนา / COPY' : 'ต้นฉบับ / ORIGINAL'}
            </span>
          </div>

          {/* Document Info */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">
                เลขที่ / No.
              </label>
              <input
                type="text"
                value={invoiceNo}
                onChange={(e) => setInvoiceNo(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-400 focus:border-blue-400"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">
                วันที่ / Date
              </label>
              <input
                type="date"
                value={invoiceDate}
                onChange={(e) => setInvoiceDate(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-400 focus:border-blue-400"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">
                ครบกำหนด / Due
              </label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-400 focus:border-blue-400"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">
                เลขที่อ้างอิง / Ref.
              </label>
              <input
                type="text"
                value={refBillNo}
                onChange={(e) => setRefBillNo(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-400 focus:border-blue-400"
              />
            </div>
          </div>

          {/* Buyer Info */}
          <div className="bg-gray-50 rounded-lg p-4 space-y-3">
            <h3 className="text-sm font-bold text-gray-700">
              ข้อมูลผู้ซื้อ / Buyer Information
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  ชื่อ / Name
                </label>
                <input
                  type="text"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-400 focus:border-blue-400"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  ที่อยู่ / Address
                </label>
                <input
                  type="text"
                  value={customerAddress}
                  onChange={(e) => setCustomerAddress(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-400 focus:border-blue-400"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  เลขผู้เสียภาษี / Tax ID
                </label>
                <input
                  type="text"
                  value={customerTaxId}
                  onChange={(e) => setCustomerTaxId(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-400 focus:border-blue-400"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  สาขา / Branch
                </label>
                <input
                  type="text"
                  value={customerBranch}
                  onChange={(e) => setCustomerBranch(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-400 focus:border-blue-400"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  โทร / Phone
                </label>
                <input
                  type="text"
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-400 focus:border-blue-400"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  เงื่อนไข / Terms
                </label>
                <input
                  type="text"
                  value={paymentTerms}
                  onChange={(e) => setPaymentTerms(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-400 focus:border-blue-400"
                />
              </div>
            </div>
          </div>

          {/* Items Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-[#2c3e50] text-white">
                  <th className="px-2 py-2 text-center w-10">#</th>
                  <th className="px-2 py-2 text-left">รายละเอียด</th>
                  <th className="px-2 py-2 text-center w-20">จำนวน</th>
                  <th className="px-2 py-2 text-center w-28">ราคาต่อหน่วย</th>
                  <th className="px-2 py-2 text-right w-28">จำนวนเงิน</th>
                </tr>
              </thead>
              <tbody>
                {filledItems.map((row, idx) => (
                  <tr
                    key={idx}
                    className={
                      idx % 2 === 1
                        ? 'bg-gray-50 border-t border-gray-100'
                        : 'border-t border-gray-100'
                    }
                  >
                    <td className="px-2 py-1 text-center text-gray-400 text-xs">
                      {row.description || row.quantity > 0 ? idx + 1 : ''}
                    </td>
                    <td className="px-1 py-1">
                      <input
                        type="text"
                        value={row.description}
                        onChange={(e) =>
                          handleItemChange(idx, 'description', e.target.value)
                        }
                        className="w-full border-0 bg-transparent px-1 py-0.5 text-sm focus:ring-1 focus:ring-blue-300 rounded"
                        placeholder={idx === 0 ? 'ชื่อสินค้า/บริการ' : ''}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <input
                        type="number"
                        value={row.quantity || ''}
                        onChange={(e) =>
                          handleItemChange(idx, 'quantity', e.target.value)
                        }
                        className="w-full border-0 bg-transparent px-1 py-0.5 text-sm text-center focus:ring-1 focus:ring-blue-300 rounded [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      />
                    </td>
                    <td className="px-1 py-1">
                      <input
                        type="number"
                        value={row.unitPrice || ''}
                        onChange={(e) =>
                          handleItemChange(idx, 'unitPrice', e.target.value)
                        }
                        step="0.01"
                        className="w-full border-0 bg-transparent px-1 py-0.5 text-sm text-right focus:ring-1 focus:ring-blue-300 rounded [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      />
                    </td>
                    <td className="px-2 py-1 text-right text-sm font-medium">
                      {row.amount > 0
                        ? row.amount.toLocaleString('en-US', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })
                        : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Summary */}
          <div className="flex justify-end">
            <div className="w-72 space-y-1">
              <div className="flex justify-between text-sm py-1 border-b border-gray-100">
                <span className="text-gray-600">รวมเป็นเงิน / Subtotal</span>
                <span className="font-medium">
                  {subtotal.toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}{' '}
                  บาท
                </span>
              </div>
              <div className="flex justify-between text-sm py-1 border-b border-gray-100">
                <span className="text-gray-600">
                  ภาษีมูลค่าเพิ่ม {VAT_RATE}%
                </span>
                <span className="font-medium">
                  {vatAmount.toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}{' '}
                  บาท
                </span>
              </div>
              <div className="flex justify-between text-sm py-2 bg-[#2c3e50] text-white rounded-lg px-3 mt-1">
                <span className="font-bold">จำนวนเงินรวมทั้งสิ้น</span>
                <span className="font-bold">
                  {grandTotal.toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}{' '}
                  บาท
                </span>
              </div>
            </div>
          </div>
        </div>
        )}
      </div>
    </Modal>
  )
}
