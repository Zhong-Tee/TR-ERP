import { useEffect, useState } from 'react'
import { useAuthContext } from '../../contexts/AuthContext'
import {
  fetchHRCompanies,
  fetchSocialSecuritySettings,
  upsertHRCompany,
  upsertSocialSecuritySettings,
} from '../../lib/payrollApi'
import type { HRCompany } from '../../types'

const normalizeDecimal = (value: string) => {
  const cleaned = value.replace(/,/g, '').replace(/[^\d.]/g, '')
  const [whole = '', ...decimals] = cleaned.split('.')
  return decimals.length ? `${whole}.${decimals.join('')}` : whole
}

export default function SocialSecuritySettings() {
  const { user } = useAuthContext()
  const [rate, setRate] = useState('5')
  const [maximumWageBase, setMaximumWageBase] = useState('17500')
  const [companies, setCompanies] = useState<HRCompany[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savingCompanyId, setSavingCompanyId] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([fetchSocialSecuritySettings(), fetchHRCompanies()])
      .then(([settings, companyRows]) => {
        setRate(String(settings.contribution_rate))
        setMaximumWageBase(String(settings.maximum_wage_base))
        setCompanies(companyRows)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'โหลดการตั้งค่าไม่สำเร็จ'))
      .finally(() => setLoading(false))
  }, [])

  const save = async () => {
    const contributionRate = Number(rate)
    const wageBase = Number(maximumWageBase)
    if (!Number.isFinite(contributionRate) || contributionRate < 0 || contributionRate > 100) {
      setError('อัตราเปอร์เซ็นต์ต้องอยู่ระหว่าง 0 ถึง 100')
      return
    }
    if (!Number.isFinite(wageBase) || wageBase < 0) {
      setError('ฐานค่าจ้างสูงสุดต้องไม่น้อยกว่า 0')
      return
    }
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const saved = await upsertSocialSecuritySettings({
        contribution_rate: contributionRate,
        maximum_wage_base: wageBase,
      }, user?.id)
      setRate(String(saved.contribution_rate))
      setMaximumWageBase(String(saved.maximum_wage_base))
      setMessage('บันทึกการตั้งค่าการหักประกันสังคมเรียบร้อย')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึกการตั้งค่าไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  const toggleCompanyEwf = async (company: HRCompany) => {
    const nextEnabled = company.ewf_enabled === false
    setSavingCompanyId(company.id)
    setError('')
    setMessage('')
    try {
      const saved = await upsertHRCompany({ id: company.id, ewf_enabled: nextEnabled })
      setCompanies((rows) => rows.map((row) => row.id === saved.id ? { ...row, ...saved } : row))
      setMessage(`${nextEnabled ? 'เปิด' : 'ปิด'}การหัก EWF สำหรับ ${company.name_th} แล้ว`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึกการตั้งค่า EWF ไม่สำเร็จ')
    } finally {
      setSavingCompanyId('')
    }
  }

  if (loading) return <div className="py-12 text-center text-gray-500">กำลังโหลด...</div>

  const preview = (Number(maximumWageBase) || 0) * (Number(rate) || 0) / 100

  return (
    <div className="max-w-2xl space-y-5">
      {error && <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {message && <div className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div>}
      <div className="rounded-xl border border-surface-200 bg-white p-5 space-y-5">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">ตั้งค่าการหักประกันสังคม</h2>
          <p className="mt-1 text-sm text-gray-500">ใช้คำนวณยอดหักประกันสังคมในเมนูบัญชี → เงินเดือนโดยอัตโนมัติ</p>
        </div>
        <label className="block text-sm">
          <span className="font-medium text-gray-700">อัตราเปอร์เซ็นต์</span>
          <div className="relative mt-1">
            <input
              type="text"
              inputMode="decimal"
              value={rate}
              onChange={(e) => setRate(normalizeDecimal(e.target.value))}
              placeholder="เช่น 5"
              className="w-full rounded-xl border border-surface-200 px-3 py-2 pr-10"
            />
            <span className="absolute inset-y-0 right-3 flex items-center text-gray-500">%</span>
          </div>
        </label>
        <label className="block text-sm">
          <span className="font-medium text-gray-700">ฐานค่าจ้างสูงสุด</span>
          <input
            type="text"
            inputMode="decimal"
            value={maximumWageBase ? Number(maximumWageBase).toLocaleString('en-US') : ''}
            onChange={(e) => setMaximumWageBase(normalizeDecimal(e.target.value))}
            placeholder="เช่น 17,500"
            className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2"
          />
        </label>
        <div className="rounded-xl bg-blue-50 px-4 py-3 text-sm text-blue-800">
          ยอดหักสูงสุดต่อเดือน: <strong>{preview.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท</strong>
        </div>
        <div className="flex justify-end">
          <button type="button" onClick={save} disabled={saving} className="rounded-xl bg-emerald-600 px-5 py-2 text-white hover:bg-emerald-700 disabled:opacity-50">
            {saving ? 'กำลังบันทึก...' : 'บันทึกการตั้งค่า'}
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-surface-200 bg-white p-5 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">การหักกองทุนสงเคราะห์ลูกจ้าง (EWF)</h2>
          <p className="mt-1 text-sm text-gray-500">เปิดหรือปิดการคำนวณ EWF แยกตามบริษัท โดย EMP00001 จะไม่ถูกหัก EWF ทุกกรณี</p>
        </div>
        <div className="divide-y overflow-hidden rounded-xl border border-surface-200">
          {companies.map((company) => {
            const enabled = company.ewf_enabled !== false
            const companySaving = savingCompanyId === company.id
            return (
              <div key={company.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div>
                  <div className="font-medium text-gray-900">{company.name_th}</div>
                  {company.name_en && <div className="text-xs text-gray-500">{company.name_en}</div>}
                </div>
                <div className="flex items-center gap-3">
                  <span className={`rounded-full px-3 py-1 text-xs font-semibold ${enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-600'}`}>
                    {enabled ? 'เปิดการหัก' : 'ปิดการหัก'}
                  </span>
                  <button
                    type="button"
                    aria-pressed={enabled}
                    onClick={() => toggleCompanyEwf(company)}
                    disabled={companySaving || !!savingCompanyId}
                    className={`min-w-24 rounded-xl border px-4 py-2 text-sm font-medium disabled:opacity-50 ${enabled ? 'border-red-200 text-red-700 hover:bg-red-50' : 'border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700'}`}
                  >
                    {companySaving ? 'กำลังบันทึก...' : enabled ? 'ปิดการหัก' : 'เปิดการหัก'}
                  </button>
                </div>
              </div>
            )
          })}
          {!companies.length && <div className="px-4 py-6 text-center text-sm text-gray-500">ไม่พบบริษัทที่เปิดใช้งาน</div>}
        </div>
      </div>
    </div>
  )
}
