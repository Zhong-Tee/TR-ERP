import { useAuthContext } from '../../contexts/AuthContext'
import { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import { pdf, PDFViewer } from '@react-pdf/renderer'
import { supabase } from '../../lib/supabase'
import Modal from '../ui/Modal'
import TaxInvoicePDF from './pdf/TaxInvoicePDF'
import type { TaxInvoiceItem } from './pdf/TaxInvoicePDF'
import type { BillHeaderSetting } from '../../types'

/* ─── Channels that use channel_order_no as REF DOC ─── */
const MARKETPLACE_CHANNELS = ['SPTR', 'FSPTR', 'TTTR', 'LZTR', 'WY', 'PGTR']

/* ─── Types ─── */
interface TaxInvoiceOrder {
  id: string
  bill_no: string
  customer_name: string
  total_amount: number
  shipping_cost?: number | null
  discount?: number | null
  channel_code?: string | null
  channel_order_no?: string | null
  billing_details?: {
    tax_customer_name?: string | null
    tax_customer_address?: string | null
    tax_customer_phone?: string | null
    vat_rate?: number
    tax_branch?: string | null
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
  onConfirm: (order: TaxInvoiceOrder) => void
  submitting?: boolean
  hideConfirm?: boolean
  receiverAccount?: string | null
}

const TOTAL_ROWS = 10

const TH_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม']

function formatDateThaiBE(isoDate: string): string {
  const [yStr, mStr, dStr] = isoDate.split('-')
  const y = parseInt(yStr, 10)
  const m = parseInt(mStr, 10)
  const d = parseInt(dStr, 10)
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d) || m < 1 || m > 12) return isoDate
  return `${d} ${TH_MONTHS[m - 1]} ${y + 543}`
}

