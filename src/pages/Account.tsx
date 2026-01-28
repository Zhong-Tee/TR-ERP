import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { Refund } from '../types'
import { formatDateTime } from '../lib/utils'
import { useAuthContext } from '../contexts/AuthContext'
import { getEasySlipQuota } from '../lib/slipVerification'

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

  function copyToClipboard(text: string) {
    if (!text) return
    if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch((err) => {
        console.error('Failed to copy text:', err)
      })
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
          .select('*, or_orders(bill_no, customer_name)')
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

  async function confirmRefundHistory(refund: Refund) {
    if (!user) return
    if (!confirm(`ต้องการยืนยันว่าทำรายการโอนคืน ฿${refund.amount.toLocaleString()} เรียบร้อยแล้วหรือไม่?`)) return

    try {
      // ใช้ status='approved' เป็นตัวบอกว่าทำรายการเสร็จแล้ว (ไม่ต้องเพิ่ม field ใหม่)
      // ถ้าต้องการแยก history_confirmed จริงๆ ต้องเพิ่ม column ใน DB
      // ตอนนี้ใช้ approved_at เป็นตัวบอกว่าเสร็จแล้ว
      if (refund.status !== 'approved') {
        const { error } = await supabase
          .from('ac_refunds')
          .update({
            status: 'approved',
            approved_by: user.id,
            approved_at: new Date().toISOString(),
          })
          .eq('id', refund.id)

        if (error) throw error
      }
      alert('ยืนยันรายการโอนคืนเรียบร้อย')
      await loadRefunds()
      await loadHistory()
    } catch (error: any) {
      console.error('Error confirming refund history:', error)
      alert('เกิดข้อผิดพลาดในการยืนยันรายการโอนคืน: ' + error.message)
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
      </div>
    )
  }

  const pendingRefunds = refunds.filter((r) => r.status === 'pending')

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">บัญชี</h1>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="bg-white p-6 rounded-lg shadow">
          <h2 className="text-xl font-bold mb-4">EasySlip Quota</h2>
          {quotaLoading ? (
            <div className="text-3xl font-bold text-gray-400">Loading...</div>
          ) : easyslipQuotaInfo ? (
            <>
              <div className="text-3xl font-bold text-blue-600">
                {easyslipQuotaInfo.remainingQuota.toLocaleString()}
              </div>
              <p className="text-sm text-gray-600 mt-2">จำนวนโคต้าคงเหลือ</p>
              <div className="mt-4 space-y-1 text-sm text-gray-500">
                <p>ใช้ไปแล้ว: {easyslipQuotaInfo.usedQuota.toLocaleString()} / {easyslipQuotaInfo.maxQuota.toLocaleString()}</p>
                <p>หมดอายุ: {formatDateTime(easyslipQuotaInfo.expiredAt)}</p>
                <p>เครดิตคงเหลือ: {easyslipQuotaInfo.currentCredit.toLocaleString()}</p>
              </div>
            </>
          ) : (
            <div className="text-red-600">ไม่สามารถโหลดข้อมูลโควต้าได้</div>
          )}
        </div>

        <div className="bg-white p-6 rounded-lg shadow">
          <h2 className="text-xl font-bold mb-4">รออนุมัติโอนคืน</h2>
          <div className="text-3xl font-bold text-orange-600">
            {pendingRefunds.length}
          </div>
          <p className="text-sm text-gray-600 mt-2">รายการ</p>
        </div>

        <div className="bg-white p-6 rounded-lg shadow">
          <h2 className="text-xl font-bold mb-4">ขอใบกำกับภาษี</h2>
          <div className="text-3xl font-bold text-blue-600">
            {billingLoading ? '-' : taxInvoiceOrders.length}
          </div>
          <p className="text-sm text-gray-600 mt-2">รายการ</p>
        </div>

        <div className="bg-white p-6 rounded-lg shadow">
          <h2 className="text-xl font-bold mb-4">ขอบิลเงินสด</h2>
          <div className="text-3xl font-bold text-green-600">
            {billingLoading ? '-' : cashBillOrders.length}
          </div>
          <p className="text-sm text-gray-600 mt-2">รายการ</p>
        </div>
      </div>

      <div className="bg-white p-6 rounded-lg shadow">
        <h2 className="text-xl font-bold mb-4">รายการโอนคืน</h2>
        {refunds.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            ไม่พบรายการโอนคืน
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-100">
                <tr>
                  <th className="p-3 text-left">เลขบิล</th>
                  <th className="p-3 text-left">ลูกค้า</th>
                  <th className="p-3 text-left">จำนวนเงิน</th>
                  <th className="p-3 text-left">เหตุผล</th>
                  <th className="p-3 text-left">สถานะ</th>
                  <th className="p-3 text-left">วันที่สร้าง</th>
                  <th className="p-3 text-left">การจัดการ</th>
                </tr>
              </thead>
              <tbody>
                {refunds.map((refund) => (
                  <tr key={refund.id} className="border-t">
                    <td className="p-3">
                      {(refund as any).or_orders?.bill_no || '-'}
                    </td>
                    <td className="p-3">
                      {(refund as any).or_orders?.customer_name || '-'}
                    </td>
                    <td className="p-3 font-bold text-green-600">
                      ฿{refund.amount.toLocaleString()}
                    </td>
                    <td className="p-3">{refund.reason}</td>
                    <td className="p-3">
                      <span
                        className={`px-2 py-1 rounded text-sm ${
                          refund.status === 'approved'
                            ? 'bg-green-100 text-green-700'
                            : refund.status === 'rejected'
                            ? 'bg-red-100 text-red-700'
                            : 'bg-yellow-100 text-yellow-700'
                        }`}
                      >
                        {refund.status === 'approved'
                          ? 'อนุมัติแล้ว'
                          : refund.status === 'rejected'
                          ? 'ปฏิเสธ'
                          : 'รออนุมัติ'}
                      </span>
                    </td>
                    <td className="p-3 text-sm text-gray-600">
                      {formatDateTime(refund.created_at)}
                    </td>
                    <td className="p-3">
                      {refund.status === 'pending' && (
                        <div className="flex gap-2">
                          <button
                            onClick={() => approveRefund(refund)}
                            className="px-3 py-1 bg-green-500 text-white rounded hover:bg-green-600 text-sm"
                          >
                            อนุมัติ
                          </button>
                          <button
                            onClick={() => rejectRefund(refund)}
                            className="px-3 py-1 bg-red-500 text-white rounded hover:bg-red-600 text-sm"
                          >
                            ปฏิเสธ
                          </button>
                        </div>
                      )}
                      {refund.status === 'approved' && (
                        <button
                          onClick={() => confirmRefundHistory(refund)}
                          className="px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 text-sm"
                        >
                          ยืนยัน
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Billing Requests: Tax Invoice */}
      <div className="bg-white p-6 rounded-lg shadow">
        <h2 className="text-xl font-bold mb-4">รายการขอใบกำกับภาษี</h2>
        {billingLoading ? (
          <div className="flex justify-center items-center py-12">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-500"></div>
          </div>
        ) : taxInvoiceOrders.length === 0 ? (
          <div className="text-center py-12 text-gray-500">ไม่พบรายการขอใบกำกับภาษี</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-100">
                <tr>
                  <th className="p-3 text-left">เลขบิล</th>
                  <th className="p-3 text-left">ลูกค้า</th>
                  <th className="p-3 text-left">ชื่อบริษัท</th>
                  <th className="p-3 text-left">TAX ID</th>
                  <th className="p-3 text-left">ที่อยู่</th>
                  <th className="p-3 text-left">ยอดก่อนภาษี</th>
                  <th className="p-3 text-left">ยอดสุทธิ</th>
                  <th className="p-3 text-left">สถานะ</th>
                  <th className="p-3 text-left">วันที่สร้าง</th>
                  <th className="p-3 text-left">การจัดการ</th>
                </tr>
              </thead>
              <tbody>
                {taxInvoiceOrders.map((o) => {
                  const bd = o.billing_details || {}
                  const total = Number(o.total_amount || 0)
                  const beforeVat = total ? total / 1.07 : 0
                  return (
                    <tr key={o.id} className="border-t">
                      <td className="p-3 font-semibold text-blue-700">{o.bill_no}</td>
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <span>{o.customer_name || '-'}</span>
                          {o.customer_name && (
                            <button
                              type="button"
                              onClick={() => copyToClipboard(o.customer_name || '')}
                              className="text-xs text-blue-600 hover:underline"
                            >
                              คัดลอก
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <span>{bd.tax_customer_name || '-'}</span>
                          {bd.tax_customer_name && (
                            <button
                              type="button"
                              onClick={() => copyToClipboard(bd.tax_customer_name || '')}
                              className="text-xs text-blue-600 hover:underline"
                            >
                              คัดลอก
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <span>{bd.tax_id || '-'}</span>
                          {bd.tax_id && (
                            <button
                              type="button"
                              onClick={() => copyToClipboard(bd.tax_id || '')}
                              className="text-xs text-blue-600 hover:underline"
                            >
                              คัดลอก
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="p-3 whitespace-pre-wrap">
                        <div className="flex items-start gap-2">
                          <span>{bd.tax_customer_address || '-'}</span>
                          {bd.tax_customer_address && (
                            <button
                              type="button"
                              onClick={() => copyToClipboard(bd.tax_customer_address || '')}
                              className="text-xs text-blue-600 hover:underline mt-0.5"
                            >
                              คัดลอก
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="p-3">
                        ฿{beforeVat ? beforeVat.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'}
                      </td>
                      <td className="p-3 font-bold text-green-600">
                        ฿{total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td className="p-3">
                        <span className="px-2 py-1 rounded text-sm bg-gray-100 text-gray-700">{o.status}</span>
                      </td>
                      <td className="p-3 text-sm text-gray-600">{formatDateTime(o.created_at)}</td>
                      <td className="p-3">
                        <button
                          type="button"
                          onClick={() => confirmTaxInvoice(o)}
                          className="px-3 py-1 bg-green-500 text-white rounded hover:bg-green-600 text-sm"
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
      </div>

      {/* Billing Requests: Cash Bill */}
      <div className="bg-white p-6 rounded-lg shadow">
        <h2 className="text-xl font-bold mb-4">รายการขอบิลเงินสด</h2>
        {billingLoading ? (
          <div className="flex justify-center items-center py-12">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-green-500"></div>
          </div>
        ) : cashBillOrders.length === 0 ? (
          <div className="text-center py-12 text-gray-500">ไม่พบรายการขอบิลเงินสด</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-100">
                <tr>
                  <th className="p-3 text-left">เลขบิล</th>
                  <th className="p-3 text-left">ลูกค้า</th>
                  <th className="p-3 text-left">ชื่อบริษัท</th>
                  <th className="p-3 text-left">ที่อยู่</th>
                  <th className="p-3 text-left">ยอดสุทธิ</th>
                  <th className="p-3 text-left">สถานะ</th>
                  <th className="p-3 text-left">วันที่สร้าง</th>
                  <th className="p-3 text-left">การจัดการ</th>
                </tr>
              </thead>
              <tbody>
                {cashBillOrders.map((o) => {
                  const bd = o.billing_details || {}
                  return (
                    <tr key={o.id} className="border-t">
                      <td className="p-3 font-semibold text-blue-700">{o.bill_no}</td>
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <span>{o.customer_name || '-'}</span>
                          {o.customer_name && (
                            <button
                              type="button"
                              onClick={() => copyToClipboard(o.customer_name || '')}
                              className="text-xs text-blue-600 hover:underline"
                            >
                              คัดลอก
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <span>{bd.tax_customer_name || '-'}</span>
                          {bd.tax_customer_name && (
                            <button
                              type="button"
                              onClick={() => copyToClipboard(bd.tax_customer_name || '')}
                              className="text-xs text-blue-600 hover:underline"
                            >
                              คัดลอก
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="p-3 whitespace-pre-wrap">
                        <div className="flex items-start gap-2">
                          <span>{bd.tax_customer_address || '-'}</span>
                          {bd.tax_customer_address && (
                            <button
                              type="button"
                              onClick={() => copyToClipboard(bd.tax_customer_address || '')}
                              className="text-xs text-blue-600 hover:underline mt-0.5"
                            >
                              คัดลอก
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="p-3 font-bold text-green-600">฿{Number(o.total_amount || 0).toLocaleString()}</td>
                      <td className="p-3">
                        <span className="px-2 py-1 rounded text-sm bg-gray-100 text-gray-700">{o.status}</span>
                      </td>
                      <td className="p-3 text-sm text-gray-600">{formatDateTime(o.created_at)}</td>
                      <td className="p-3">
                        <button
                          type="button"
                          onClick={() => confirmCashBill(o)}
                          className="px-3 py-1 bg-green-500 text-white rounded hover:bg-green-600 text-sm"
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
      </div>

      {/* History Section */}
      <div className="bg-white p-6 rounded-lg shadow">
        <h2 className="text-xl font-bold mb-4">ประวัติเอกสาร</h2>
        {historyLoading ? (
          <div className="flex justify-center items-center py-12">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-500"></div>
          </div>
        ) : (
          <div className="space-y-6">
            {/* History: Tax Invoices */}
            <div>
              <h3 className="text-lg font-semibold mb-3 text-blue-700">ประวัติใบกำกับภาษี ({historyTaxInvoices.length} รายการ)</h3>
              {historyTaxInvoices.length === 0 ? (
                <div className="text-center py-8 text-gray-500 text-sm">ไม่พบประวัติใบกำกับภาษี</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-100">
                      <tr>
                        <th className="p-2 text-left">เลขบิล</th>
                        <th className="p-2 text-left">ลูกค้า</th>
                        <th className="p-2 text-left">ชื่อบริษัท</th>
                        <th className="p-2 text-left">TAX ID</th>
                        <th className="p-2 text-left">ยอดสุทธิ</th>
                        <th className="p-2 text-left">วันที่ยืนยัน</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyTaxInvoices.map((o) => {
                        const bd = o.billing_details || {}
                        return (
                          <tr key={o.id} className="border-t">
                            <td className="p-2 font-semibold text-blue-700">{o.bill_no}</td>
                            <td className="p-2">{o.customer_name || '-'}</td>
                            <td className="p-2">{bd.tax_customer_name || '-'}</td>
                            <td className="p-2">{bd.tax_id || '-'}</td>
                            <td className="p-2 font-bold text-green-600">฿{Number(o.total_amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                            <td className="p-2 text-gray-600">{bd.account_confirmed_tax_at ? formatDateTime(bd.account_confirmed_tax_at) : '-'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* History: Cash Bills */}
            <div>
              <h3 className="text-lg font-semibold mb-3 text-green-700">ประวัติบิลเงินสด ({historyCashBills.length} รายการ)</h3>
              {historyCashBills.length === 0 ? (
                <div className="text-center py-8 text-gray-500 text-sm">ไม่พบประวัติบิลเงินสด</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-100">
                      <tr>
                        <th className="p-2 text-left">เลขบิล</th>
                        <th className="p-2 text-left">ลูกค้า</th>
                        <th className="p-2 text-left">ชื่อบริษัท</th>
                        <th className="p-2 text-left">ยอดสุทธิ</th>
                        <th className="p-2 text-left">วันที่ยืนยัน</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyCashBills.map((o) => {
                        const bd = o.billing_details || {}
                        return (
                          <tr key={o.id} className="border-t">
                            <td className="p-2 font-semibold text-blue-700">{o.bill_no}</td>
                            <td className="p-2">{o.customer_name || '-'}</td>
                            <td className="p-2">{bd.tax_customer_name || '-'}</td>
                            <td className="p-2 font-bold text-green-600">฿{Number(o.total_amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                            <td className="p-2 text-gray-600">{bd.account_confirmed_cash_at ? formatDateTime(bd.account_confirmed_cash_at) : '-'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* History: Refunds */}
            <div>
              <h3 className="text-lg font-semibold mb-3 text-orange-700">ประวัติรายการโอนคืน ({historyRefunds.length} รายการ)</h3>
              {historyRefunds.length === 0 ? (
                <div className="text-center py-8 text-gray-500 text-sm">ไม่พบประวัติรายการโอนคืน</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-100">
                      <tr>
                        <th className="p-2 text-left">เลขบิล</th>
                        <th className="p-2 text-left">ลูกค้า</th>
                        <th className="p-2 text-left">จำนวนเงิน</th>
                        <th className="p-2 text-left">เหตุผล</th>
                        <th className="p-2 text-left">วันที่อนุมัติ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyRefunds.map((refund) => (
                        <tr key={refund.id} className="border-t">
                          <td className="p-2">{(refund as any).or_orders?.bill_no || '-'}</td>
                          <td className="p-2">{(refund as any).or_orders?.customer_name || '-'}</td>
                          <td className="p-2 font-bold text-green-600">฿{refund.amount.toLocaleString()}</td>
                          <td className="p-2">{refund.reason}</td>
                          <td className="p-2 text-gray-600">{refund.approved_at ? formatDateTime(refund.approved_at) : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
