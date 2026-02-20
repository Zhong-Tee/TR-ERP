import { useState, useEffect, useCallback } from 'react'
import { FiSearch, FiCalendar, FiUser, FiFileText, FiExternalLink } from 'react-icons/fi'
import {
  fetchLeaveRequests,
  updateLeaveRequest,
  fetchLeaveTypes,
  getHRFileUrl,
} from '../../lib/hrApi'
import type { HRLeaveRequest } from '../../types'
import Modal from '../ui/Modal'

const BUCKET_DOCS = 'hr-docs'

type StatusFilter = 'all' | 'pending' | 'approved' | 'rejected'

function statusBadgeClass(status: HRLeaveRequest['status']): string {
  switch (status) {
    case 'pending':
      return 'bg-amber-100 text-amber-800 border-amber-200'
    case 'approved':
      return 'bg-emerald-100 text-emerald-800 border-emerald-200'
    case 'rejected':
      return 'bg-red-100 text-red-800 border-red-200'
    case 'cancelled':
      return 'bg-gray-100 text-gray-600 border-gray-200'
    default:
      return 'bg-gray-100 text-gray-600 border-gray-200'
  }
}

function statusLabel(status: HRLeaveRequest['status']): string {
  const labels: Record<HRLeaveRequest['status'], string> = {
    pending: 'รอดำเนินการ',
    approved: 'อนุมัติ',
    rejected: 'ไม่อนุมัติ',
    cancelled: 'ยกเลิก',
  }
  return labels[status] ?? status
}

function employeeDisplayName(req: HRLeaveRequest): string {
  const emp = req.employee as { first_name?: string; last_name?: string; nickname?: string } | undefined
  if (!emp) return '-'
  const name = [emp.first_name, emp.last_name].filter(Boolean).join(' ')
  return emp.nickname ? `${name} (${emp.nickname})` : name
}

function medicalCertUrl(url: string | undefined): string | null {
  if (!url) return null
  if (url.startsWith('http')) return url
  return getHRFileUrl(BUCKET_DOCS, url)
}

