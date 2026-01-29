import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { Refund, Order } from '../types'
import { formatDateTime } from '../lib/utils'
import { useAuthContext } from '../contexts/AuthContext'
import { getEasySlipQuota } from '../lib/slipVerification'

type AccountTab = 'refunds' | 'tax-invoice' | 'cash-bill' | 'approvals'
type ApprovalFilter = 'refund' | 'tax-invoice' | 'cash-bill'

type BillingRequestOrder = {
  id: string
  bill_no: string
  customer_name: string
  total_amount: number
  status: string
  created_at: string
  billing_details: any
}

export default function Account() {
  const { user } = useAuthContext()
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
    loadRefunds()
    loadEasySlipQuota()
    loadBillingRequests()
    loadHistory()
  }, [])

  async function loadRefunds() {
    setLoading(true)
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
      alert('เกิดข้อผิดพลาดในการโหลดข้อมูล: ' + error.message)
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
    setBillingLoading(true)
    try {
      const [taxRes, cashRes] = await Promise.all([
        supabase
          .from('or_orders')
          .select('id, bill_no, customer_name, total_amount, status, created_at, billing_details')
          .contains('billing_details', { request_tax_invoice: true })
          .order('created_at', { ascending: false }),
        supabase
          .from('or_orders')
          .select('id, bill_no, customer_name, total_amount, status, created_at, billing_details')
          .contains('billing_details', { request_cash_bill: true })
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
      alert('เกิดข้อผิดพลาดในการโหลดรายการเอกสาร: ' + (error?.message || String(error)))
    } finally {
      setBillingLoading(false)
    }
  }

  async function approveRefund(refund: Refund) {
    if (!user) return
    if (!confirm(`ต้องการอนุมัติการโอนคืน ฿${refund.amount.toLocaleString()} หรือไม่?`)) return

    try {
      const { error } = await supabase
        .from('ac_refunds')
        .update({
          status: 'approved',
          approved_by: user.id,
          approved_at: new Date().toISOString(),
        })
        .eq('id', refund.id)

      if (error) throw error
      alert('อนุมัติการโอนคืนสำเร็จ')
      loadRefunds()
      loadHistory()
    } catch (error: any) {
      console.error('Error approving refund:', error)
      alert('เกิดข้อผิดพลาด: ' + error.message)
    }
  }

  async function rejectRefund(refund: Refund) {
    if (!user) return
    if (!confirm(`ต้องการปฏิเสธการโอนคืน ฿${refund.amount.toLocaleString()} หรือไม่?`)) return

    try {
      const { error } = await supabase
        .from('ac_refunds')
        .update({
          status: 'rejected',
          approved_by: user.id,
          approved_at: new Date().toISOString(),
        })
        .eq('id', refund.id)

      if (error) throw error
      alert('ปฏิเสธการโอนคืนสำเร็จ')
      loadRefunds()
      loadHistory()
    } catch (error: any) {
      console.error('Error rejecting refund:', error)
      alert('เกิดข้อผิดพลาด: ' + error.message)
    }
  }

  async function loadHistory() {
    setHistoryLoading(true)
    try {
      const [taxRes, cashRes, refundRes] = await Promise.all([
        supabase
          .from('or_orders')
          .select('id, bill_no, customer_name, total_amount, status, created_at, billing_details')
          .contains('billing_details', { request_tax_invoice: true })
          .order('created_at', { ascending: false }),
        supabase
          .from('or_orders')
          .select('id, bill_no, customer_name, total_amount, status, created_at, billing_details')
          .contains('billing_details', { request_cash_bill: true })
          .order('created_at', { ascending: false }),
        supabase
          .from('ac_refunds')
          .select('*, or_orders(bill_no, customer_name, customer_address)')
          .eq('status', 'approved')
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
      alert('เกิดข้อผิดพลาดในการโหลดประวัติเอกสาร: ' + (error?.message || String(error)))
    } finally {
      setHistoryLoading(false)
    }
  }

  async function confirmTaxInvoice(order: BillingRequestOrder) {
    if (!user) return
    if (!confirm(`ต้องการยืนยันว่าออกใบกำกับภาษีสำหรับบิล ${order.bill_no} เรียบร้อยแล้วหรือไม่?`)) return

    try {
      const bd = order.billing_details || {}
      const newBillingDetails = {
        ...bd,
        account_confirmed_tax: true,
        account_confirmed_tax_at: new Date().toISOString(),
        account_confirmed_tax_by: user.id,
      }

      const { error } = await supabase
        .from('or_orders')
        .update({ billing_details: newBillingDetails })
        .eq('id', order.id)

      if (error) throw error
      alert('ยืนยันใบกำกับภาษีเรียบร้อย')
      await loadBillingRequests()
      await loadHistory()
    } catch (error: any) {
      console.error('Error confirming tax invoice:', error)
      alert('เกิดข้อผิดพลาดในการยืนยันใบกำกับภาษี: ' + error.message)
    }
  }

  async function confirmCashBill(order: BillingRequestOrder) {
    if (!user) return
    if (!confirm(`ต้องการยืนยันว่าออกบิลเงินสดสำหรับบิล ${order.bill_no} เรียบร้อยแล้วหรือไม่?`)) return

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
      alert('ยืนยันบิลเงินสดเรียบร้อย')
      await loadBillingRequests()
      await loadHistory()
    } catch (error: any) {
      console.error('Error confirming cash bill:', error)
      alert('เกิดข้อผิดพลาดในการยืนยันบิลเงินสด: ' + error.message)
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
      <header className="border-b border-gray-200 pb-4">
        <h1 className="text-2xl font-bold text-gray-800">บัญชี</h1>
        <p className="text-sm text-gray-500 mt-1">จัดการโอนคืน คำขอใบกำกับภาษี และบิลเงินสด</p>
      </header>

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

      {/* แถบเมนูย่อย */}
      <nav className="flex gap-1 p-1 bg-gray-100 rounded-xl w-fit">
        <button
          type="button"
          onClick={() => setActiveTab('refunds')}
          className={`px-5 py-2.5 rounded-lg text-base font-medium transition-colors ${activeTab === 'refunds' ? 'bg-white text-amber-700 shadow-sm' : 'text-gray-600 hover:bg-gray-200'}`}
        >
          รายการโอนคืน
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('tax-invoice')}
          className={`px-5 py-2.5 rounded-lg text-base font-medium transition-colors ${activeTab === 'tax-invoice' ? 'bg-white text-sky-700 shadow-sm' : 'text-gray-600 hover:bg-gray-200'}`}
        >
          ขอใบกำกับภาษี
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('cash-bill')}
          className={`px-5 py-2.5 rounded-lg text-base font-medium transition-colors ${activeTab === 'cash-bill' ? 'bg-white text-emerald-700 shadow-sm' : 'text-gray-600 hover:bg-gray-200'}`}
        >
          ขอบิลเงินสด
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('approvals')}
          className={`px-5 py-2.5 rounded-lg text-base font-medium transition-colors ${activeTab === 'approvals' ? 'bg-white text-violet-700 shadow-sm' : 'text-gray-600 hover:bg-gray-200'}`}
        >
          รายการอนุมัติ
        </button>
      </nav>

      {activeTab === 'approvals' && (
      <section className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50">
          <h2 className="text-lg font-semibold text-gray-800">รายการอนุมัติ</h2>
          <p className="text-sm text-gray-500 mt-0.5">รายการที่ยืนยัน/อนุมัติแล้ว — คลิกรายการเพื่อดูข้อมูลบิล</p>
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
                <div className="text-center py-12 text-gray-500 text-base">ไม่พบรายการโอนคืนที่อนุมัติแล้ว</div>
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
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">วันที่อนุมัติ</th>
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
                          <td className="px-4 py-3 font-medium text-gray-800">{(refund as any).or_orders?.bill_no || '–'}</td>
                          <td className="px-4 py-3 text-gray-700">{(refund as any).or_orders?.customer_name || '–'}</td>
                          <td className="px-4 py-3 text-gray-600 max-w-[180px] text-sm whitespace-pre-wrap truncate" title={(refund as any).or_orders?.customer_address}>{(refund as any).or_orders?.customer_address || '–'}</td>
                          <td className="px-4 py-3 font-semibold text-emerald-600 tabular-nums">฿{refund.amount.toLocaleString()}</td>
                          <td className="px-4 py-3 text-gray-600 max-w-[200px] truncate" title={refund.reason}>{refund.reason}</td>
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
                            <td className="px-4 py-3 font-semibold text-sky-700">{o.bill_no}</td>
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
                            <td className="px-4 py-3 font-semibold text-sky-700">{o.bill_no}</td>
                            <td className="px-4 py-3 text-gray-800">{o.customer_name || '–'}</td>
                            <td className="px-4 py-3 text-gray-700">{bd.tax_customer_name || '–'}</td>
                            <td className="px-4 py-3 text-gray-600 max-w-[180px] text-sm whitespace-pre-wrap truncate" title={bd.tax_customer_address}>{bd.tax_customer_address || '–'}</td>
                            <td className="px-4 py-3 font-semibold text-emerald-600 tabular-nums">฿{Number(o.total_amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                            <td className="px-4 py-3 text-gray-500 text-sm">{bd.account_confirmed_cash_at ? formatDateTime(bd.account_confirmed_cash_at) : '–'}</td>
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
                      {(refund as any).or_orders?.bill_no || '–'}
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
                          onClick={(e) => { e.stopPropagation(); approveRefund(refund) }}
                          className="px-3 py-1.5 bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 text-sm font-medium transition-colors"
                        >
                          อนุมัติ
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); rejectRefund(refund) }}
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
                      <td className="px-4 py-3 font-semibold text-sky-700">{o.bill_no}</td>
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
                      <td className="px-4 py-3 font-semibold text-sky-700">{o.bill_no}</td>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setSlipPopupOrderId(null)}>
          <div
            className="bg-white rounded-xl shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
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
          </div>
        </div>
      )}

      {/* Modal ดูข้อมูลบิล (อ่านอย่างเดียว) */}
      {viewOrderId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setViewOrderId(null)}>
          <div
            className="bg-white rounded-xl shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
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
                    <p><span className="font-medium text-gray-600">เลขบิล:</span> {viewOrder.bill_no}</p>
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
          </div>
        </div>
      )}

    </div>
  )
}
