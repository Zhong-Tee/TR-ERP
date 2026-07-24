import { useState, useEffect, useCallback } from 'react'
import { FiBox, FiMapPin, FiCalendar } from 'react-icons/fi'
import { fetchEmployeeByUserId, fetchAssets, getHRFileUrl } from '../../../lib/hrApi'
import { useAuthContext } from '../../../contexts/AuthContext'
import type { HRAsset } from '../../../types'

const BUCKET = 'hr-assets'

const STATUS: Record<string, [string, string]> = {
  active: ['bg-emerald-100 text-emerald-800', 'ใช้งาน'],
  borrowed: ['bg-blue-100 text-blue-800', 'ยืมใช้งาน'],
  maintenance: ['bg-amber-100 text-amber-800', 'ซ่อมบำรุง'],
  retired: ['bg-gray-100 text-gray-600', 'ปลดระวาง'],
  disposed: ['bg-purple-100 text-purple-800', 'จำหน่ายแล้ว'],
  lost: ['bg-red-100 text-red-800', 'สูญหาย'],
}

function statusBadge(status: string) {
  const [cls, label] = STATUS[status] ?? ['bg-gray-100 text-gray-600', status]
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}>{label}</span>
}

function thaiDate(d?: string): string {
  if (!d) return '-'
  return new Date(d + 'T00:00:00').toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function EmployeeAssets() {
  const { user } = useAuthContext()
  const [assets, setAssets] = useState<HRAsset[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!user?.id) return
    setLoading(true)
    try {
      const emp = await fetchEmployeeByUserId(user.id)
      if (!emp) {
        setLoading(false)
        return
      }
      setAssets(await fetchAssets({ assignedEmployeeId: emp.id }))
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [user?.id])

  useEffect(() => {
    load()
  }, [load])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-emerald-500 border-t-transparent" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
        <FiBox className="w-5 h-5 text-emerald-600" />
        ทรัพย์สินที่ถือครอง
      </h2>

      {assets.length === 0 ? (
        <div className="rounded-2xl bg-white border border-gray-200 p-6 text-center text-gray-500 text-sm">
          ยังไม่มีทรัพย์สินที่มอบหมายให้คุณ
        </div>
      ) : (
        <div className="space-y-3">
          {assets.map((a) => (
            <div key={a.id} className="rounded-2xl bg-white border border-gray-200 p-4 shadow-sm">
              <div className="flex gap-3">
                {/* แสดงเฉพาะรูปหลัก (รูปแรก) เท่านั้น — ไม่แสดงรูปอื่นและไฟล์เอกสาร */}
                {a.images?.[0] && (
                  <img
                    src={getHRFileUrl(BUCKET, a.images[0])}
                    alt={a.name}
                    className="h-20 w-20 shrink-0 rounded-lg border border-gray-100 object-cover"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-gray-900">{a.name}</p>
                      <p className="text-xs text-gray-400">
                        {a.asset_code || '-'}{a.category ? ` • ${a.category}` : ''}
                      </p>
                    </div>
                    {statusBadge(a.status)}
                  </div>
                  <div className="mt-2 space-y-1 text-sm text-gray-600">
                    {a.location && (
                      <p className="flex items-center gap-1.5">
                        <FiMapPin className="w-3.5 h-3.5 text-gray-400" /> {a.location}
                      </p>
                    )}
                    <p className="flex items-center gap-1.5">
                      <FiCalendar className="w-3.5 h-3.5 text-gray-400" /> รับเมื่อ {thaiDate(a.purchase_date)}
                    </p>
                    {a.notes && <p className="text-xs text-gray-500 mt-1">{a.notes}</p>}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