export default function LeaveManagement() {
  const [requests, setRequests] = useState<HRLeaveRequest[]>([])
  const [, setLeaveTypes] = useState<Awaited<ReturnType<typeof fetchLeaveTypes>>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'list' | 'approval'>('list')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [searchName, setSearchName] = useState('')
  const [showCalendar, setShowCalendar] = useState(false)
  const [detailRequest, setDetailRequest] = useState<HRLeaveRequest | null>(null)
  const [rejectingId, setRejectingId] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [actionLoading, setActionLoading] = useState(false)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  /** Optional: pass current employee id for approved_by when approving (e.g. from auth context). */
  const currentEmployeeId: string | undefined = undefined

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [reqs, types] = await Promise.all([
        fetchLeaveRequests(),
        fetchLeaveTypes(),
      ])
      setRequests(reqs)
      setLeaveTypes(types)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'โหลดข้อมูลไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  const filteredRequests = requests.filter((req) => {
    if (activeTab === 'approval' && req.status !== 'pending') return false
    if (activeTab === 'list' && statusFilter !== 'all' && req.status !== statusFilter) return false
    if (searchName.trim()) {
      const name = employeeDisplayName(req).toLowerCase()
      if (!name.includes(searchName.trim().toLowerCase())) return false
    }
    return true
  })

  const pendingRequests = requests.filter((r) => r.status === 'pending')

  const handleApprove = async (id: string) => {
    setActionLoading(true)
    setError(null)
    try {
      await updateLeaveRequest(id, {
        status: 'approved',
        approved_by: currentEmployeeId ?? undefined,
        approved_at: new Date().toISOString(),
      })
      setSuccessMessage('อนุมัติการลาสำเร็จ')
      setRejectingId(null)
      setRejectReason('')
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'อนุมัติไม่สำเร็จ')
    } finally {
      setActionLoading(false)
    }
  }

  const handleReject = async () => {
    if (!rejectingId) return
    const reason = rejectReason.trim()
    if (!reason) {
      setError('กรุณาระบุเหตุผลในการไม่อนุมัติ')
      return
    }
    setActionLoading(true)
    setError(null)
    try {
      await updateLeaveRequest(rejectingId, {
        status: 'rejected',
        reject_reason: reason,
      })
      setSuccessMessage('ไม่อนุมัติการลาแล้ว')
      setRejectingId(null)
      setRejectReason('')
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ดำเนินการไม่สำเร็จ')
    } finally {
      setActionLoading(false)
    }
  }

  const openRejectModal = (id: string) => {
    setRejectingId(id)
    setRejectReason('')
    setError(null)
  }

  const closeRejectModal = () => {
    setRejectingId(null)
    setRejectReason('')
  }

  useEffect(() => {
    if (!successMessage) return
    const t = setTimeout(() => setSuccessMessage(null), 3000)
    return () => clearTimeout(t)
  }, [successMessage])

  return (
    <div className="space-y-6">
      <div className="rounded-xl bg-white shadow-soft border border-surface-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-surface-200 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setActiveTab('list')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === 'list'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-surface-100 text-surface-700 hover:bg-surface-200'
              }`}
            >
              คำขอลางาน
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('approval')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === 'approval'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-surface-100 text-surface-700 hover:bg-surface-200'
              }`}
            >
              อนุมัติการลา
              {pendingRequests.length > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full bg-amber-500 text-white text-xs">
                  {pendingRequests.length}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setShowCalendar(!showCalendar)}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-surface-100 text-surface-700 hover:bg-surface-200 transition-colors flex items-center gap-1.5"
            >
              <FiCalendar className="w-4 h-4" />
              ปฏิทิน (เร็วๆ นี้)
            </button>
          </div>
          {activeTab === 'list' && (
            <div className="flex items-center gap-3 flex-wrap">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                className="rounded-lg border border-surface-300 bg-white px-3 py-2 text-sm text-surface-800"
              >
                <option value="all">ทุกสถานะ</option>
                <option value="pending">รอดำเนินการ</option>
                <option value="approved">อนุมัติ</option>
                <option value="rejected">ไม่อนุมัติ</option>
              </select>
              <div className="relative">
                <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400" />
                <input
                  type="text"
                  placeholder="ค้นหาชื่อพนักงาน..."
                  value={searchName}
                  onChange={(e) => setSearchName(e.target.value)}
                  className="pl-9 pr-4 py-2 rounded-lg border border-surface-300 bg-white text-sm w-56"
                />
              </div>
            </div>
          )}
        </div>

        {error && (
          <div className="mx-6 mt-4 px-4 py-3 rounded-lg bg-red-50 text-red-800 text-sm border border-red-200">
            {error}
          </div>
        )}
        {successMessage && (
          <div className="mx-6 mt-4 px-4 py-3 rounded-lg bg-emerald-50 text-emerald-800 text-sm border border-emerald-200">
            {successMessage}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="animate-spin rounded-full h-10 w-10 border-2 border-surface-300 border-t-emerald-600" />
          </div>
        ) : activeTab === 'list' ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-surface-50 border-b border-surface-200">
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">พนักงาน</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">ประเภทลา</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">วันที่เริ่ม-สิ้นสุด</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">จำนวนวัน</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">เหตุผล</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">สถานะ</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">ใบรับรองแพทย์</th>
                </tr>
              </thead>
              <tbody>
                {filteredRequests.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-surface-500 text-sm">
                      ไม่มีรายการ
                    </td>
                  </tr>
                ) : (
                  filteredRequests.map((req) => (
                    <tr
                      key={req.id}
                      onClick={() => setDetailRequest(req)}
                      className="border-b border-surface-100 hover:bg-emerald-50/50 cursor-pointer transition-colors"
                    >
                      <td className="px-6 py-3 text-sm text-surface-800">{employeeDisplayName(req)}</td>
                      <td className="px-6 py-3 text-sm text-surface-700">
                        {(req.leave_type as { name?: string })?.name ?? '-'}
                      </td>
                      <td className="px-6 py-3 text-sm text-surface-700">
                        {req.start_date} – {req.end_date}
                      </td>
                      <td className="px-6 py-3 text-sm text-surface-700">{req.total_days}</td>
                      <td className="px-6 py-3 text-sm text-surface-700 max-w-[200px] truncate" title={req.reason ?? ''}>
                        {req.reason ?? '-'}
                      </td>
                      <td className="px-6 py-3">
                        <span
                          className={`inline-flex px-2.5 py-1 rounded-full text-xs font-medium border ${statusBadgeClass(req.status)}`}
                        >
                          {statusLabel(req.status)}
                        </span>
                      </td>
                      <td className="px-6 py-3">
                        {medicalCertUrl(req.medical_cert_url) ? (
                          <a
                            href={medicalCertUrl(req.medical_cert_url)!}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-emerald-600 hover:underline text-sm"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <FiExternalLink className="w-4 h-4" /> ดูไฟล์
                          </a>
                        ) : (
                          <span className="text-surface-400 text-sm">-</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-6">
            {filteredRequests.length === 0 ? (
              <p className="text-center text-surface-500 py-12">ไม่มีคำขอที่รอดำเนินการ</p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {filteredRequests.map((req) => (
                  <div
                    key={req.id}
                    className="rounded-xl border border-surface-200 bg-white p-4 shadow-soft hover:shadow-md transition-shadow"
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex-shrink-0 w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-700">
                        <FiUser className="w-6 h-6" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-surface-800">{employeeDisplayName(req)}</p>
                        <p className="text-sm text-surface-600 mt-0.5">
                          {(req.leave_type as { name?: string })?.name ?? '-'} · {req.total_days} วัน
                        </p>
                        <p className="text-sm text-surface-600">
                          {req.start_date} – {req.end_date}
                        </p>
                        <p className="text-sm text-surface-700 mt-2 line-clamp-2">{req.reason ?? '-'}</p>
                        <div className="flex items-center gap-2 mt-4">
                          <button
                            type="button"
                            onClick={() => handleApprove(req.id)}
                            disabled={actionLoading}
                            className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
                          >
                            อนุมัติ
                          </button>
                          <button
                            type="button"
                            onClick={() => openRejectModal(req.id)}
                            disabled={actionLoading}
                            className="px-3 py-1.5 rounded-lg bg-red-100 text-red-700 text-sm font-medium hover:bg-red-200 disabled:opacity-50"
                          >
                            ไม่อนุมัติ
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Detail modal */}
      <Modal
        open={!!detailRequest}
        onClose={() => setDetailRequest(null)}
        contentClassName="max-w-lg"
        closeOnBackdropClick
      >
        {detailRequest && (
          <div className="p-6">
            <h3 className="text-lg font-semibold text-surface-800 mb-4">รายละเอียดคำขอลา</h3>
            <div className="space-y-3 text-sm">
              <p><span className="text-surface-500">พนักงาน:</span> {employeeDisplayName(detailRequest)}</p>
              <p><span className="text-surface-500">ประเภทลา:</span> {(detailRequest.leave_type as { name?: string })?.name ?? '-'}</p>
              <p><span className="text-surface-500">วันที่:</span> {detailRequest.start_date} – {detailRequest.end_date} ({detailRequest.total_days} วัน)</p>
              <p><span className="text-surface-500">เหตุผล:</span> {detailRequest.reason ?? '-'}</p>
              <p>
                <span className="text-surface-500">สถานะ:</span>{' '}
                <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium border ${statusBadgeClass(detailRequest.status)}`}>
                  {statusLabel(detailRequest.status)}
                </span>
              </p>
              {detailRequest.reject_reason && (
                <p><span className="text-surface-500">เหตุผลไม่อนุมัติ:</span> {detailRequest.reject_reason}</p>
              )}
              {medicalCertUrl(detailRequest.medical_cert_url) && (
                <p>
                  <a
                    href={medicalCertUrl(detailRequest.medical_cert_url)!}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-emerald-600 hover:underline inline-flex items-center gap-1"
                  >
                    <FiFileText className="w-4 h-4" /> ใบรับรองแพทย์
                  </a>
                </p>
              )}
            </div>
            <div className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={() => setDetailRequest(null)}
                className="px-4 py-2 rounded-lg bg-surface-100 text-surface-700 hover:bg-surface-200 text-sm font-medium"
              >
                ปิด
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Reject reason modal */}
      <Modal
        open={!!rejectingId}
        onClose={closeRejectModal}
        contentClassName="max-w-md"
        closeOnBackdropClick
      >
        <div className="p-6">
          <h3 className="text-lg font-semibold text-surface-800 mb-2">เหตุผลในการไม่อนุมัติ</h3>
          <p className="text-sm text-surface-600 mb-4">กรุณาระบุเหตุผล (จำเป็น)</p>
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="เหตุผล..."
            rows={4}
            className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm text-surface-800 placeholder:text-surface-400"
          />
          <div className="flex justify-end gap-2 mt-4">
            <button
              type="button"
              onClick={closeRejectModal}
              className="px-4 py-2 rounded-lg bg-surface-100 text-surface-700 hover:bg-surface-200 text-sm font-medium"
            >
              ยกเลิก
            </button>
            <button
              type="button"
              onClick={handleReject}
              disabled={actionLoading || !rejectReason.trim()}
              className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50"
            >
              ยืนยันไม่อนุมัติ
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