function escHtmlCell(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/* ─── Component ─── */
export default function TaxInvoiceModal({
  open,
  order,
  onClose,
  onConfirm,
  submitting,
  hideConfirm,
  receiverAccount,
}: TaxInvoiceModalProps) {
  const [billHeaders, setBillHeaders] = useState<BillHeaderSetting[]>([])
  const [selectedHeaderId, setSelectedHeaderId] = useState<string>('')
  const { user } = useAuthContext()
  const canIssue = user?.role === 'account' || user?.role === 'superadmin'
  const [issued, setIssued] = useState(false)
  const issuedRef=useRef(false)
  const [documentLoading, setDocumentLoading] = useState(true)
  const [documentError, setDocumentError] = useState('')
  const [issuing, setIssuing] = useState(false)
  const [flowReference, setFlowReference] = useState('')
  const [flowSaveMessage, setFlowSaveMessage] = useState('')
  const [flowSaveError, setFlowSaveError] = useState('')
  const [legacyOpen, setLegacyOpen] = useState(false)
  const [legacyNumber, setLegacyNumber] = useState('')
  const [legacyError, setLegacyError] = useState('')
  const isLegacy = !!(order?.billing_details as Record<string, unknown> | null)?.account_confirmed_tax
  const [seriesOpen,setSeriesOpen] = useState(false)
  const [seriesLast,setSeriesLast] = useState('')
  const [seriesReason,setSeriesReason] = useState('')
  const [savedCompany, setSavedCompany] = useState<BillHeaderSetting | null>(null)
  const [savedAmounts, setSavedAmounts] = useState<{ shippingCost: number; subtotal: number; netAmount: number; vatAmount: number; grandTotal: number; refDocNo: string; vatRate?: number } | null>(null)
  const [invoiceNo, setInvoiceNo] = useState('')
  const [invoiceDate, setInvoiceDate] = useState(() => new Date(Date.now()+7*60*60*1000).toISOString().split('T')[0])
  const [customerName, setCustomerName] = useState('')
  const [customerAddress, setCustomerAddress] = useState('')
  const [customerTaxId, setCustomerTaxId] = useState('')
  const [customerBranch, setCustomerBranch] = useState('สำนักงานใหญ่')
  const [customerPhone, setCustomerPhone] = useState('')
  const [refBillNo, setRefBillNo] = useState('')
  const [discount, setDiscount] = useState(0)
  const [items, setItems] = useState<TaxInvoiceItem[]>([])
  const [exporting, setExporting] = useState(false)
  const [buyerCopied, setBuyerCopied] = useState(false)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  /* Load bill headers from DB */
  useEffect(() => {
    if (!open) return
    let active=true
    ;(async () => {
      const { data } = await supabase
        .from('bill_header_settings')
        .select('*')
        .order('created_at', { ascending: true })
      const headers = (data || []) as BillHeaderSetting[]
      if(!active) return
      setBillHeaders(headers)
      if(issuedRef.current) return

      // Auto-select header from receiver bank account
      if (receiverAccount && headers.length > 0) {
        const { data: bankMatch } = await supabase
          .from('bank_settings')
          .select('bill_header_id')
          .eq('account_number', receiverAccount)
          .not('bill_header_id', 'is', null)
          .limit(1)
        if (bankMatch && bankMatch.length > 0 && bankMatch[0].bill_header_id) {
          setSelectedHeaderId(bankMatch[0].bill_header_id)
          return
        }
      }
      // Fallback: select first header
      if (headers.length > 0) {
        setSelectedHeaderId(headers[0].id)
      }
    })()
    return ()=>{active=false}
  }, [open, receiverAccount, order?.id])

  useEffect(() => {
    if (!open) setBuyerCopied(false)
  }, [open])

  /* Pre-fill data from order */
  useEffect(() => {
    if (!order) return
    const bd = order.billing_details || {}
    setRefBillNo(order.bill_no || '')
    setCustomerName(bd.tax_customer_name || order.customer_name || '')
    setCustomerTaxId(bd.tax_id || '')
    setCustomerBranch(!bd.tax_branch || bd.tax_branch === '00000' ? 'สำนักงานใหญ่' : `สาขา ${bd.tax_branch}`)
    setCustomerPhone(bd.tax_customer_phone || bd.mobile_phone || '')
    setDiscount(Number(order.discount) || 0)

    setInvoiceNo('ระบบจะรันเลขเมื่อยืนยัน')

    // Preserve the approved address verbatim: issuance/recovery compares the
    // snapshot with the stored buyer data, including legacy spaces/newlines.
    const taxAddr = bd.tax_customer_address || ''
    if (taxAddr.trim()) {
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
          unitPrice: Math.max(0,Number(order.total_amount || 0) + Number(order.discount || 0) - Number(order.shipping_cost || 0)),
          amount: Math.max(0,Number(order.total_amount || 0) + Number(order.discount || 0) - Number(order.shipping_cost || 0)),
        },
      ])
    }
  }, [order])

  const selectedHeader = billHeaders.find(h => h.id === selectedHeaderId) || null

  useEffect(() => {
    if (!open || !order) return
    let active = true
    issuedRef.current=false
    setLegacyOpen(false); setLegacyNumber(''); setLegacyError('');
    setFlowSaveMessage(''); setFlowSaveError('');
    setDocumentLoading(true); setDocumentError(''); setIssued(false); setSavedCompany(null); setSavedAmounts(null); setFlowReference('')
    supabase.from('or_tax_invoices').select('*').eq('order_id',order.id).maybeSingle().then(({data,error}) => {
      if(!active) return
      if(error) { setDocumentError('โหลดทะเบียนใบกำกับไม่ได้ กรุณาปิดและลองใหม่'); setDocumentLoading(false); return }
      if(data) {
        const v=data.snapshot
        setInvoiceNo(data.invoice_no); setInvoiceDate(data.invoice_date); setSelectedHeaderId(data.header_id)
        setCustomerName(v.customerName); setCustomerAddress(v.customerAddress); setCustomerTaxId(v.customerTaxId)
        setCustomerBranch(v.customerBranch); setCustomerPhone(v.customerPhone); setItems(v.items); setDiscount(v.discount)
        setSavedCompany(v.companyData); setSavedAmounts(v); setFlowReference(data.flow_account_reference || ''); issuedRef.current=true; setIssued(true)
      } else if ((order.billing_details as Record<string, unknown> | null)?.account_confirmed_tax) {
        setDocumentError('เอกสารเก่ายังไม่มีเลขในทะเบียนใหม่ ต้องตรวจเลขที่เคยใช้ก่อน ห้ามออกเลขใหม่ทับ')
      }
      setDocumentLoading(false)
    })
    return () => { active=false }
  },[open,order])

  const filledItems: TaxInvoiceItem[] = (() => {
    const arr = [...items]
    while (arr.length < TOTAL_ROWS) {
      arr.push({ description: '', quantity: 0, unitPrice: 0, amount: 0 })
    }
    return arr
  })()

  const shippingCost = savedAmounts?.shippingCost ?? Number(order?.shipping_cost || 0)
  const subtotal = savedAmounts?.subtotal ?? filledItems.reduce((s, r) => s + (r.amount || 0), 0)
  const afterDiscount = subtotal - discount
  const grandTotal = savedAmounts?.grandTotal ?? afterDiscount + shippingCost
  const vatRate = savedAmounts?.vatRate ?? order?.billing_details?.vat_rate ?? 7
  const netAmount = savedAmounts?.netAmount ?? Math.round((grandTotal / (1 + vatRate / 100)) * 100) / 100
  const vatAmount = savedAmounts?.vatAmount ?? Math.round((grandTotal - netAmount) * 100) / 100

  /* REF DOC NO logic based on channel */
  const refDocNo = (() => {
    if (savedAmounts) return savedAmounts.refDocNo
    if (!order) return ''
    const ch = (order.channel_code || '').toUpperCase()
    if (MARKETPLACE_CHANNELS.includes(ch)) {
      return order.channel_order_no || order.bill_no || ''
    }
    return order.customer_name || order.bill_no || ''
  })()

  function handleItemChange(idx: number, field: keyof TaxInvoiceItem, value: string) {
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

  const buildPdfElement = useCallback(() => {
    const fallbackHeader: BillHeaderSetting = {
      id: '', company_key: 'tr', bill_code: 'TR', company_name: 'ห้างหุ้นส่วนจำกัด ทีอาร์ คิดส์ช็อป',
      company_name_en: 'TR Kidsshop Limited Partnership',
      address: '1641,1643 ชั้นที่ 3 ถนนเพชรเกษม แขวงหลักสอง เขตบางแค กรุงเทพมหานคร 10160',
      tax_id: '0103563005345', branch: 'สำนักงานใหญ่', phone: '082-934-1288',
      logo_url: null, created_at: '', updated_at: '',
    }
    return (
      <TaxInvoicePDF
        companyData={savedCompany || selectedHeader || fallbackHeader}
        invoiceNo={invoiceNo}
        invoiceDate={invoiceDate}
        orderNo={order?.bill_no || undefined}
        customerName={customerName}
        customerAddress={customerAddress}
        customerTaxId={customerTaxId}
        customerBranch={customerBranch || undefined}
        customerPhone={customerPhone || undefined}
        items={filledItems.filter(r => r.description && r.quantity > 0)}
        discount={discount}
        shippingCost={shippingCost}
        subtotal={subtotal}
        netAmount={netAmount}
        vatRate={vatRate}
        vatAmount={vatAmount}
        grandTotal={grandTotal}
        refDocNo={refDocNo || undefined}
        refDocDate={invoiceDate}
        isCopy={false}
      />
    )
  }, [order?.bill_no, savedCompany, selectedHeader, invoiceNo, invoiceDate, customerName, customerAddress, customerTaxId, customerBranch, customerPhone, filledItems, discount, shippingCost, subtotal, netAmount, vatAmount, grandTotal, refDocNo, vatRate])

  const pdfDocument = useMemo(() => buildPdfElement(), [buildPdfElement])

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
    } catch (err: unknown) {
      console.error('Error generating Tax Invoice PDF:', err)
      const msg = err instanceof Error ? err.message : String(err)
      setDocumentError('เกิดข้อผิดพลาดในการสร้าง PDF: ' + msg)
    } finally {
      setExporting(false)
    }
  }

  async function handleConfirm() {
    if (!order || !canIssue || documentLoading || documentError) return
    setIssuing(true)
    try {
      const snapshot = {customerName,customerAddress,customerTaxId,customerBranch,customerPhone,items:filledItems.filter(r=>r.description&&r.quantity>0),discount,shippingCost,subtotal,netAmount,vatAmount,grandTotal,refDocNo,vatRate}
      const {data,error}=await supabase.rpc('or_issue_tax_invoice',{p_order_id:order.id,p_header_id:selectedHeaderId,p_date:invoiceDate,p_snapshot:snapshot,p_flow_reference:flowReference})
      if(error) throw error
      setInvoiceNo(data.invoice_no); issuedRef.current=true; setIssued(true); setSavedCompany(data.snapshot.companyData); setSavedAmounts(data.snapshot)
      onConfirm(order)
    } catch(e) {setDocumentError((e as {message?:string})?.message || 'ออกเอกสารไม่สำเร็จ')}
    finally{setIssuing(false)}
  }
  async function recoverLegacyInvoice() {
    if (!order || !canIssue || !isLegacy || issued || issuing) return
    setLegacyError('')
    if (!legacyNumber.trim() || !selectedHeaderId || !invoiceDate) {
      setLegacyError('กรุณากรอกเลขใบกำกับเดิม บริษัท และวันที่ออกเอกสาร')
      return
    }
    setIssuing(true)
    try {
      const snapshot = {customerName,customerAddress,customerTaxId,customerBranch,customerPhone,items:filledItems.filter(r=>r.description&&r.quantity>0),discount,shippingCost,subtotal,netAmount,vatAmount,grandTotal,refDocNo,vatRate}
      const {data,error} = await supabase.rpc('or_tax_recover_legacy_invoice', {
        p_order_id:order.id, p_header_id:selectedHeaderId, p_date:invoiceDate,
        p_invoice_no:legacyNumber.trim(), p_snapshot:snapshot, p_flow_reference:flowReference,
      })
      if (error) throw error
      setInvoiceNo(data.invoice_no); setInvoiceDate(data.invoice_date)
      issuedRef.current=true; setIssued(true)
      setSavedCompany(data.snapshot.companyData); setSavedAmounts(data.snapshot)
      setDocumentError(''); setLegacyOpen(false)
      onConfirm(order)
    } catch (error) {
      setLegacyError((error as {message?:string})?.message || 'บันทึกเลขใบกำกับเดิมไม่สำเร็จ')
    } finally { setIssuing(false) }
  }

  async function initializeSeries() {
    if(!order || !selectedHeaderId || !/^\d+$/.test(seriesLast) || !seriesReason.trim()) return
    setIssuing(true)
    const {error}=await supabase.rpc('or_tax_initialize_series',{p_order_id:order.id,p_header_id:selectedHeaderId,p_period:invoiceDate.slice(2,4)+invoiceDate.slice(5,7),p_last_number:Number(seriesLast),p_reason:seriesReason})
    setDocumentError(error?.message || '');setIssuing(false)
    if(!error) setSeriesOpen(false)
  }
  async function saveFlowReference() {
    if(!order || !issued || !canIssue || issuing) return
    setIssuing(true)
    setFlowSaveMessage(''); setFlowSaveError('')
    const reference=flowReference.trim()
    try {
      const {error}=await supabase.rpc('or_tax_flow_reference',{p_order_id:order.id,p_reference:reference})
      if(error) throw error
      const {data,error:readError}=await supabase.from('or_tax_invoices').select('flow_account_reference').eq('order_id',order.id).maybeSingle()
      if(readError) throw readError
      if(!data || data.flow_account_reference!==reference) throw new Error('ยังยืนยันเลขอ้างอิงที่บันทึกไม่ได้ กรุณาปิดแล้วเปิดเอกสารตรวจสอบอีกครั้ง')
      setFlowReference(data.flow_account_reference)
      setFlowSaveMessage(reference ? `บันทึกเลขอ้างอิงเรียบร้อย: ${reference}` : 'ล้างเลขอ้างอิงเรียบร้อย')
    } catch(error) {
      setFlowSaveError((error as {message?:string})?.message || 'บันทึกเลขอ้างอิงไม่สำเร็จ กรุณาตรวจการเชื่อมต่อแล้วลองใหม่')
    } finally {
      setIssuing(false)
    }
  }

  async function copyFullInvoiceForExcel() {
    const sellerName = (selectedHeader?.company_name || '').trim()
    const dateTh = formatDateThaiBE(invoiceDate)

    const metaRows: [string, string][] = [
      ...(sellerName ? ([['บริษัท (ผู้ขาย)', sellerName]] as [string, string][]) : []),
      ['เลขที่ / No.', invoiceNo.trim()],
      ['วันที่ / Date', dateTh],
      ['เลขที่อ้างอิง / Ref.', refBillNo.trim()],
      ['REF DOC (อัตโนมัติ)', refDocNo.trim()],
      ['ชื่อ / Name', customerName.trim()],
      ['ที่อยู่ / Address', customerAddress.trim()],
      ['เลขผู้เสียภาษี / Tax ID', customerTaxId.trim()],
      ['สาขา / Branch', customerBranch.trim()],
      ['โทร / Phone', customerPhone.trim()],
      ['ส่วนลด / Discount', discount > 0 ? Number(discount).toFixed(2) : ''],
    ]

    const nonEmptyRows = filledItems.filter((r) => {
      const desc = (r.description || '').trim()
      return desc !== '' || (r.quantity || 0) > 0 || (r.unitPrice || 0) > 0 || (r.amount || 0) > 0
    })

    const itemHeaders = ['ลำดับ', 'รายการ', 'ราคาต่อหน่วย', 'จำนวน', 'จำนวนเงิน']
    const itemRows = nonEmptyRows.map((r, i) => {
      const unit = Number(r.unitPrice || 0)
      const qty = Number(r.quantity || 0)
      const amt = Number(r.amount || 0)
      return [
        String(i + 1),
        (r.description || '').trim(),
        unit ? unit.toFixed(2) : '',
        qty ? String(qty) : '',
        amt ? amt.toFixed(2) : '',
      ]
    })

    const summaryRows: [string, string][] = [
      ['รวมเป็นเงิน / Amount', Number(subtotal || 0).toFixed(2)],
      ...(shippingCost > 0 ? ([['ค่าขนส่ง / Shipping', Number(shippingCost).toFixed(2)]] as [string, string][]) : []),
      ['มูลค่าสินค้าที่นำมาคิดภาษี', Number(netAmount || 0).toFixed(2)],
      [`ภาษีมูลค่าเพิ่ม ${vatRate}%`, Number(vatAmount || 0).toFixed(2)],
      ['รวมจำนวนเงิน / TOTAL', Number(grandTotal || 0).toFixed(2)],
    ]

    const tsvMeta = [['หัวข้อ', 'ค่า'], ...metaRows].map((cols) => cols.join('\t')).join('\r\n')
    const tsvItems = [itemHeaders, ...itemRows].map((cols) => cols.join('\t')).join('\r\n')
    const tsvSummary = [['รายการสรุป', 'จำนวนเงิน'], ...summaryRows].map((cols) => cols.join('\t')).join('\r\n')
    const text = `${tsvMeta}\r\n\r\n${tsvItems}\r\n\r\n${tsvSummary}\r\n`

    const htmlMeta =
      `<table><thead><tr><th>${escHtmlCell('หัวข้อ')}</th><th>${escHtmlCell('ค่า')}</th></tr></thead>` +
      `<tbody>${metaRows.map(([k, v]) => `<tr><td>${escHtmlCell(k)}</td><td>${escHtmlCell(v)}</td></tr>`).join('')}</tbody></table>`

    const htmlItems =
      `<table><thead><tr>${itemHeaders.map((h) => `<th>${escHtmlCell(h)}</th>`).join('')}</tr></thead>` +
      `<tbody>${itemRows
        .map((r) => `<tr>${r.map((c) => `<td>${escHtmlCell(String(c ?? ''))}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`

    const htmlSummary =
      `<table><thead><tr><th>${escHtmlCell('รายการสรุป')}</th><th>${escHtmlCell('จำนวนเงิน')}</th></tr></thead>` +
      `<tbody>${summaryRows
        .map(([k, v]) => `<tr><td>${escHtmlCell(k)}</td><td>${escHtmlCell(v)}</td></tr>`)
        .join('')}</tbody></table>`

    const html = `${htmlMeta}<br/><br/>${htmlItems}<br/><br/>${htmlSummary}`

    try {
      if (typeof (window as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem !== 'undefined' && navigator.clipboard && 'write' in navigator.clipboard) {
        const item = new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        })
        await navigator.clipboard.write([item])
      } else {
        await navigator.clipboard.writeText(text)
      }
      setBuyerCopied(true)
      window.setTimeout(() => setBuyerCopied(false), 2000)
    } catch {
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.left = '-9999px'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        setBuyerCopied(true)
        window.setTimeout(() => setBuyerCopied(false), 2000)
      } catch {
        setDocumentError('ไม่สามารถคัดลอกได้')
      }
    }
  }

  if (!open || !order) return null

  return (
    <Modal
      open={open}
      onClose={onClose}
      contentClassName="max-w-[1200px] w-full"
      closeOnBackdropClick
    >
      <div className="p-4 space-y-4 max-h-[90vh] overflow-y-auto">
        {/* ─── Controls Bar ─── */}
        <div className="flex flex-wrap items-center justify-between gap-3 bg-gray-50 rounded-xl px-4 py-3">
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium text-gray-600">บริษัท:</label>
            <select
              disabled={issued || documentLoading || !canIssue}
              value={selectedHeaderId}
              onChange={(e) => setSelectedHeaderId(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-400"
            >
              {billHeaders.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.company_name}
                </option>
              ))}
              {billHeaders.length === 0 && <option value="">ไม่มีข้อมูลหัวบิล</option>}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleExportPDF}
              disabled={exporting || !issued || documentLoading || !!documentError}
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
            {!hideConfirm && !issued && canIssue && (
              <button
                type="button"
                onClick={handleConfirm}
                disabled={submitting || issuing || documentLoading || !!documentError}
                className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm font-semibold transition-colors disabled:opacity-50 inline-flex items-center gap-2"
              >
                {submitting ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    กำลังยืนยัน...
                  </>
                ) : (
                  'ยืนยันออกเลขใบกำกับ ERP'
                )}
              </button>
            )}
          </div>
        </div>

        {documentLoading && <p role="status">กำลังโหลดเอกสาร…</p>}
        {documentError && <p role="alert" className="rounded bg-red-50 p-3 text-red-700">{documentError}</p>}
        <label className="block">วันที่ออกเอกสาร<input type="date" disabled={issued || issuing || documentLoading || !canIssue} value={invoiceDate} onChange={e=>setInvoiceDate(e.target.value)} className="ml-2 rounded border p-2" /></label>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="tax-flow-reference">เลขอ้างอิงจาก FlowAccount</label>
          <div className="flex min-w-0 items-center gap-2">
            <input id="tax-flow-reference" value={flowReference} disabled={!canIssue || issuing} onChange={e=>{setFlowReference(e.target.value);setFlowSaveMessage('');setFlowSaveError('')}} className="min-w-0 w-48 rounded border p-2" />
            {issued && canIssue && <button type="button" disabled={issuing} onClick={()=>void saveFlowReference()} className="shrink-0 whitespace-nowrap rounded-lg bg-blue-600 px-4 py-2 font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50">{issuing?'กำลังบันทึก…':'บันทึกเลขอ้างอิง'}</button>}
          </div>
        </div>
        {issued && canIssue && <div className="space-y-2">
          {flowSaveMessage&&<p role="status" className="rounded bg-emerald-50 p-3 text-emerald-700">{flowSaveMessage}</p>}
          {flowSaveError&&<p role="alert" className="rounded bg-red-50 p-3 text-red-700">{flowSaveError}</p>}
        </div>}
        {!issued && !isLegacy && <p className="text-sm text-amber-800">ตัวอย่างก่อนออกเอกสาร — ระบบจะรันเลขจริงเมื่อยืนยัน</p>}
        {isLegacy && !issued && canIssue && !documentLoading && <button type="button" disabled={issuing} onClick={()=>{setLegacyError('');setLegacyOpen(true)}} className="mr-4 mb-2 rounded bg-blue-600 px-4 py-2 text-white">บันทึกเลขใบกำกับเดิม</button>}
        <Modal open={legacyOpen} stackClassName="z-[60]" onClose={()=>{if(!issuing)setLegacyOpen(false)}} contentClassName="max-w-xl" ariaLabelledby="legacy-invoice-title" showCloseButton={!issuing}>
          <div className="space-y-4 p-6">
            <h3 id="legacy-invoice-title" className="font-bold">บันทึกเลขใบกำกับเดิม</h3>
            <p>ออเดอร์ {order?.bill_no} · บริษัท {selectedHeader?.company_name} · วันที่ {invoiceDate}</p>
            <p className="text-sm text-amber-800">ใช้เลขและวันที่ตามเอกสารเดิม ตรวจข้อมูลผู้ซื้อและยอดเงินให้ตรงก่อนบันทึก ระบบจะไม่ออกเลขใหม่และไม่เปลี่ยนเลขล่าสุดสำหรับเอกสารใหม่</p>
            <label className="block">เลขใบกำกับเดิมเต็มเลข<input autoFocus value={legacyNumber} disabled={issuing} onChange={e=>setLegacyNumber(e.target.value)} className="mt-1 w-full rounded border p-2" /></label>
            <p className="text-sm">เลขอ้างอิง FlowAccount: {flowReference || '—'} · แก้บริษัท วันที่ และเลขอ้างอิงได้ที่หน้าข้อมูลใบกำกับก่อนเปิดหน้าต่างนี้</p>
            {legacyError && <p role="alert" className="text-red-700">{legacyError}</p>}
            <button type="button" disabled={issuing || !legacyNumber.trim()} onClick={()=>void recoverLegacyInvoice()} className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50">{issuing ? 'กำลังตรวจสอบและบันทึก…' : 'ยืนยันบันทึกเลขเดิม'}</button>
          </div>
        </Modal>
        {!issued && canIssue && <button type="button" disabled={issuing || documentLoading} onClick={()=>{setSeriesLast('');setSeriesReason('');setSeriesOpen(true)}} className="text-sm text-blue-700 underline">ยืนยันเลขล่าสุดจากทะเบียนเดิม</button>}
        <Modal open={seriesOpen} stackClassName="z-[60]" onClose={()=>{if(!issuing)setSeriesOpen(false)}} contentClassName="max-w-lg"><div className="space-y-3 p-5"><h3 className="font-bold">ยืนยันเลขล่าสุดจากทะเบียนเดิม</h3><p>บริษัท {selectedHeader?.company_name} · เดือน {invoiceDate.slice(0,7)} — ตรวจเลขเอกสารที่เคยใช้จริงก่อนบันทึก ระบบจะออกเลขถัดไปและไม่เปลี่ยนเอกสารเก่า</p><label className="block">ลำดับล่าสุดที่ใช้แล้ว (0 หากยังไม่เคยใช้)<input type="number" min={0} max={9999} value={seriesLast} onChange={e=>setSeriesLast(e.target.value)} className="w-full rounded border p-2" /></label><label className="block">ที่มาหรือเหตุผลที่ตรวจสอบ<textarea value={seriesReason} onChange={e=>setSeriesReason(e.target.value)} className="w-full rounded border p-2" /></label><button type="button" disabled={issuing || !seriesReason.trim() || !/^\d+$/.test(seriesLast)} onClick={()=>void initializeSeries()} className="rounded bg-blue-600 px-4 py-2 text-white">ยืนยันเลขล่าสุด</button>{documentError&&<p className="text-red-700">{documentError}</p>}</div></Modal>
        {/* ─── Mode Toggle ─── */}
        <div className="flex rounded-lg bg-gray-100 p-0.5">
          <button type="button" onClick={() => setMode('edit')} className={`flex-1 py-2 text-sm font-medium rounded-md transition-colors ${mode === 'edit' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>ข้อมูลใบกำกับ</button>
          <button type="button" onClick={() => setMode('preview')} className={`flex-1 py-2 text-sm font-medium rounded-md transition-colors ${mode === 'preview' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>พรีวิว PDF</button>
        </div>

        {/* ─── Preview Mode ─── */}
        {mode === 'preview' && (
          <div className="bg-[#525659] rounded-xl p-3 flex justify-center">
            <PDFViewer
              width={595}
              height={842}
              showToolbar={false}
              style={{ border: 'none', borderRadius: '8px', backgroundColor: '#fff' }}
            >
              {pdfDocument}
            </PDFViewer>
          </div>
        )}

        {/* ─── Edit Mode ─── */}
        {mode === 'edit' && (
        <fieldset disabled className="bg-white border border-gray-200 rounded-xl p-5 space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-bold text-gray-800">ใบเสร็จรับเงิน/ใบกำกับภาษี</h2>
            <span className="text-sm text-blue-600 font-semibold bg-blue-50 px-3 py-1 rounded-full">
              ต้นฉบับ / ORIGINAL
            </span>
          </div>

          {/* Document Info */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">เลขที่ / No.</label>
              <input type="text" value={invoiceNo} readOnly className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-400 focus:border-blue-400" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">วันที่ / Date</label>
              <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-400 focus:border-blue-400" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">เลขที่อ้างอิง / Ref.</label>
              <input type="text" value={refBillNo} onChange={(e) => setRefBillNo(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-400 focus:border-blue-400" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">REF DOC (อัตโนมัติ)</label>
              <input type="text" value={refDocNo} readOnly className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-gray-50 text-gray-600" />
            </div>
          </div>

          {/* Buyer Info */}
          <div className="bg-gray-50 rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-gray-700">ข้อมูลผู้ซื้อ / Buyer Information</h3>
              <button
                type="button"
                onClick={copyFullInvoiceForExcel}
                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 hover:border-gray-400 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                {buyerCopied ? 'คัดลอกแล้ว' : 'คัดลอก'}
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-gray-500 mb-1">ชื่อ / Name</label>
                <input type="text" value={customerName} onChange={(e) => setCustomerName(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-400 focus:border-blue-400" />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-gray-500 mb-1">ที่อยู่ / Address</label>
                <input type="text" value={customerAddress} onChange={(e) => setCustomerAddress(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-400 focus:border-blue-400" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">เลขผู้เสียภาษี / Tax ID</label>
                <input type="text" value={customerTaxId} onChange={(e) => setCustomerTaxId(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-400 focus:border-blue-400" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">สาขา / Branch</label>
                <input type="text" value={customerBranch} onChange={(e) => setCustomerBranch(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-400 focus:border-blue-400" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">โทร / Phone</label>
                <input type="text" value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-400 focus:border-blue-400" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">ส่วนลด / Discount</label>
                <input type="number" value={discount || ''} onChange={(e) => setDiscount(parseFloat(e.target.value) || 0)} step="0.01" className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-400 focus:border-blue-400 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
              </div>
            </div>
          </div>

          {/* Items Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-[#2980b9] text-white">
                  <th className="px-2 py-2 text-center w-10">#</th>
                  <th className="px-2 py-2 text-left">รายการ</th>
                  <th className="px-2 py-2 text-center w-28">ราคาต่อหน่วย</th>
                  <th className="px-2 py-2 text-center w-20">จำนวน</th>
                  <th className="px-2 py-2 text-right w-28">จำนวนเงิน</th>
                </tr>
              </thead>
              <tbody>
                {filledItems.map((row, idx) => (
                  <tr key={idx} className={idx % 2 === 1 ? 'bg-gray-50 border-t border-gray-100' : 'border-t border-gray-100'}>
                    <td className="px-2 py-1 text-center text-gray-400 text-xs">
                      {row.description || row.quantity > 0 ? idx + 1 : ''}
                    </td>
                    <td className="px-1 py-1">
                      <input type="text" value={row.description} onChange={(e) => handleItemChange(idx, 'description', e.target.value)} className="w-full border-0 bg-transparent px-1 py-0.5 text-sm focus:ring-1 focus:ring-blue-300 rounded" placeholder={idx === 0 ? 'ชื่อสินค้า/บริการ' : ''} />
                    </td>
                    <td className="px-1 py-1">
                      <input type="number" value={row.unitPrice || ''} onChange={(e) => handleItemChange(idx, 'unitPrice', e.target.value)} step="0.01" className="w-full border-0 bg-transparent px-1 py-0.5 text-sm text-right focus:ring-1 focus:ring-blue-300 rounded [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
                    </td>
                    <td className="px-1 py-1">
                      <input type="number" value={row.quantity || ''} onChange={(e) => handleItemChange(idx, 'quantity', e.target.value)} className="w-full border-0 bg-transparent px-1 py-0.5 text-sm text-center focus:ring-1 focus:ring-blue-300 rounded [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
                    </td>
                    <td className="px-2 py-1 text-right text-sm font-medium">
                      {row.amount > 0 ? row.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Summary */}
          <div className="flex justify-end">
            <div className="w-72 space-y-1">
              {discount > 0 && (
                <div className="flex justify-between text-sm py-1 border-b border-gray-100">
                  <span className="text-gray-600">ส่วนลด / Discount</span>
                  <span className="font-medium text-red-600">-{discount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
              )}
              <div className="flex justify-between text-sm py-1 border-b border-gray-100">
                <span className="text-gray-600">รวมเป็นเงิน / Amount</span>
                <span className="font-medium">{subtotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท</span>
              </div>
              {shippingCost > 0 && (
                <div className="flex justify-between text-sm py-1 border-b border-gray-100">
                  <span className="text-gray-600">ค่าขนส่ง / Shipping</span>
                  <span className="font-medium">{shippingCost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท</span>
                </div>
              )}
              <div className="flex justify-between text-sm py-1 border-b border-gray-100">
                <span className="text-gray-600">มูลค่าสินค้าที่นำมาคิดภาษี</span>
                <span className="font-medium">{netAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท</span>
              </div>
              <div className="flex justify-between text-sm py-1 border-b border-gray-100">
                <span className="text-gray-600">ภาษีมูลค่าเพิ่ม {vatRate}%</span>
                <span className="font-medium">{vatAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท</span>
              </div>
              <div className="flex justify-between text-sm py-2 bg-[#2980b9] text-white rounded-lg px-3 mt-1">
                <span className="font-bold">รวมจำนวนเงิน / TOTAL</span>
                <span className="font-bold">{grandTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท</span>
              </div>
            </div>
          </div>
        </fieldset>
        )}
      </div>
    </Modal>
  )
}
