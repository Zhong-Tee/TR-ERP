import { useNavigate } from 'react-router-dom'
import type { AuditStatus, InventoryAudit } from '../../types'

interface AuditListProps {
  audits: InventoryAudit[]
  loading: boolean
  statusFilter: string
  onStatusFilterChange: (status: string) => void
  userMap: Record<string, string>
}

const STATUS_OPTIONS = [
  { value: '', label: 'ทั้งหมด' },
  { value: 'in_progress', label: 'กำลังนับ' },
  { value: 'review', label: 'รอรีวิว' },
  { value: 'completed', label: 'สร้างใบปรับสต๊อค' },
  { value: 'closed', label: 'ปิดแล้ว' },
]

function statusBadge(status: AuditStatus) {
  const map: Record<string, { bg: string; label: string }> = {
    draft: { bg: 'bg-gray-400', label: 'ร่าง' },
    in_progress: { bg: 'bg-blue-500', label: 'กำลังนับ' },
    review: { bg: 'bg-amber-500', label: 'รอรีวิว' },
    completed: { bg: 'bg-green-500', label: 'สร้างใบปรับสต๊อค' },
    closed: { bg: 'bg-gray-600', label: 'ปิดแล้ว' },
  }
  const s = map[status] || { bg: 'bg-gray-400', label: status }
  return (
    <span className={`inline-flex px-3 py-1 rounded-full text-xs font-bold text-white ${s.bg}`}>
      {s.label}
    </span>
  )
}

function auditTypeBadge(type: string | null | undefined) {
  const map: Record<string, string> = {
    full: 'ทั้งหมด',
    category: 'ตามหมวด',
    location: 'ตามจุดเก็บ',
    custom: 'กำหนดเอง',
    free_scan: 'สแกนอิสระ',
  }
  return map[type || ''] || type || '-'
}

export default function AuditList({
  audits,
  loading,
  statusFilter,
  onStatusFilterChange,
  userMap,
}: AuditListProps) {
  const navigate = useNavigate()

  const filtered = statusFilter
    ? audits.filter((a) => a.status === statusFilter)
    : audits

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100">
      {/* Filter */}
      <div className="p-4 border-b flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2 flex-wrap">
          {STATUS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => onStatusFilterChange(opt.value)}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                statusFilter === opt.value
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => navigate('/warehouse/audit/create')}
          className="px-4 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-semibold text-sm"
        >
          + สร้างใบ Audit
        </button>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-500" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-gray-400">ไม่มีรายการ Audit</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-blue-600 text-white">
                <th className="p-3 text-left font-semibold">เลขที่ Audit</th>
                <th className="p-3 text-left font-semibold">ประเภท</th>
                <th className="p-3 text-left font-semibold">สถานะ</th>
                <th className="p-3 text-right font-semibold">ความถูกต้อง</th>
                <th className="p-3 text-right font-semibold">จุดเก็บ</th>
                <th className="p-3 text-right font-semibold">Safety</th>
                <th className="p-3 text-center font-semibold">รายการ</th>
                <th className="p-3 text-left font-semibold">Auditor</th>
                <th className="p-3 text-left font-semibold">ผู้สร้าง</th>
                <th className="p-3 text-left font-semibold">วันที่</th>
                <th className="p-3 text-right font-semibold">การจัดการ</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((audit, idx) => (
                <tr
                  key={audit.id}
                  className={`border-b border-gray-100 hover:bg-blue-50/50 transition-colors ${
                    idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'
                  }`}
                >
                  <td className="p-3 font-medium">{audit.audit_no}</td>
                  <td className="p-3 text-xs text-gray-600">{auditTypeBadge(audit.audit_type)}</td>
                  <td className="p-3">{statusBadge(audit.status)}</td>
                  <td className="p-3 text-right font-medium">
                    {audit.accuracy_percent != null ? `${audit.accuracy_percent.toFixed(1)}%` : '-'}
                  </td>
                  <td className="p-3 text-right text-xs">
                    {audit.location_accuracy_percent != null ? `${audit.location_accuracy_percent.toFixed(1)}%` : '-'}
                  </td>
                  <td className="p-3 text-right text-xs">
                    {audit.safety_stock_accuracy_percent != null ? `${audit.safety_stock_accuracy_percent.toFixed(1)}%` : '-'}
                  </td>
                  <td className="p-3 text-center">{audit.total_items || 0}</td>
                  <td className="p-3 text-xs text-gray-600">
                    {audit.assigned_to && audit.assigned_to.length > 0
                      ? audit.assigned_to.map((uid) => userMap[uid] || uid).join(', ')
                      : '-'}
                  </td>
                  <td className="p-3 text-xs text-gray-600">
                    {audit.created_by ? (userMap[audit.created_by] || '-') : '-'}
                  </td>
                  <td className="p-3 text-xs text-gray-600">
                    {new Date(audit.created_at).toLocaleDateString('th-TH')}
                  </td>
                  <td className="p-3 text-right">
                    <div className="flex gap-1.5 justify-end">
                      {(audit.status === 'review' || audit.status === 'completed' || audit.status === 'closed') && (
                        <button
                          onClick={() => navigate(`/warehouse/audit/${audit.id}/review`)}
                          className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700"
                        >
                          ดูผล
                        </button>
                      )}
                      {audit.status === 'in_progress' && (
                        <button
                          onClick={() => navigate(`/warehouse/audit/${audit.id}/count`)}
                          className="px-3 py-1.5 bg-green-600 text-white rounded-lg text-xs font-semibold hover:bg-green-700"
                        >
                          ตรวจนับ
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
