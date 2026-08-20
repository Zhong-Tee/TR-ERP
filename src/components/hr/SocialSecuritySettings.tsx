import { useEffect, useState } from 'react'
import { useAuthContext } from '../../contexts/AuthContext'
import {
  fetchSocialSecuritySettings,
  upsertSocialSecuritySettings,
} from '../../lib/payrollApi'

const normalizeDecimal = (value: string) => {
  const cleaned = value.replace(/,/g, '').replace(/[^\d.]/g, '')
  const [whole = '', ...decimals] = cleaned.split('.')
  return decimals.length ? `${whole}.${decimals.join('')}` : whole
}

export default function SocialSecuritySettings() {
  const { user } = useAuthContext()
  const [rate, setRate] = useState('5')
  const [maximumWageBase, setMaximumWageBase] = useState('17500')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    fetchSocialSecuritySettings()
      .then((settings) => {
        setRate(String(settings.contribution_rate))
        setMaximumWageBase(String(settings.maximum_wage_base))
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

  if (loading) return <div className="py-12 text-center text-gray-500">กำลังโหลด...</div>

  const preview = (Number(maximumWageBase) || 0) * (Number(rate) || 0) / 100

  return (
    <div className="max-w-xl rounded-xl border border-surface-200 bg-white p-5 space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">ตั้งค่าการหักประกันสังคม</h2>
        <p className="mt-1 text-sm text-gray-500">ใช้คำนวณยอดหักประกันสังคมในเมนูบัญชี → เงินเดือนโดยอัตโนมัติ</p>
      </div>
      {error && <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {message && <div className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div>}
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
  )
}
