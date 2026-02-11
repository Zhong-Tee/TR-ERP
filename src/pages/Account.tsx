import { useState, useEffect, useMemo, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { Refund, Order } from '../types'
import { formatDateTime } from '../lib/utils'
import { useAuthContext } from '../contexts/AuthContext'
import { getEasySlipQuota } from '../lib/slipVerification'
import Modal from '../components/ui/Modal'
import BillEditSection from '../components/account/BillEditSection'
import ManualSlipCheckSection from '../components/account/ManualSlipCheckSection'
import CashBillModal from '../components/account/CashBillModal'
import * as XLSX from 'xlsx'

type AccountSection = 'dashboard' | 'slip-verification' | 'manual-slip-check' | 'bill-edit'
type AccountTab = 'refunds' | 'tax-invoice' | 'cash-bill' | 'approvals'
type ApprovalFilter = 'refund' | 'tax-invoice' | 'cash-bill'

type VerifiedSlipRow = {
  id: string
  order_id: string
  verified_amount: number
  verified_at: string | null
  easyslip_date: string | null
  easyslip_response: Record<string, unknown> | null
  easyslip_receiver_account: string | null
  validation_status: string | null
  validation_errors: string[] | null
  expected_amount: number | null
  is_deleted: boolean | null
  deletion_reason: string | null
  or_orders: { channel_code: string | null; admin_user: string | null } | null
}

type BillingRequestOrder = {
  id: string
  bill_no: string
  customer_name: string
  total_amount: number
  status: string
  created_at: string
  billing_details: any
}

/** ดึงชื่อบัญชีผู้โอนจาก easyslip_response (data.sender.account.name.th / .en) */
function getPayerName(res: Record<string, unknown> | null): string {
  if (!res?.data || typeof res.data !== 'object') return '–'
  const d = res.data as Record<string, unknown>
  const sender = d.sender as Record<string, unknown> | undefined
  const acc = sender?.account as Record<string, unknown> | undefined
  const nameObj = acc?.name as Record<string, string> | undefined
  if (nameObj?.th && typeof nameObj.th === 'string') return nameObj.th
  if (nameObj?.en && typeof nameObj.en === 'string') return nameObj.en
  if (sender?.name && typeof sender.name === 'string') return sender.name
  const from = d.from as Record<string, unknown> | undefined
  const fromAcc = from?.account as Record<string, unknown> | undefined
  if (fromAcc?.name && typeof fromAcc.name === 'string') return fromAcc.name
  if (from?.name && typeof from.name === 'string') return from.name
  return '–'
}

/** ดึงเลขบัญชีผู้โอนจาก easyslip_response (data.sender.account.bank.account) */
function getPayerAccountNumber(res: Record<string, unknown> | null): string {
  if (!res?.data || typeof res.data !== 'object') return '–'
  const d = res.data as Record<string, unknown>
  const sender = d.sender as Record<string, unknown> | undefined
  const acc = sender?.account as Record<string, unknown> | undefined
  const bank = acc?.bank as Record<string, unknown> | undefined
  if (bank?.account && typeof bank.account === 'string') return bank.account
  return '–'
}

function getReceiverName(res: Record<string, unknown> | null, fallbackAccount: string | null): string {
  if (!res?.data || typeof res.data !== 'object') return fallbackAccount || '–'
  const d = res.data as Record<string, unknown>
  const receiver = d.receiver as Record<string, unknown> | undefined
  const acc = receiver?.account as Record<string, unknown> | undefined
  if (acc?.name && typeof acc.name === 'string') return acc.name
  const bank = acc?.bank as Record<string, unknown> | undefined
  if (bank?.account && typeof bank.account === 'string') return bank.account
  return fallbackAccount || '–'
}

/** คืนค่าสถานะยอดสำหรับแถวสลิป: ซ้ำ, โอนเกิน, ยอดไม่พอ (หลายค่าแยกด้วย comma) */
function getTagLogic(row: VerifiedSlipRow): string {
  const tags: string[] = []
  const errs = row.validation_errors
  if (errs && Array.isArray(errs) && errs.some((e: string) => e.includes('สลิปซ้ำ') || e.includes('ซ้ำ'))) {
    tags.push('ซ้ำ')
  }
  const expected = row.expected_amount != null ? Number(row.expected_amount) : null
  const verified = Number(row.verified_amount)
  if (expected != null) {
    if (verified > expected) tags.push('โอนเกิน')
    else if (verified < expected) tags.push('ยอดไม่พอ')
  }
  return tags.length > 0 ? tags.join(', ') : '–'
}

export default function Account() {
  const { user } = useAuthContext()
  const [accountSection, setAccountSection] = useState<AccountSection>('dashboard')
  const [activeTab, setActiveTab] = useState<AccountTab>('refunds')
  const [refunds, setRefunds] = useState<Refund[]>([])
  const [loading, setLoading] = useState(true)
  const [billingLoading, setBillingLoading] = useState(true)
  const [taxInvoiceOrders, setTaxInvoiceOrders] = useState<BillingRequestOrder[]>([])
  const [cashBillOrders, setCashBillOrders] = useState<BillingRequestOrder[]>([])
  const [easyslipQuotaInfo, setEasyslipQuotaInfo] = useState<{
    usedQuota: number
    maxQuota: number
    remainingQuota: number
    expiredAt: string
    currentCredit: number
  } | null>(null)
  const [quotaLoading, setQuotaLoading] = useState(true)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyTaxInvoices, setHistoryTaxInvoices] = useState<BillingRequestOrder[]>([])
  const [historyCashBills, setHistoryCashBills] = useState<BillingRequestOrder[]>([])
  const [historyRefunds, setHistoryRefunds] = useState<Refund[]>([])
  const [viewOrderId, setViewOrderId] = useState<string | null>(null)
  const [viewOrder, setViewOrder] = useState<(Order & { order_items?: any[] }) | null>(null)
  const [viewOrderLoading, setViewOrderLoading] = useState(false)
  const [approvalFilter, setApprovalFilter] = useState<ApprovalFilter>('refund')
  const [slipPopupOrderId, setSlipPopupOrderId] = useState<string | null>(null)
  const [slipPopupBillNo, setSlipPopupBillNo] = useState<string>('')
  const [slipPopupUrls, setSlipPopupUrls] = useState<string[]>([])
  const [slipPopupLoading, setSlipPopupLoading] = useState(false)
  const [slipPopupFailed, setSlipPopupFailed] = useState<Set<number>>(new Set())
  /** Popup ยืนยัน อนุมัติ/ปฏิเสธ โอนคืน — ใช้ Modal เดียว */
  const [refundActionModal, setRefundActionModal] = useState<{
    open: boolean
    refund: Refund | null
    action: 'approve' | 'reject' | null
    submitting: boolean
  }>({ open: false, refund: null, action: null, submitting: false })
  /** Modal แจ้งผลหลังอนุมัติ/ปฏิเสธโอนคืน (แทน alert) */
  const [refundResultModal, setRefundResultModal] = useState<{ open: boolean; message: string }>({ open: false, message: '' })
  /** Modal ยืนยัน ขอใบกำกับภาษี / ขอบิลเงินสด (แทน confirm) */
  const [billingConfirmModal, setBillingConfirmModal] = useState<{
    open: boolean
    order: BillingRequestOrder | null
    type: 'tax-invoice' | 'cash-bill' | null
    submitting: boolean
  }>({ open: false, order: null, type: null, submitting: false })
  /** Modal แจ้งผลหลังยืนยันใบกำกับภาษี/บิลเงินสด (แทน alert) */
  const [billingResultModal, setBillingResultModal] = useState<{ open: boolean; title: string; message: string }>({ open: false, title: '', message: '' })
  /** Modal เปิดบิลเงินสด */
  const [cashBillModal, setCashBillModal] = useState<{ open: boolean; order: BillingRequestOrder | null; submitting: boolean; viewOnly: boolean }>({ open: false, order: null, submitting: false, viewOnly: false })
  /** รายการตรวจสลิป (เมนู รายการการตรวจสลิป) */
  const [verifiedSlipsList, setVerifiedSlipsList] = useState<VerifiedSlipRow[]>([])
  const [verifiedSlipsLoading, setVerifiedSlipsLoading] = useState(false)
  /** ตัวกรองรายการตรวจสลิป */
  const [slipFilterOrderTaker, setSlipFilterOrderTaker] = useState<string>('')
  const [slipFilterChannel, setSlipFilterChannel] = useState<string>('')
  const [slipFilterDate, setSlipFilterDate] = useState<string>('')

  /** ป้องกันกระพริบ: แสดง spinner เฉพาะครั้งแรกเท่านั้น */
  const initialLoadDone = useRef(false)

  function copyToClipboard(text: string) {
    if (!text) return
    if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch((err) => {
        console.error('Failed to copy text:', err)
      })
    }
  }

  async function fetchOrderForView(orderId: string) {
    setViewOrderLoading(true)
    setViewOrder(null)
    try {
      const { data, error } = await supabase
        .from('or_orders')
        .select('*, or_order_items(*)')
        .eq('id', orderId)
        .single()
      if (error) throw error
      setViewOrder(data as any)
    } catch (e) {
      console.error('Error fetching order:', e)
      setViewOrder(null)
    } finally {
      setViewOrderLoading(false)
    }
  }

  useEffect(() => {
    if (viewOrderId) fetchOrderForView(viewOrderId)
    else setViewOrder(null)
  }, [viewOrderId])

  async function loadVerifiedSlipsList() {
    setVerifiedSlipsLoading(true)
    try {
      const { data: slipsData, error: slipsError } = await supabase
        .from('ac_verified_slips')
        .select('id, order_id, verified_amount, verified_at, easyslip_date, easyslip_response, easyslip_receiver_account, validation_status, validation_errors, expected_amount, is_deleted, deletion_reason')
        .order('created_at', { ascending: false })
        .limit(2000)
      if (slipsError) throw slipsError
      const slips = (slipsData || []) as Omit<VerifiedSlipRow, 'or_orders'>[]
      const orderIds = [...new Set(slips.map((s) => s.order_id).filter(Boolean))]
      const orderMap: Record<string, { channel_code: string | null; admin_user: string | null }> = {}
      if (orderIds.length > 0) {
        const { data: ordersData, error: ordersError } = await supabase
          .from('or_orders')
          .select('id, channel_code, admin_user')
          .in('id', orderIds)
        if (!ordersError && ordersData) {
          ordersData.forEach((o: { id: string; channel_code: string | null; admin_user: string | null }) => {
            orderMap[o.id] = { channel_code: o.channel_code ?? null, admin_user: o.admin_user ?? null }
          })
        }
      }
      const rows: VerifiedSlipRow[] = slips.map((s) => ({
        ...s,
        or_orders: orderMap[s.order_id] ?? null,
      }))
      setVerifiedSlipsList(rows)
    } catch (e) {
      console.error('Error loading verified slips:', e)
      setVerifiedSlipsList([])
    } finally {
      setVerifiedSlipsLoading(false)
    }
  }

  useEffect(() => {
    if (accountSection === 'slip-verification') loadVerifiedSlipsList()
  }, [accountSection])

  /** รายการตรวจสลิปหลังกรอง (ผู้ลงออเดอร์, ช่องทาง, วันที่) */
  const filteredSlipsList = useMemo(() => {
    let list = verifiedSlipsList
    if (slipFilterOrderTaker.trim()) {
      const q = slipFilterOrderTaker.trim().toLowerCase()
      list = list.filter((r) => (r.or_orders?.admin_user ?? '').toLowerCase().includes(q))
    }
    if (slipFilterChannel.trim()) {
      const q = slipFilterChannel.trim().toLowerCase()
      list = list.filter((r) => (r.or_orders?.channel_code ?? '').toLowerCase().includes(q))
    }
    if (slipFilterDate) {
      list = list.filter((r) => {
        const dt = r.easyslip_date || r.verified_at || ''
        if (!dt) return false
        const d = new Date(dt)
        const y = d.getFullYear()
        const m = String(d.getMonth() + 1).padStart(2, '0')
        const day = String(d.getDate()).padStart(2, '0')
        return `${y}-${m}-${day}` === slipFilterDate
      })
    }
    return list
  }, [verifiedSlipsList, slipFilterOrderTaker, slipFilterChannel, slipFilterDate])

  /** ค่าที่ใช้ใน dropdown ตัวกรอง (ผู้ลงออเดอร์, ช่องทาง) */
  const slipFilterOrderTakerOptions = useMemo(() => {
    const set = new Set<string>()
    verifiedSlipsList.forEach((r) => {
      const v = r.or_orders?.admin_user ?? ''
      if (v) set.add(v)
    })
    return Array.from(set).sort()
  }, [verifiedSlipsList])
  const slipFilterChannelOptions = useMemo(() => {
    const set = new Set<string>()
    verifiedSlipsList.forEach((r) => {
      const v = r.or_orders?.channel_code ?? ''
      if (v) set.add(v)
    })
    return Array.from(set).sort()
  }, [verifiedSlipsList])

  async function openSlipPopup(orderId: string, billNo: string) {
    setSlipPopupOrderId(orderId)
    setSlipPopupBillNo(billNo)
    setSlipPopupUrls([])
    setSlipPopupFailed(new Set())
    setSlipPopupLoading(true)
    try {
      const { data, error } = await supabase
        .from('ac_verified_slips')
        .select('slip_image_url, slip_storage_path')
        .eq('order_id', orderId)
        .or('is_deleted.is.null,is_deleted.eq.false')
        .order('created_at', { ascending: true })
      if (error) throw error
      const rows = (data || []) as { slip_image_url?: string; slip_storage_path?: string | null }[]
      const urls: string[] = []
      for (const r of rows) {
        if (r.slip_storage_path) {
          const raw = r.slip_storage_path
          const parts = raw.split('/')
          const bucket = parts[0] || 'slip-images'
          const filePath = parts.slice(1).join('/')
          let signedUrl: string | null = null
          const { data: signed, error: signErr } = await supabase.storage
            .from(bucket)
            .createSignedUrl(filePath, 3600)
          if (!signErr && signed?.signedUrl) signedUrl = signed.signedUrl
          if (!signedUrl && raw) {
            const retry = await supabase.storage
              .from('slip-images')
              .createSignedUrl(parts.length > 1 ? filePath : raw, 3600)
            if (!retry.error && retry.data?.signedUrl) signedUrl = retry.data.signedUrl
          }
          if (signedUrl) {
            urls.push(signedUrl)
            continue
          }
          if (signErr) console.warn('Slip signed URL failed:', raw, signErr)
        }
        if (r.slip_image_url) urls.push(r.slip_image_url)
      }
      setSlipPopupUrls(urls)
    } catch (e) {
      console.error('Error fetching slip images:', e)
      setSlipPopupUrls([])
    } finally {
      setSlipPopupLoading(false)
    }
  }

  useEffect(() => {
    Promise.all([
      loadRefunds(),
      loadEasySlipQuota(),
      loadBillingRequests(),
      loadHistory(),
    ]).finally(() => {
      initialLoadDone.current = true
    })
  }, [])

  // เรียลไทม์: Realtime เมื่อ or_orders / ac_refunds เปลี่ยน
  useEffect(() => {
    const channel = supabase
      .channel('account-counts-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_orders' }, () => {
        loadBillingRequests()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ac_refunds' }, () => {
        loadRefunds()
      })
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  // เรียลไทม์: โพลทุก 30 วินาทีเมื่ออยู่ที่ Dashboard และแท็บเปิดอยู่
  useEffect(() => {
    if (accountSection !== 'dashboard') return
    const POLL_MS = 30_000
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadRefunds()
        loadBillingRequests()
      }
    }, POLL_MS)
    return () => clearInterval(t)
  }, [accountSection])

  // อัปเดตตัวเลขเมื่อกลับมาเปิดแท็บ
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        loadRefunds()
        loadBillingRequests()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  async function loadRefunds() {
    // แสดง spinner เฉพาะครั้งแรก — ป้องกันหน้ากระพริบเมื่อ refresh เบื้องหลัง
    if (!initialLoadDone.current) setLoading(true)
    try {
      const { data, error } = await supabase
        .from('ac_refunds')
        .select('*, or_orders(bill_no, customer_name)')
        .order('created_at', { ascending: false })

      if (error) throw error
      
      // กรองเฉพาะรายการที่ reason มีคำว่า "โอนเกิน"
      const filteredRefunds = (data || []).filter((refund: Refund) => 
        refund.reason && refund.reason.includes('โอนเกิน')
      )
      
      setRefunds(filteredRefunds)
    } catch (error: any) {
      console.error('Error loading refunds:', error)
    } finally {
      setLoading(false)
    }
  }

  async function loadEasySlipQuota() {
    setQuotaLoading(true)
    try {
      console.log('[Account] Loading EasySlip quota...')
      const result = await getEasySlipQuota()
      console.log('[Account] getEasySlipQuota result:', result)
      
      if (result.success && result.data) {
        console.log('[Account] Quota data received:', result.data)
        setEasyslipQuotaInfo(result.data)
      } else {
        console.error('[Account] Error loading EasySlip quota:', result.error)
        setEasyslipQuotaInfo(null)
      }
    } catch (error: any) {
      console.error('[Account] Exception loading EasySlip quota:', error)
      setEasyslipQuotaInfo(null)
    } finally {
      setQuotaLoading(false)
    }
  }

  async function loadBillingRequests() {
    // แสดง spinner เฉพาะครั้งแรก — ป้องกันหน้ากระพริบเมื่อ refresh เบื้องหลัง
    if (!initialLoadDone.current) setBillingLoading(true)
    try {
      // กรองเฉพาะรายการที่ผ่านการตรวจสอบแล้ว (ไม่แสดง ตรวจสอบไม่ผ่าน, รอลงข้อมูล, ลงข้อมูลผิด)
      const excludeStatuses = '("ตรวจสอบไม่ผ่าน","รอลงข้อมูล","ลงข้อมูลผิด")'
      const [taxRes, cashRes] = await Promise.all([
        supabase
          .from('or_orders')
          .select('id, bill_no, customer_name, total_amount, status, created_at, billing_details, claim_type')
          .contains('billing_details', { request_tax_invoice: true })
          .not('status', 'in', excludeStatuses)
          .order('created_at', { ascending: false }),
        supabase
          .from('or_orders')
          .select('id, bill_no, customer_name, total_amount, status, created_at, billing_details, claim_type')
          .contains('billing_details', { request_cash_bill: true })
          .not('status', 'in', excludeStatuses)
          .order('created_at', { ascending: false }),
      ])

      if ((taxRes as any).error) throw (taxRes as any).error
      if ((cashRes as any).error) throw (cashRes as any).error

      // กรองเฉพาะรายการที่ยังไม่ถูกยืนยัน (ไม่มี account_confirmed_tax/cash)
      const taxData = ((taxRes as any).data || []) as BillingRequestOrder[]
      const cashData = ((cashRes as any).data || []) as BillingRequestOrder[]
      
      const filteredTax = taxData.filter((o: BillingRequestOrder) => {
        const bd = o.billing_details || {}
        return !bd.account_confirmed_tax
      })
      
      const filteredCash = cashData.filter((o: BillingRequestOrder) => {
        const bd = o.billing_details || {}
        return !bd.account_confirmed_cash
      })

      setTaxInvoiceOrders(filteredTax)
      setCashBillOrders(filteredCash)
    } catch (error: any) {
      console.error('Error loading billing requests:', error)
    } finally {
      setBillingLoading(false)
    }
  }

  function openRefundActionModal(refund: Refund, action: 'approve' | 'reject') {
    setRefundActionModal({ open: true, refund, action, submitting: false })
  }

  function closeRefundActionModal() {
    if (!refundActionModal.submitting) {
      setRefundActionModal({ open: false, refund: null, action: null, submitting: false })
    }
  }

  async function submitRefundAction() {
    const { refund, action } = refundActionModal
    if (!user || !refund || !action) return
    setRefundActionModal((prev) => ({ ...prev, submitting: true }))
    try {
      const { error } = await supabase
        .from('ac_refunds')
        .update({
          status: action === 'approve' ? 'approved' : 'rejected',
          approved_by: user.id,
          approved_at: new Date().toISOString(),
        })
        .eq('id', refund.id)

      if (error) throw error
      setRefundActionModal({ open: false, refund: null, action: null, submitting: false })
      setRefundResultModal({
        open: true,
        message: action === 'approve' ? 'อนุมัติการโอนคืนสำเร็จ' : 'ปฏิเสธการโอนคืนสำเร็จ',
      })
      loadRefunds()
      loadHistory()
      window.dispatchEvent(new CustomEvent('sidebar-refresh-counts'))
    } catch (error: any) {
      console.error('Error updating refund:', error)
      setRefundActionModal((prev) => ({ ...prev, submitting: false }))
      setRefundResultModal({ open: true, message: 'เกิดข้อผิดพลาด: ' + error.message })
    }
  }

  async function loadHistory() {
    // แสดง spinner เฉพาะครั้งแรก — ป้องกันหน้ากระพริบเมื่อ refresh เบื้องหลัง
    if (!initialLoadDone.current) setHistoryLoading(true)
    try {
      const historyExcludeStatuses = '("ตรวจสอบไม่ผ่าน","รอลงข้อมูล","ลงข้อมูลผิด")'
      const [taxRes, cashRes, refundRes] = await Promise.all([
        supabase
          .from('or_orders')
          .select('id, bill_no, customer_name, total_amount, status, created_at, billing_details, claim_type')
          .contains('billing_details', { request_tax_invoice: true })
          .not('status', 'in', historyExcludeStatuses)
          .order('created_at', { ascending: false }),
        supabase
          .from('or_orders')
          .select('id, bill_no, customer_name, total_amount, status, created_at, billing_details, claim_type')
          .contains('billing_details', { request_cash_bill: true })
          .not('status', 'in', historyExcludeStatuses)
          .order('created_at', { ascending: false }),
        supabase
          .from('ac_refunds')
          .select('*, or_orders(bill_no, customer_name, customer_address)')
          .in('status', ['approved', 'rejected'])
          .order('created_at', { ascending: false }),
      ])

      if ((taxRes as any).error) throw (taxRes as any).error
      if ((cashRes as any).error) throw (cashRes as any).error
      if ((refundRes as any).error) throw (refundRes as any).error

      // กรองเฉพาะรายการที่ถูกยืนยันแล้ว
      const taxData = ((taxRes as any).data || []) as BillingRequestOrder[]
      const cashData = ((cashRes as any).data || []) as BillingRequestOrder[]
      
      const confirmedTax = taxData.filter((o: BillingRequestOrder) => {
        const bd = o.billing_details || {}
        return bd.account_confirmed_tax === true
      })
      
      const confirmedCash = cashData.filter((o: BillingRequestOrder) => {
        const bd = o.billing_details || {}
        return bd.account_confirmed_cash === true
      })

      setHistoryTaxInvoices(confirmedTax)
      setHistoryCashBills(confirmedCash)
      setHistoryRefunds(((refundRes as any).data || []) as Refund[])
    } catch (error: any) {
      console.error('Error loading history:', error)
    } finally {
      setHistoryLoading(false)
    }
  }

  function openConfirmTaxInvoice(order: BillingRequestOrder) {
    setBillingConfirmModal({ open: true, order, type: 'tax-invoice', submitting: false })
  }

  // @ts-ignore TS6133 - kept for future use
  function openConfirmCashBill(order: BillingRequestOrder) {
    setBillingConfirmModal({ open: true, order, type: 'cash-bill', submitting: false })
  }

  function closeBillingConfirmModal() {
    if (!billingConfirmModal.submitting) {
      setBillingConfirmModal({ open: false, order: null, type: null, submitting: false })
    }
  }

  async function submitBillingConfirm() {
    const { order, type } = billingConfirmModal
    if (!user || !order || !type) return
    const isTax = type === 'tax-invoice'
    setBillingConfirmModal((prev) => ({ ...prev, submitting: true }))

    try {
      const bd = order.billing_details || {}
      const newBillingDetails = isTax
        ? { ...bd, account_confirmed_tax: true, account_confirmed_tax_at: new Date().toISOString(), account_confirmed_tax_by: user.id }
        : { ...bd, account_confirmed_cash: true, account_confirmed_cash_at: new Date().toISOString(), account_confirmed_cash_by: user.id }

      const { error } = await supabase
        .from('or_orders')
        .update({ billing_details: newBillingDetails })
        .eq('id', order.id)

      if (error) throw error
      setBillingConfirmModal({ open: false, order: null, type: null, submitting: false })
      setBillingResultModal({
        open: true,
        title: 'สำเร็จ',
        message: isTax ? 'ยืนยันใบกำกับภาษีเรียบร้อย' : 'ยืนยันบิลเงินสดเรียบร้อย',
      })
      await loadBillingRequests()
      await loadHistory()
      window.dispatchEvent(new CustomEvent('sidebar-refresh-counts'))
    } catch (error: any) {
      console.error(isTax ? 'Error confirming tax invoice:' : 'Error confirming cash bill:', error)
      setBillingConfirmModal({ open: false, order: null, type: null, submitting: false })
      setBillingResultModal({
        open: true,
        title: 'เกิดข้อผิดพลาด',
        message: type === 'tax-invoice' ? 'เกิดข้อผิดพลาดในการยืนยันใบกำกับภาษี: ' + error.message : 'เกิดข้อผิดพลาดในการยืนยันบิลเงินสด: ' + error.message,
      })
    }
  }

  async function confirmTaxInvoice(order: BillingRequestOrder) {
    openConfirmTaxInvoice(order)
  }

  async function confirmCashBill(order: BillingRequestOrder) {
    setCashBillModal({ open: true, order, submitting: false, viewOnly: false })
  }

  /** เปิดบิลเงินสดแบบดูอย่างเดียว (จากเมนูรายการอนุมัติ) */
  function viewCashBill(order: BillingRequestOrder) {
    setCashBillModal({ open: true, order, submitting: false, viewOnly: true })
  }

  async function submitCashBillConfirm(order: BillingRequestOrder) {
    if (!user) return
    setCashBillModal((prev) => ({ ...prev, submitting: true }))
    try {
      const bd = order.billing_details || {}
      const newBillingDetails = {
        ...bd,
        account_confirmed_cash: true,
        account_confirmed_cash_at: new Date().toISOString(),
        account_confirmed_cash_by: user.id,
      }
      const { error } = await supabase
        .from('or_orders')
        .update({ billing_details: newBillingDetails })
        .eq('id', order.id)
      if (error) throw error
      setCashBillModal({ open: false, order: null, submitting: false, viewOnly: false })
      setBillingResultModal({ open: true, title: 'สำเร็จ', message: 'ยืนยันบิลเงินสดเรียบร้อย' })
      await loadBillingRequests()
      await loadHistory()
      window.dispatchEvent(new CustomEvent('sidebar-refresh-counts'))
    } catch (error: any) {
      console.error('Error confirming cash bill:', error)
      setCashBillModal({ open: false, order: null, submitting: false, viewOnly: false })
      setBillingResultModal({ open: true, title: 'เกิดข้อผิดพลาด', message: 'เกิดข้อผิดพลาดในการยืนยันบิลเงินสด: ' + error.message })
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center min-h-[280px]">
        <div className="flex flex-col items-center gap-3">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-blue-500 border-t-transparent" />
          <p className="text-sm text-gray-500">กำลังโหลด...</p>
        </div>
      </div>
    )
  }

  const pendingRefunds = refunds.filter((r) => r.status === 'pending')

  return (
    <div className="space-y-8">
      <div className="sticky top-0 z-10 bg-white border-b border-surface-200 shadow-soft -mx-6 px-6">
        <nav className="flex gap-1 sm:gap-3 flex-nowrap min-w-max py-3 overflow-x-auto">
          <button
            type="button"
            onClick={() => setAccountSection('dashboard')}
            className={`py-3 px-3 sm:px-4 rounded-t-xl border-b-2 font-semibold text-base whitespace-nowrap transition-colors ${accountSection === 'dashboard' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-blue-600'}`}
          >
            Dashboard
          </button>
          <button
            type="button"
            onClick={() => setAccountSection('slip-verification')}
            className={`py-3 px-3 sm:px-4 rounded-t-xl border-b-2 font-semibold text-base whitespace-nowrap transition-colors ${accountSection === 'slip-verification' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-blue-600'}`}
          >
            รายการการตรวจสลิป
          </button>
          <button
            type="button"
            onClick={() => setAccountSection('manual-slip-check')}
            className={`py-3 px-3 sm:px-4 rounded-t-xl border-b-2 font-semibold text-base whitespace-nowrap transition-colors ${accountSection === 'manual-slip-check' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-blue-600'}`}
          >
            ตรวจสลิปมือ
          </button>
          <button
            type="button"
            onClick={() => setAccountSection('bill-edit')}
            className={`py-3 px-3 sm:px-4 rounded-t-xl border-b-2 font-semibold text-base whitespace-nowrap transition-colors ${accountSection === 'bill-edit' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-blue-600'}`}
          >
            แก้ไขบิล
          </button>
        </nav>
      </div>

      {accountSection === 'slip-verification' ? (
        <section className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-gray-800">รายการการตรวจสลิป</h2>
              <p className="text-sm text-gray-500 mt-0.5">รายการตรวจสลิปทั้งหมดจากตาราง ac_verified_slips</p>
            </div>
            <button
              type="button"
              onClick={() => {
                const headers = ['วันที่โอน', 'เวลาโอน', 'ชื่อบัญชีผู้โอน', 'เลขบัญชี', 'ชื่อบัญชีผู้รับโอน', 'ช่องทางขาย', 'ผู้ขาย', 'ยอดเงิน', 'สถานะยอด', 'ผลตรวจ', 'สถานะสลิป', 'เหตุผลการลบ']
                const rows = filteredSlipsList.map((row) => {
                  const dt = row.easyslip_date || row.verified_at || ''
                  let dateStr = '–'
                  let timeStr = '–'
                  if (dt) {
                    const formatted = formatDateTime(dt)
                    const parts = formatted.split(' ')
                    timeStr = parts.length > 0 ? (parts[parts.length - 1] || '–') : '–'
                    dateStr = parts.length > 1 ? parts.slice(0, -1).join(' ') : formatted
                  }
                  return [
                    dateStr,
                    timeStr,
                    getPayerName(row.easyslip_response),
                    getPayerAccountNumber(row.easyslip_response),
                    getReceiverName(row.easyslip_response, row.easyslip_receiver_account),
                    row.or_orders?.channel_code ?? '–',
                    row.or_orders?.admin_user ?? '–',
                    row.verified_amount,
                    getTagLogic(row),
                    row.validation_status === 'passed' ? 'ผ่าน' : row.validation_status === 'failed' ? 'ไม่ผ่าน' : row.validation_status ?? '–',
                    row.is_deleted ? 'ลบ' : 'ปกติ',
                    row.deletion_reason ?? '–',
                  ]
                })
                const wb = XLSX.utils.book_new()
                const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
                XLSX.utils.book_append_sheet(wb, ws, 'รายการตรวจสลิป')
                XLSX.writeFile(wb, 'รายการตรวจสลิป.xlsx')
              }}
              disabled={verifiedSlipsLoading || filteredSlipsList.length === 0}
              className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              ดาวน์โหลด Excel
            </button>
          </div>
          {/* ตัวกรอง: ผู้ลงออเดอร์, ช่องทาง, วันที่ */}
          <div className="px-6 py-3 border-b border-gray-100 bg-gray-50/30 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <span className="whitespace-nowrap">ผู้ลงออเดอร์</span>
              <select
                value={slipFilterOrderTaker}
                onChange={(e) => setSlipFilterOrderTaker(e.target.value)}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm min-w-[120px] bg-white"
              >
                <option value="">ทั้งหมด</option>
                {slipFilterOrderTakerOptions.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <span className="whitespace-nowrap">ช่องทาง</span>
              <select
                value={slipFilterChannel}
                onChange={(e) => setSlipFilterChannel(e.target.value)}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm min-w-[120px] bg-white"
              >
                <option value="">ทั้งหมด</option>
                {slipFilterChannelOptions.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <span className="whitespace-nowrap">วันที่</span>
              <input
                type="date"
                value={slipFilterDate}
                onChange={(e) => setSlipFilterDate(e.target.value)}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm bg-white"
              />
            </label>
            {(slipFilterOrderTaker || slipFilterChannel || slipFilterDate) && (
              <button
                type="button"
                onClick={() => { setSlipFilterOrderTaker(''); setSlipFilterChannel(''); setSlipFilterDate('') }}
                className="text-sm text-blue-600 hover:underline"
              >
                ล้างตัวกรอง
              </button>
            )}
          </div>
          {verifiedSlipsLoading ? (
            <div className="flex justify-center items-center py-14">
              <div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-500 border-t-transparent" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="px-4 py-3 text-center font-semibold text-gray-700 whitespace-nowrap">วันที่โอน</th>
                    <th className="px-4 py-3 text-center font-semibold text-gray-700 whitespace-nowrap">เวลาโอน</th>
                    <th className="px-4 py-3 text-center font-semibold text-gray-700">ชื่อบัญชีผู้โอน</th>
                    <th className="px-4 py-3 text-center font-semibold text-gray-700 whitespace-nowrap">เลขบัญชี</th>
                    <th className="px-4 py-3 text-center font-semibold text-gray-700">ชื่อบัญชีผู้รับโอน</th>
                    <th className="px-4 py-3 text-center font-semibold text-gray-700 whitespace-nowrap">ช่องทางขาย</th>
                    <th className="px-4 py-3 text-center font-semibold text-gray-700 whitespace-nowrap">ผู้ขาย</th>
                    <th className="px-4 py-3 text-center font-semibold text-gray-700 whitespace-nowrap">ยอดเงิน</th>
                    <th className="px-4 py-3 text-center font-semibold text-gray-700 whitespace-nowrap">สถานะยอด</th>
                    <th className="px-4 py-3 text-center font-semibold text-gray-700 whitespace-nowrap">ผลตรวจ</th>
                    <th className="px-4 py-3 text-center font-semibold text-gray-700 whitespace-nowrap">สถานะสลิป</th>
                    <th className="px-4 py-3 text-center font-semibold text-gray-700">เหตุผลการลบ</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSlipsList.length === 0 ? (
                    <tr>
                      <td colSpan={12} className="px-4 py-12 text-center text-gray-500">
                        ไม่พบรายการตรวจสลิป
                      </td>
                    </tr>
                  ) : (
                    filteredSlipsList.map((row) => {
                      const dt = row.easyslip_date || row.verified_at || ''
                      let dateStr = '–'
                      let timeStr = '–'
                      if (dt) {
                        const formatted = formatDateTime(dt)
                        const parts = formatted.split(' ')
                        timeStr = parts.length > 0 ? (parts[parts.length - 1] || '–') : '–'
                        dateStr = parts.length > 1 ? parts.slice(0, -1).join(' ') : formatted
                      }
                      return (
                        <tr key={row.id} className="border-b border-gray-100 hover:bg-gray-50/50">
                          <td className="px-4 py-3 text-center text-gray-800 whitespace-nowrap">{dateStr}</td>
                          <td className="px-4 py-3 text-center text-gray-800 whitespace-nowrap">{timeStr}</td>
                          <td className="px-4 py-3 text-center text-gray-700">{getPayerName(row.easyslip_response)}</td>
                          <td className="px-4 py-3 text-center text-gray-700 font-mono text-xs">{getPayerAccountNumber(row.easyslip_response)}</td>
                          <td className="px-4 py-3 text-center text-gray-700">{getReceiverName(row.easyslip_response, row.easyslip_receiver_account)}</td>
                          <td className="px-4 py-3 text-center text-gray-700 whitespace-nowrap">{row.or_orders?.channel_code ?? '–'}</td>
                          <td className="px-4 py-3 text-center text-gray-700 whitespace-nowrap">{row.or_orders?.admin_user ?? '–'}</td>
                          <td className="px-4 py-3 text-center font-medium text-gray-800 tabular-nums">฿{Number(row.verified_amount).toLocaleString()}</td>
                          <td className="px-4 py-3 text-center text-gray-700 whitespace-nowrap">{getTagLogic(row)}</td>
                          <td className="px-4 py-3 text-center">
                            <span className={row.validation_status === 'passed' ? 'text-emerald-600' : row.validation_status === 'failed' ? 'text-red-600' : 'text-gray-500'}>
                              {row.validation_status === 'passed' ? 'ผ่าน' : row.validation_status === 'failed' ? 'ไม่ผ่าน' : row.validation_status ?? '–'}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span className={row.is_deleted ? 'text-amber-600 font-medium' : 'text-gray-600'}>{row.is_deleted ? 'ลบ' : 'ปกติ'}</span>
                          </td>
                          <td className="px-4 py-3 text-center text-gray-600 max-w-[200px] truncate" title={row.deletion_reason ?? ''}>{row.deletion_reason ?? '–'}</td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : accountSection === 'manual-slip-check' ? (
        <ManualSlipCheckSection />
      ) : accountSection === 'bill-edit' ? (
        <BillEditSection />
      ) : (
        <>
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden flex flex-col">
          <div className="h-1 w-full bg-blue-500 shrink-0" />
          <div className="p-5 flex-1">
            <p className="text-base font-medium text-gray-500 uppercase tracking-wide">EasySlip โควต้า</p>
            {quotaLoading ? (
              <div className="mt-3 flex items-center gap-2">
                <div className="h-8 w-16 rounded bg-gray-200 animate-pulse" />
                <span className="text-base text-gray-400">โหลด...</span>
              </div>
            ) : easyslipQuotaInfo ? (
              <>
                <p className="mt-3 text-4xl font-bold text-blue-600 tabular-nums">
                  {easyslipQuotaInfo.remainingQuota.toLocaleString()}
                </p>
                <p className="text-sm text-gray-500 mt-1">คงเหลือ</p>
                <div className="mt-4 pt-4 border-t border-gray-100 space-y-1.5 text-sm text-gray-600">
                  <p>ใช้แล้ว {easyslipQuotaInfo.usedQuota.toLocaleString()} / {easyslipQuotaInfo.maxQuota.toLocaleString()}</p>
                  <p>หมดอายุ {formatDateTime(easyslipQuotaInfo.expiredAt)}</p>
                  <p>เครดิต {easyslipQuotaInfo.currentCredit.toLocaleString()}</p>
                </div>
              </>
            ) : (
              <p className="mt-3 text-base text-red-600">โหลดโควต้าไม่ได้</p>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={() => setActiveTab('refunds')}
          className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden text-left hover:shadow-md hover:border-amber-200 transition-all focus:outline-none focus:ring-2 focus:ring-amber-400 focus:ring-offset-1 flex flex-col"
        >
          <div className="h-1 w-full bg-amber-500 shrink-0" />
          <div className="p-5 flex-1">
            <p className="text-base font-medium text-gray-500 uppercase tracking-wide">รออนุมัติโอนคืน</p>
            <p className="mt-3 text-4xl font-bold text-amber-600 tabular-nums">{pendingRefunds.length}</p>
            <p className="text-sm text-gray-500 mt-1">รายการ</p>
          </div>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('tax-invoice')}
          className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden text-left hover:shadow-md hover:border-sky-200 transition-all focus:outline-none focus:ring-2 focus:ring-sky-400 focus:ring-offset-1 flex flex-col"
        >
          <div className="h-1 w-full bg-sky-500 shrink-0" />
          <div className="p-5 flex-1">
            <p className="text-base font-medium text-gray-500 uppercase tracking-wide">ขอใบกำกับภาษี</p>
            <p className="mt-3 text-4xl font-bold text-sky-600 tabular-nums">
              {billingLoading ? '–' : taxInvoiceOrders.length}
            </p>
            <p className="text-sm text-gray-500 mt-1">รายการ</p>
          </div>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('cash-bill')}
          className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden text-left hover:shadow-md hover:border-emerald-200 transition-all focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-1 flex flex-col"
        >
          <div className="h-1 w-full bg-emerald-500 shrink-0" />
          <div className="p-5 flex-1">
            <p className="text-base font-medium text-gray-500 uppercase tracking-wide">ขอบิลเงินสด</p>
            <p className="mt-3 text-4xl font-bold text-emerald-600 tabular-nums">
              {billingLoading ? '–' : cashBillOrders.length}
            </p>
            <p className="text-sm text-gray-500 mt-1">รายการ</p>
          </div>
        </button>
      </section>

      {/* แถบเมนูย่อย — แสดงตัวเลขแบบเรียลไทม์ */}
      <nav className="flex gap-1 sm:gap-3 flex-nowrap min-w-max border-b border-surface-200 overflow-x-auto">
        <button
          type="button"
          onClick={() => setActiveTab('refunds')}
          className={`py-3 px-3 sm:px-4 rounded-t-xl border-b-2 font-semibold text-base whitespace-nowrap transition-colors flex items-center gap-2 ${activeTab === 'refunds' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-blue-600'}`}
        >
          รายการโอนคืน
          <span className="min-w-[1.25rem] h-5 px-1.5 flex items-center justify-center rounded-full text-xs font-bold bg-amber-100 text-amber-800">
            {loading ? '–' : pendingRefunds.length}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('tax-invoice')}
          className={`py-3 px-3 sm:px-4 rounded-t-xl border-b-2 font-semibold text-base whitespace-nowrap transition-colors flex items-center gap-2 ${activeTab === 'tax-invoice' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-blue-600'}`}
        >
          ขอใบกำกับภาษี
          <span className="min-w-[1.25rem] h-5 px-1.5 flex items-center justify-center rounded-full text-xs font-bold bg-sky-100 text-sky-800">
            {billingLoading ? '–' : taxInvoiceOrders.length}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('cash-bill')}
          className={`py-3 px-3 sm:px-4 rounded-t-xl border-b-2 font-semibold text-base whitespace-nowrap transition-colors flex items-center gap-2 ${activeTab === 'cash-bill' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-blue-600'}`}
        >
          ขอบิลเงินสด
          <span className="min-w-[1.25rem] h-5 px-1.5 flex items-center justify-center rounded-full text-xs font-bold bg-emerald-100 text-emerald-800">
            {billingLoading ? '–' : cashBillOrders.length}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('approvals')}
          className={`py-3 px-3 sm:px-4 rounded-t-xl border-b-2 font-semibold text-base whitespace-nowrap transition-colors ${activeTab === 'approvals' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-blue-600'}`}
        >
          รายการอนุมัติ
        </button>
      </nav>

      {activeTab === 'approvals' && (
      <section className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50">
          <h2 className="text-lg font-semibold text-gray-800">รายการอนุมัติ</h2>
          <p className="text-sm text-gray-500 mt-0.5">รายการที่ยืนยัน/อนุมัติหรือปฏิเสธแล้ว — คลิกรายการเพื่อดูข้อมูลบิล</p>
          <div className="mt-3 flex gap-2 flex-wrap">
            <span className="text-sm font-medium text-gray-600">กรองประเภทเอกสาร:</span>
            <button
              type="button"
              onClick={() => setApprovalFilter('refund')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${approvalFilter === 'refund' ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              โอนคืน
            </button>
            <button
              type="button"
              onClick={() => setApprovalFilter('tax-invoice')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${approvalFilter === 'tax-invoice' ? 'bg-sky-100 text-sky-800' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              ใบกำกับภาษี
            </button>
            <button
              type="button"
              onClick={() => setApprovalFilter('cash-bill')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${approvalFilter === 'cash-bill' ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              บิลเงินสด
            </button>
          </div>
        </div>
        {historyLoading ? (
          <div className="flex justify-center items-center py-14">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-violet-500 border-t-transparent" />
          </div>
        ) : (
          <div className="p-6">
            {approvalFilter === 'refund' && (historyRefunds.length === 0 ? (
                <div className="text-center py-12 text-gray-500 text-base">ไม่พบรายการโอนคืนที่อนุมัติหรือปฏิเสธแล้ว</div>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-gray-100">
                  <table className="w-full text-base">
                    <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">เลขบิล</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">ชื่อลูกค้า</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">ที่อยู่</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">จำนวนเงิน</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">เหตุผล</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">สถานะ</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">วันที่ดำเนินการ</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">การจัดการ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyRefunds.map((refund) => (
                        <tr
                          key={refund.id}
                          onClick={() => setViewOrderId(refund.order_id)}
                          className="border-b border-gray-100 hover:bg-amber-50/50 transition-colors cursor-pointer"
                        >
                          <td className="px-4 py-3 font-medium text-gray-800">
                          <span>{(refund as any).or_orders?.bill_no || '–'}</span>
                          {((refund as any).or_orders?.bill_no || '').startsWith('REQ') && (
                            <span className="ml-1.5 px-1.5 py-0.5 text-xs font-medium rounded bg-amber-100 text-amber-800 border border-amber-200">เคลม</span>
                          )}
                        </td>
                          <td className="px-4 py-3 text-gray-700">{(refund as any).or_orders?.customer_name || '–'}</td>
                          <td className="px-4 py-3 text-gray-600 max-w-[180px] text-sm whitespace-pre-wrap truncate" title={(refund as any).or_orders?.customer_address}>{(refund as any).or_orders?.customer_address || '–'}</td>
                          <td className="px-4 py-3 font-semibold text-emerald-600 tabular-nums">฿{refund.amount.toLocaleString()}</td>
                          <td className="px-4 py-3 text-gray-600 max-w-[200px] truncate" title={refund.reason}>{refund.reason}</td>
                          <td className="px-4 py-3">
                            <span className={`inline-flex px-2.5 py-1 rounded-lg text-sm font-medium ${refund.status === 'approved' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                              {refund.status === 'approved' ? 'อนุมัติแล้ว' : 'ปฏิเสธแล้ว'}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-gray-500 text-sm">{refund.approved_at ? formatDateTime(refund.approved_at) : '–'}</td>
                          <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); openSlipPopup(refund.order_id, (refund as any).or_orders?.bill_no || '–') }}
                              className="px-3 py-1.5 bg-sky-500 text-white rounded-lg hover:bg-sky-600 text-sm font-medium transition-colors"
                            >
                              ดูสลิปโอน
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            {approvalFilter === 'tax-invoice' && (historyTaxInvoices.length === 0 ? (
                <div className="text-center py-12 text-gray-500 text-base">ไม่พบประวัติใบกำกับภาษีที่ยืนยันแล้ว</div>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-gray-100">
                  <table className="w-full text-base">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-200">
                        <th className="px-4 py-3 text-left font-semibold text-gray-700">เลขบิล</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-700">ชื่อลูกค้า</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-700">ชื่อบริษัท</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-700">TAX ID</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-700">ที่อยู่</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-700">ยอดก่อนภาษี</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-700">มูลค่าภาษี</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-700">ยอดสุทธิ</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-700">วันที่ยืนยัน</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-700">การจัดการ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyTaxInvoices.map((o) => {
                        const bd = o.billing_details || {}
                        return (
                          <tr
                            key={o.id}
                            onClick={() => setViewOrderId(o.id)}
                            className="border-b border-gray-100 hover:bg-sky-50/50 transition-colors cursor-pointer"
                          >
                            <td className="px-4 py-3 font-semibold text-sky-700">
                              <span>{o.bill_no}</span>
                              {((o as any).claim_type != null || (o.bill_no || '').startsWith('REQ')) && (
                                <span className="ml-1.5 px-1.5 py-0.5 text-xs font-medium rounded bg-amber-100 text-amber-800 border border-amber-200">เคลม</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-gray-800">{o.customer_name || '–'}</td>
                            <td className="px-4 py-3 text-gray-700">{bd.tax_customer_name || '–'}</td>
                            <td className="px-4 py-3 text-gray-700 tabular-nums">{bd.tax_id || '–'}</td>
                            <td className="px-4 py-3 text-gray-600 max-w-[180px] text-sm whitespace-pre-wrap truncate" title={bd.tax_customer_address}>{bd.tax_customer_address || '–'}</td>
                            <td className="px-4 py-3 text-gray-700 tabular-nums">฿{(() => { const t = Number(o.total_amount || 0); const b = t ? t / 1.07 : 0; return b.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); })()}</td>
                            <td className="px-4 py-3 text-gray-700 tabular-nums">฿{(() => { const t = Number(o.total_amount || 0); const b = t ? t / 1.07 : 0; return (t - b).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); })()}</td>
                            <td className="px-4 py-3 font-semibold text-emerald-600 tabular-nums">฿{Number(o.total_amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                            <td className="px-4 py-3 text-gray-500 text-sm">{bd.account_confirmed_tax_at ? formatDateTime(bd.account_confirmed_tax_at) : '–'}</td>
                            <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); openSlipPopup(o.id, o.bill_no) }}
                                className="px-3 py-1.5 bg-sky-500 text-white rounded-lg hover:bg-sky-600 text-sm font-medium transition-colors"
                              >
                                ดูสลิปโอน
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              ))}
            {approvalFilter === 'cash-bill' && (historyCashBills.length === 0 ? (
                <div className="text-center py-12 text-gray-500 text-base">ไม่พบประวัติบิลเงินสดที่ยืนยันแล้ว</div>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-gray-100">
                  <table className="w-full text-base">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-200">
                        <th className="px-4 py-3 text-left font-semibold text-gray-700">เลขบิล</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-700">ชื่อลูกค้า</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-700">ชื่อบริษัท</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-700">ที่อยู่</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-700">ยอดสุทธิ</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-700">วันที่ยืนยัน</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-700">บิลเงินสด</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-700">การจัดการ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyCashBills.map((o) => {
                        const bd = o.billing_details || {}
                        return (
                          <tr
                            key={o.id}
                            onClick={() => setViewOrderId(o.id)}
                            className="border-b border-gray-100 hover:bg-emerald-50/50 transition-colors cursor-pointer"
                          >
                            <td className="px-4 py-3 font-semibold text-sky-700">
                              <span>{o.bill_no}</span>
                              {((o as any).claim_type != null || (o.bill_no || '').startsWith('REQ')) && (
                                <span className="ml-1.5 px-1.5 py-0.5 text-xs font-medium rounded bg-amber-100 text-amber-800 border border-amber-200">เคลม</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-gray-800">{o.customer_name || '–'}</td>
                            <td className="px-4 py-3 text-gray-700">{bd.tax_customer_name || '–'}</td>
                            <td className="px-4 py-3 text-gray-600 max-w-[180px] text-sm whitespace-pre-wrap truncate" title={bd.tax_customer_address}>{bd.tax_customer_address || '–'}</td>
                            <td className="px-4 py-3 font-semibold text-emerald-600 tabular-nums">฿{Number(o.total_amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                            <td className="px-4 py-3 text-gray-500 text-sm">{bd.account_confirmed_cash_at ? formatDateTime(bd.account_confirmed_cash_at) : '–'}</td>
                            <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); viewCashBill(o) }}
                                className="px-3 py-1.5 bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 text-sm font-medium transition-colors inline-flex items-center gap-1.5"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                </svg>
                                บิลเงินสด
                              </button>
                            </td>
                            <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); openSlipPopup(o.id, o.bill_no) }}
                                className="px-3 py-1.5 bg-sky-500 text-white rounded-lg hover:bg-sky-600 text-sm font-medium transition-colors"
                              >
                                ดูสลิปโอน
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              ))}
          </div>
        )}
      </section>
      )}

      {activeTab === 'refunds' && (
      <section className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50">
          <h2 className="text-lg font-semibold text-gray-800">รายการโอนคืน</h2>
          <p className="text-sm text-gray-500 mt-0.5">รายการโอนเกินที่รออนุมัติหรือยืนยัน — คลิกรายการเพื่อดูข้อมูลบิล</p>
        </div>
        {pendingRefunds.length === 0 ? (
          <div className="text-center py-14 text-gray-500 text-sm">
            ไม่พบรายการโอนคืนรออนุมัติ (รายการที่อนุมัติแล้วจะไปแสดงที่เมนู รายการอนุมัติ)
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-base">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">เลขบิล</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">ชื่อลูกค้า</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">จำนวนเงิน</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">เหตุผล</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">สถานะ</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">วันที่สร้าง</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">การจัดการ</th>
                </tr>
              </thead>
              <tbody>
                {pendingRefunds.map((refund) => (
                  <tr
                    key={refund.id}
                    onClick={() => setViewOrderId(refund.order_id)}
                    className="border-b border-gray-100 hover:bg-amber-50/50 transition-colors cursor-pointer"
                  >
                    <td className="px-4 py-3 font-medium text-gray-800">
                      <span>{(refund as any).or_orders?.bill_no || '–'}</span>
                      {((refund as any).or_orders?.bill_no || '').startsWith('REQ') && (
                        <span className="ml-1.5 px-1.5 py-0.5 text-xs font-medium rounded bg-amber-100 text-amber-800 border border-amber-200">เคลม</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {(refund as any).or_orders?.customer_name || '–'}
                    </td>
                    <td className="px-4 py-3 font-semibold text-emerald-600 tabular-nums">
                      ฿{refund.amount.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-gray-600 max-w-[200px] truncate" title={refund.reason}>
                      {refund.reason}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex px-2.5 py-1 rounded-lg text-sm font-medium bg-amber-100 text-amber-700">
                        รออนุมัติ
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-sm">
                      {formatDateTime(refund.created_at)}
                    </td>
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <div className="flex gap-2">
                        <button
                          onClick={(e) => { e.stopPropagation(); openRefundActionModal(refund, 'approve') }}
                          className="px-3 py-1.5 bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 text-sm font-medium transition-colors"
                        >
                          อนุมัติ
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); openRefundActionModal(refund, 'reject') }}
                          className="px-3 py-1.5 bg-red-500 text-white rounded-lg hover:bg-red-600 text-sm font-medium transition-colors"
                        >
                          ปฏิเสธ
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      )}

      {activeTab === 'tax-invoice' && (
      <section className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 bg-sky-50/50">
          <h2 className="text-lg font-semibold text-gray-800">รายการขอใบกำกับภาษี</h2>
          <p className="text-sm text-gray-500 mt-0.5">รอยืนยันจากฝ่ายบัญชี — คลิกรายการเพื่อดูข้อมูลบิล</p>
        </div>
        {billingLoading ? (
          <div className="flex justify-center items-center py-14">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-sky-500 border-t-transparent" />
          </div>
        ) : taxInvoiceOrders.length === 0 ? (
          <div className="text-center py-14 text-gray-500 text-base">ไม่พบรายการขอใบกำกับภาษี</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-base">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">เลขบิล</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">ชื่อลูกค้า</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">ชื่อบริษัท</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">TAX ID</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">ที่อยู่</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">ยอดก่อนภาษี</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">มูลค่าภาษี</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">ยอดสุทธิ</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">สถานะ</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">วันที่สร้าง</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">การจัดการ</th>
                </tr>
              </thead>
              <tbody>
                {taxInvoiceOrders.map((o) => {
                  const bd = o.billing_details || {}
                  const total = Number(o.total_amount || 0)
                  const beforeVat = total ? total / 1.07 : 0
                  const vatAmount = total ? total - beforeVat : 0
                  return (
                    <tr
                      key={o.id}
                      onClick={() => setViewOrderId(o.id)}
                      className="border-b border-gray-100 hover:bg-sky-50/50 transition-colors cursor-pointer"
                    >
                      <td className="px-4 py-3 font-semibold text-sky-700">
                        <span>{o.bill_no}</span>
                        {((o as any).claim_type != null || (o.bill_no || '').startsWith('REQ')) && (
                          <span className="ml-1.5 px-1.5 py-0.5 text-xs font-medium rounded bg-amber-100 text-amber-800 border border-amber-200">เคลม</span>
                        )}
                      </td>
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-2">
                          <span className="text-gray-800">{o.customer_name || '–'}</span>
                          {o.customer_name && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); copyToClipboard(o.customer_name || '') }}
                              className="text-sm text-sky-600 hover:underline"
                            >
                              คัดลอก
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-2">
                          <span className="text-gray-700">{bd.tax_customer_name || '–'}</span>
                          {bd.tax_customer_name && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); copyToClipboard(bd.tax_customer_name || '') }}
                              className="text-sm text-sky-600 hover:underline"
                            >
                              คัดลอก
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-2">
                          <span className="text-gray-700 tabular-nums">{bd.tax_id || '–'}</span>
                          {bd.tax_id && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); copyToClipboard(bd.tax_id || '') }}
                              className="text-sm text-sky-600 hover:underline"
                            >
                              คัดลอก
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-600 max-w-[180px] text-sm whitespace-pre-wrap" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-start gap-2">
                          <span className="truncate block" title={bd.tax_customer_address}>{bd.tax_customer_address || '–'}</span>
                          {bd.tax_customer_address && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); copyToClipboard(bd.tax_customer_address || '') }}
                              className="text-sky-600 hover:underline shrink-0 text-sm"
                            >
                              คัดลอก
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-700 tabular-nums text-sm">
                        ฿{beforeVat ? beforeVat.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'}
                      </td>
                      <td className="px-4 py-3 text-gray-700 tabular-nums text-sm">
                        ฿{vatAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td className="px-4 py-3 font-semibold text-emerald-600 tabular-nums">
                        ฿{total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex px-2.5 py-1 rounded-lg text-sm font-medium ${o.status === 'ตรวจสอบแล้ว' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-700'}`}>{o.status}</span>
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-sm">{formatDateTime(o.created_at)}</td>
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); confirmTaxInvoice(o) }}
                          className="px-3 py-1.5 bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 text-sm font-medium transition-colors"
                        >
                          ยืนยัน
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      )}

      {activeTab === 'cash-bill' && (
      <section className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 bg-emerald-50/50">
          <h2 className="text-lg font-semibold text-gray-800">รายการขอบิลเงินสด</h2>
          <p className="text-sm text-gray-500 mt-0.5">รอยืนยันจากฝ่ายบัญชี — คลิกรายการเพื่อดูข้อมูลบิล</p>
        </div>
        {billingLoading ? (
          <div className="flex justify-center items-center py-14">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-emerald-500 border-t-transparent" />
          </div>
        ) : cashBillOrders.length === 0 ? (
          <div className="text-center py-14 text-gray-500 text-base">ไม่พบรายการขอบิลเงินสด</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-base">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">เลขบิล</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">ชื่อลูกค้า</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">ชื่อบริษัท</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">ที่อยู่</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">ยอดสุทธิ</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">สถานะ</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">วันที่สร้าง</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">การจัดการ</th>
                </tr>
              </thead>
              <tbody>
                {cashBillOrders.map((o) => {
                  const bd = o.billing_details || {}
                  return (
                    <tr
                      key={o.id}
                      onClick={() => setViewOrderId(o.id)}
                      className="border-b border-gray-100 hover:bg-emerald-50/50 transition-colors cursor-pointer"
                    >
                      <td className="px-4 py-3 font-semibold text-sky-700">
                        <span>{o.bill_no}</span>
                        {((o as any).claim_type != null || (o.bill_no || '').startsWith('REQ')) && (
                          <span className="ml-1.5 px-1.5 py-0.5 text-xs font-medium rounded bg-amber-100 text-amber-800 border border-amber-200">เคลม</span>
                        )}
                      </td>
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-2">
                          <span className="text-gray-800">{o.customer_name || '–'}</span>
                          {o.customer_name && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); copyToClipboard(o.customer_name || '') }}
                              className="text-sm text-sky-600 hover:underline"
                            >
                              คัดลอก
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-2">
                          <span className="text-gray-700">{bd.tax_customer_name || '–'}</span>
                          {bd.tax_customer_name && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); copyToClipboard(bd.tax_customer_name || '') }}
                              className="text-sm text-sky-600 hover:underline"
                            >
                              คัดลอก
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-600 max-w-[180px] text-sm whitespace-pre-wrap" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-start gap-2">
                          <span className="truncate block" title={bd.tax_customer_address}>{bd.tax_customer_address || '–'}</span>
                          {bd.tax_customer_address && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); copyToClipboard(bd.tax_customer_address || '') }}
                              className="text-sky-600 hover:underline shrink-0 text-sm"
                            >
                              คัดลอก
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-semibold text-emerald-600 tabular-nums">฿{Number(o.total_amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex px-2.5 py-1 rounded-lg text-sm font-medium ${o.status === 'ตรวจสอบแล้ว' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-700'}`}>{o.status}</span>
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-sm">{formatDateTime(o.created_at)}</td>
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); confirmCashBill(o) }}
                          className="px-3 py-1.5 bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 text-sm font-medium transition-colors"
                        >
                          ยืนยัน
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      )}

      {/* Modal ดูสลิปโอน */}
      {slipPopupOrderId && (
        <Modal
          open
          onClose={() => setSlipPopupOrderId(null)}
          closeOnBackdropClick
          contentClassName="max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col"
        >
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-800">สลิปโอน — บิล {slipPopupBillNo}</h3>
              <button
                type="button"
                onClick={() => setSlipPopupOrderId(null)}
                className="p-2 rounded-lg hover:bg-gray-100 text-gray-600"
              >
                ✕
              </button>
            </div>
            <div className="p-6 overflow-y-auto flex-1">
              {slipPopupLoading ? (
                <div className="flex justify-center py-12">
                  <div className="animate-spin rounded-full h-10 w-10 border-2 border-sky-500 border-t-transparent" />
                </div>
              ) : slipPopupUrls.length === 0 ? (
                <p className="text-center text-gray-500 py-8">ไม่พบภาพสลิปโอนของบิลนี้</p>
              ) : (
                <div className="space-y-4">
                  {slipPopupUrls.map((url, idx) => (
                    <div key={idx} className="flex justify-center">
                      {slipPopupFailed.has(idx) ? (
                        <div className="flex flex-col items-center justify-center py-12 px-6 rounded-lg border border-amber-200 bg-amber-50 text-amber-800 min-h-[200px]">
                          <span className="text-4xl mb-2">🖼️</span>
                          <p className="font-medium">โหลดรูปไม่สำเร็จ</p>
                          <p className="text-sm mt-1">ลิงก์อาจหมดอายุหรือไม่มีสิทธิ์เข้าถึง</p>
                          <a href={url} target="_blank" rel="noopener noreferrer" className="mt-3 text-sm text-sky-600 hover:underline">เปิดในแท็บใหม่</a>
                        </div>
                      ) : (
                        <img
                          src={url}
                          alt={`สลิปโอน ${idx + 1}`}
                          className="max-w-full h-auto rounded-lg border border-gray-200 shadow-sm"
                          referrerPolicy="no-referrer"
                          onError={() => setSlipPopupFailed(prev => new Set(prev).add(idx))}
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
        </Modal>
      )}

      {/* Modal ดูข้อมูลบิล (อ่านอย่างเดียว) */}
      {viewOrderId && (
        <Modal
          open
          onClose={() => setViewOrderId(null)}
          closeOnBackdropClick
          contentClassName="max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col"
        >
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-800">ข้อมูลบิล (ดูอย่างเดียว)</h3>
              <button
                type="button"
                onClick={() => setViewOrderId(null)}
                className="p-2 rounded-lg hover:bg-gray-100 text-gray-600"
              >
                ✕
              </button>
            </div>
            <div className="p-6 overflow-y-auto flex-1 text-base">
              {viewOrderLoading ? (
                <div className="flex justify-center py-12">
                  <div className="animate-spin rounded-full h-8 w-8 border-2 border-sky-500 border-t-transparent" />
                </div>
              ) : viewOrder ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <p className="flex items-center gap-2">
                      <span className="font-medium text-gray-600">เลขบิล:</span>
                      <span>{viewOrder.bill_no}</span>
                      {((viewOrder as any).claim_type != null || (viewOrder.bill_no || '').startsWith('REQ')) && (
                        <span className="px-1.5 py-0.5 text-xs font-medium rounded bg-amber-100 text-amber-800 border border-amber-200">เคลม</span>
                      )}
                    </p>
                    <p><span className="font-medium text-gray-600">สถานะ:</span> {viewOrder.status}</p>
                    <p className="col-span-2"><span className="font-medium text-gray-600">ลูกค้า:</span> {viewOrder.customer_name}</p>
                    <p className="col-span-2"><span className="font-medium text-gray-600">ที่อยู่:</span> {viewOrder.customer_address || '–'}</p>
                    <p><span className="font-medium text-gray-600">ยอดรวม:</span> ฿{Number(viewOrder.total_amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
                    <p><span className="font-medium text-gray-600">วันที่สร้าง:</span> {formatDateTime(viewOrder.created_at)}</p>
                  </div>
                  <div>
                    <h4 className="font-semibold text-gray-700 mb-2">รายการสินค้า</h4>
                    <div className="border border-gray-200 rounded-lg overflow-hidden">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-3 py-2 text-left font-semibold text-gray-700">ชื่อสินค้า</th>
                            <th className="px-3 py-2 text-left font-semibold text-gray-700">จำนวน</th>
                            <th className="px-3 py-2 text-left font-semibold text-gray-700">ราคา/หน่วย</th>
                            <th className="px-3 py-2 text-right font-semibold text-gray-700">รวม</th>
                          </tr>
                        </thead>
                        <tbody>
                          {((viewOrder as any).or_order_items || (viewOrder as any).order_items || []).map((item: any) => (
                            <tr key={item.id} className="border-t border-gray-100">
                              <td className="px-3 py-2 text-gray-800">{item.product_name || '–'}</td>
                              <td className="px-3 py-2 text-gray-700">{item.quantity ?? '–'}</td>
                              <td className="px-3 py-2 text-gray-700">฿{Number(item.unit_price || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                              <td className="px-3 py-2 text-right font-medium text-gray-800">฿{Number((item.quantity || 0) * (item.unit_price || 0)).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-gray-500">ไม่พบข้อมูลบิล</p>
              )}
            </div>
        </Modal>
      )}

      {/* Modal แจ้งผลหลังอนุมัติ/ปฏิเสธโอนคืน */}
      <Modal
        open={refundResultModal.open}
        onClose={() => setRefundResultModal({ open: false, message: '' })}
        contentClassName="max-w-md"
        closeOnBackdropClick
      >
        <div className="p-5">
          <p className="text-gray-800">{refundResultModal.message}</p>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => setRefundResultModal({ open: false, message: '' })}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700"
            >
              ตกลง
            </button>
          </div>
        </div>
      </Modal>

      {/* Modal เปิดบิลเงินสด */}
      <CashBillModal
        open={cashBillModal.open}
        order={cashBillModal.order}
        onClose={() => { if (!cashBillModal.submitting) setCashBillModal({ open: false, order: null, submitting: false, viewOnly: false }) }}
        onConfirm={(o) => submitCashBillConfirm(o as BillingRequestOrder)}
        submitting={cashBillModal.submitting}
        hideConfirm={cashBillModal.viewOnly}
      />

      {/* Modal ยืนยัน ขอใบกำกับภาษี (ใช้สำหรับ tax-invoice เท่านั้น) */}
      {billingConfirmModal.open && billingConfirmModal.order && billingConfirmModal.type && (
        <Modal
          open
          onClose={closeBillingConfirmModal}
          contentClassName="max-w-md w-full"
        >
          <div className="p-6">
            <h3 className="text-lg font-bold text-gray-900 mb-2">
              {billingConfirmModal.type === 'tax-invoice' ? 'ยืนยัน ขอใบกำกับภาษี' : 'ยืนยัน ขอบิลเงินสด'}
            </h3>
            <p className="text-gray-700 mb-6">
              {billingConfirmModal.type === 'tax-invoice'
                ? `ต้องการยืนยันว่าออกใบกำกับภาษีสำหรับบิล ${billingConfirmModal.order.bill_no} เรียบร้อยแล้วหรือไม่?`
                : `ต้องการยืนยันว่าออกบิลเงินสดสำหรับบิล ${billingConfirmModal.order.bill_no} เรียบร้อยแล้วหรือไม่?`}
            </p>
            <div className="flex gap-3 justify-end">
              <button
                type="button"
                onClick={closeBillingConfirmModal}
                disabled={billingConfirmModal.submitting}
                className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50 text-sm font-medium"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={submitBillingConfirm}
                disabled={billingConfirmModal.submitting}
                className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {billingConfirmModal.submitting ? (
                  <>
                    <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                    กำลังดำเนินการ...
                  </>
                ) : (
                  'ยืนยัน'
                )}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Modal แจ้งผลหลังยืนยันใบกำกับภาษี/บิลเงินสด */}
      <Modal
        open={billingResultModal.open}
        onClose={() => setBillingResultModal({ open: false, title: '', message: '' })}
        contentClassName="max-w-md"
        closeOnBackdropClick
      >
        <div className="p-5">
          <h3 className="text-lg font-semibold text-gray-900 mb-2">{billingResultModal.title}</h3>
          <p className="text-gray-800 text-sm">{billingResultModal.message}</p>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => setBillingResultModal({ open: false, title: '', message: '' })}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700"
            >
              ตกลง
            </button>
          </div>
        </div>
      </Modal>

      {/* Modal ยืนยัน อนุมัติ/ปฏิเสธ โอนคืน (popup เดียว) */}
      {refundActionModal.open && refundActionModal.refund && refundActionModal.action && (
        <Modal
          open
          onClose={closeRefundActionModal}
          contentClassName="max-w-md w-full"
        >
          <div className="p-6">
            <h3 className="text-lg font-bold text-gray-900 mb-2">
              {refundActionModal.action === 'approve' ? 'ยืนยันอนุมัติการโอนคืน' : 'ยืนยันปฏิเสธการโอนคืน'}
            </h3>
            <p className="text-gray-700 mb-6">
              {refundActionModal.action === 'approve'
                ? `ต้องการอนุมัติการโอนคืน ฿${refundActionModal.refund.amount.toLocaleString()} หรือไม่?`
                : `ต้องการปฏิเสธการโอนคืน ฿${refundActionModal.refund.amount.toLocaleString()} หรือไม่?`}
            </p>
            <div className="flex gap-3 justify-end">
              <button
                type="button"
                onClick={closeRefundActionModal}
                disabled={refundActionModal.submitting}
                className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50 text-sm font-medium"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={submitRefundAction}
                disabled={refundActionModal.submitting}
                className={`px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2 ${
                  refundActionModal.action === 'approve'
                    ? 'bg-emerald-500 hover:bg-emerald-600'
                    : 'bg-red-500 hover:bg-red-600'
                }`}
              >
                {refundActionModal.submitting ? (
                  <>
                    <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                    กำลังดำเนินการ...
                  </>
                ) : (
                  'ยืนยัน'
                )}
              </button>
            </div>
          </div>
        </Modal>
      )}

        </>
      )}

    </div>
  )
}
