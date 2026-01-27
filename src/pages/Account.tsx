import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { Refund } from '../types'
import { formatDateTime } from '../lib/utils'
import { useAuthContext } from '../contexts/AuthContext'
import { getEasySlipQuota } from '../lib/slipVerification'

export default function Account() {
  const { user } = useAuthContext()
  const [refunds, setRefunds] = useState<Refund[]>([])
  const [loading, setLoading] = useState(true)
  const [easyslipQuota, setEasyslipQuota] = useState<number | null>(null)
  const [easyslipQuotaInfo, setEasyslipQuotaInfo] = useState<{
    usedQuota: number
    maxQuota: number
    remainingQuota: number
    expiredAt: string
    currentCredit: number
  } | null>(null)
  const [quotaLoading, setQuotaLoading] = useState(true)

  useEffect(() => {
    loadRefunds()
    loadEasySlipQuota()
  }, [])

  async function loadRefunds() {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('ac_refunds')
        .select('*, or_orders(bill_no, customer_name)')
        .order('created_at', { ascending: false })

      if (error) throw error
      setRefunds(data || [])
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
        setEasyslipQuota(result.data.remainingQuota)
        setEasyslipQuotaInfo(result.data)
      } else {
        console.error('[Account] Error loading EasySlip quota:', result.error)
        setEasyslipQuota(null)
        setEasyslipQuotaInfo(null)
      }
    } catch (error: any) {
      console.error('[Account] Exception loading EasySlip quota:', error)
      setEasyslipQuota(null)
      setEasyslipQuotaInfo(null)
    } finally {
      setQuotaLoading(false)
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
    } catch (error: any) {
      console.error('Error rejecting refund:', error)
      alert('เกิดข้อผิดพลาด: ' + error.message)
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

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
