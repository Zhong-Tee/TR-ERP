import { useState, useEffect, useCallback } from 'react'
import { FiTrash2, FiPlus } from 'react-icons/fi'
import { fetchSalaryHistory, addSalaryHistory, deleteSalaryHistory } from '../../lib/hrApi'
import type { LatestSalary } from '../../lib/hrApi'
import type { HRSalaryHistory } from '../../types'

interface SalaryHistoryPanelProps {
  employeeId: string
  /** แสดงฟอร์มเพิ่ม/ปุ่มลบ (เฉพาะผู้ดูแล) */
  editable?: boolean
  /** แจ้งเงินเดือนล่าสุดเมื่อมีการเพิ่ม/ลบ เพื่อให้ตัวแม่ sync ค่า */
  onLatestSalaryChange?: (latest: LatestSalary | null) => void
}

const fieldClass =
  'w-full px-3 py-2 border border-gray-300 rounded-lg outline-none transition-colors focus:border-emerald-600 focus:ring-2 focus:ring-emerald-500/35 focus:outline-none'

function formatBaht(n: number): string {
  return n.toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}

export default function SalaryHistoryPanel({
  employeeId,
  editable = false,
  onLatestSalaryChange,
}: SalaryHistoryPanelProps) {
  const [items, setItems] = useState<HRSalaryHistory[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [salaryInput, setSalaryInput] = useState('')
  const [allowanceInput, setAllowanceInput] = useState('')
  const [effectiveDate, setEffectiveDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setItems(await fetchSalaryHistory(employeeId))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'โหลดประวัติเงินเดือนไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }, [employeeId])

  useEffect(() => {
    load()
  }, [load])

  const handleAdd = async () => {
    const digits = salaryInput.replace(/\D/g, '')
    const allowanceDigits = allowanceInput.replace(/\D/g, '')
    if (!digits || !effectiveDate) return
    setSaving(true)
    setError(null)
    try {
      const latest = await addSalaryHistory({
        employee_id: employeeId,
        salary: Number(digits),
        position_allowance: allowanceDigits ? Number(allowanceDigits) : undefined,
        effective_date: effectiveDate,
        note: note.trim() || undefined,
      })
      onLatestSalaryChange?.(latest)
      setSalaryInput('')
      setAllowanceInput('')
      setNote('')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึกไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    setError(null)
    try {
      const latest = await deleteSalaryHistory(id, employeeId)
      onLatestSalaryChange?.(latest)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ลบไม่สำเร็จ')
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>
      )}

      {editable && (
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_1fr_1.5fr_auto] gap-3 items-end rounded-xl border border-gray-200 bg-gray-50 p-3">
          <label>
            <span className="block text-sm font-medium text-gray-700 mb-1">ฐานเงินเดือน</span>
            <input
              type="text"
              inputMode="numeric"
              value={salaryInput === '' ? '' : Number(salaryInput.replace(/\D/g, '') || 0).toLocaleString('en-US')}
              onChange={(e) => setSalaryInput(e.target.value.replace(/\D/g, ''))}
              placeholder="เช่น 15,000"
              className={fieldClass}
            />
          </label>
          <label>
            <span className="block text-sm font-medium text-gray-700 mb-1">เงินพิเศษ/ประจำตำแหน่ง</span>
            <input
              type="text"
              inputMode="numeric"
              value={allowanceInput === '' ? '' : Number(allowanceInput.replace(/\D/g, '') || 0).toLocaleString('en-US')}
              onChange={(e) => setAllowanceInput(e.target.value.replace(/\D/g, ''))}
              placeholder="เช่น 2,000"
              className={fieldClass}
            />
          </label>
          <label>
            <span className="block text-sm font-medium text-gray-700 mb-1">วันที่มีผล</span>
            <input
              type="date"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
              className={fieldClass}
            />
          </label>
          <label>
            <span className="block text-sm font-medium text-gray-700 mb-1">หมายเหตุ</span>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="เช่น ปรับขึ้นประจำปี, ผ่านทดลองงาน"
              className={fieldClass}
            />
          </label>
          <button
            type="button"
            onClick={handleAdd}
            disabled={saving || !salaryInput.replace(/\D/g, '') || !effectiveDate}
            className="inline-flex items-center justify-center gap-1 px-4 py-2 bg-emerald-600 text-white rounded-lg font-medium hover:bg-emerald-700 disabled:opacity-50 h-[42px]"
          >
            <FiPlus /> เพิ่ม
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-emerald-500 border-t-transparent" />
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-gray-500 text-sm">
          ยังไม่มีประวัติเงินเดือน
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left py-2.5 px-3 text-xs font-semibold text-gray-700 whitespace-nowrap">วันที่มีผล</th>
                <th className="text-right py-2.5 px-3 text-xs font-semibold text-gray-700 whitespace-nowrap">ฐานเงินเดือน (บาท)</th>
                <th className="text-right py-2.5 px-3 text-xs font-semibold text-gray-700 whitespace-nowrap">เงินพิเศษ/ประจำตำแหน่ง (บาท)</th>
                <th className="text-right py-2.5 px-3 text-xs font-semibold text-gray-700 whitespace-nowrap">รวม (บาท)</th>
                <th className="text-left py-2.5 px-3 text-xs font-semibold text-gray-700 whitespace-nowrap">หมายเหตุ</th>
                {editable && <th className="w-12" />}
              </tr>
            </thead>
            <tbody>
              {items.map((item, idx) => (
                <tr key={item.id} className="border-b border-gray-100 last:border-0">
                  <td className="py-2.5 px-3 text-sm text-gray-700 whitespace-nowrap">
                    {new Date(item.effective_date).toLocaleDateString('th-TH')}
                    {idx === 0 && (
                      <span className="ml-2 inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-700">
                        ล่าสุด
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 px-3 text-sm text-gray-900 text-right tabular-nums">
                    {formatBaht(Number(item.salary))}
                  </td>
                  <td className="py-2.5 px-3 text-sm text-gray-900 text-right tabular-nums">
                    {item.position_allowance != null ? formatBaht(Number(item.position_allowance)) : '-'}
                  </td>
                  <td className="py-2.5 px-3 text-sm text-gray-900 text-right font-medium tabular-nums">
                    {formatBaht(Number(item.salary) + Number(item.position_allowance ?? 0))}
                  </td>
                  <td className="py-2.5 px-3 text-sm text-gray-600">{item.note || '-'}</td>
                  {editable && (
                    <td className="py-2.5 px-2 text-right">
                      <button
                        type="button"
                        onClick={() => handleDelete(item.id)}
                        className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
                        title="ลบ"
                      >
                        <FiTrash2 />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
