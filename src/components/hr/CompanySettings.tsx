import { useCallback, useEffect, useMemo, useState } from 'react'
import type { HRCompany } from '../../types'
import { deleteHRCompanyAsset, fetchHRCompanies, uploadHRCompanyPng, upsertHRCompany } from '../../lib/payrollApi'

const emptyCompany = (): Partial<HRCompany> => ({
  company_key: '', name_th: '', name_en: '', address: '', tax_id: '', branch: 'สำนักงานใหญ่',
  phone: '', logo_url: '', signatory_name: '', signatory_title: '', signature_url: '', is_active: true,
})

export default function CompanySettings() {
  const [companies, setCompanies] = useState<HRCompany[]>([])
  const [form, setForm] = useState<Partial<HRCompany>>(emptyCompany())
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [signatureFile, setSignatureFile] = useState<File | null>(null)
  const logoPreview = useMemo(() => logoFile ? URL.createObjectURL(logoFile) : form.logo_url || '', [logoFile, form.logo_url])
  const signaturePreview = useMemo(() => signatureFile ? URL.createObjectURL(signatureFile) : form.signature_url || '', [signatureFile, form.signature_url])
  useEffect(() => () => { if (logoFile && logoPreview) URL.revokeObjectURL(logoPreview) }, [logoFile, logoPreview])
  useEffect(() => () => { if (signatureFile && signaturePreview) URL.revokeObjectURL(signaturePreview) }, [signatureFile, signaturePreview])

  const load = useCallback(async () => setCompanies(await fetchHRCompanies(true)), [])
  useEffect(() => { load().catch((e) => setMessage(e.message)) }, [load])

  const save = async () => {
    if (!form.company_key?.trim() || !form.name_th?.trim()) return setMessage('กรุณาระบุรหัสและชื่อบริษัท')
    setSaving(true)
    try {
      const companyKey = form.company_key.trim().toLowerCase()
      const [logoUrl, signatureUrl] = await Promise.all([
        logoFile ? uploadHRCompanyPng(companyKey, 'logo', logoFile) : Promise.resolve(form.logo_url || null),
        signatureFile ? uploadHRCompanyPng(companyKey, 'signature', signatureFile) : Promise.resolve(form.signature_url || null),
      ])
      await upsertHRCompany({ ...form, company_key: companyKey, name_th: form.name_th.trim(), logo_url: logoUrl, signature_url: signatureUrl })
      setMessage('บันทึกรายละเอียดบริษัทเรียบร้อย')
      setForm(emptyCompany())
      setLogoFile(null)
      setSignatureFile(null)
      await load()
    } catch (e) { setMessage(e instanceof Error ? e.message : 'บันทึกไม่สำเร็จ') }
    finally { setSaving(false) }
  }

  const field = 'mt-1 w-full rounded-xl border border-surface-200 px-3 py-2 text-sm'
  const chooseCompany = (company: HRCompany) => {
    setForm(company)
    setLogoFile(null)
    setSignatureFile(null)
  }
  const resetForm = () => {
    setForm(emptyCompany())
    setLogoFile(null)
    setSignatureFile(null)
  }
  const removeAsset = async (kind: 'logo' | 'signature') => {
    const isLogo = kind === 'logo'
    const selectedFile = isLogo ? logoFile : signatureFile
    if (selectedFile) {
      if (isLogo) setLogoFile(null)
      else setSignatureFile(null)
      return
    }
    const field = isLogo ? 'logo_url' : 'signature_url'
    const currentUrl = form[field]
    if (!currentUrl) return
    setSaving(true)
    setMessage('')
    try {
      await deleteHRCompanyAsset(currentUrl)
      if (form.id) await upsertHRCompany({ id: form.id, [field]: null })
      setForm((current) => ({ ...current, [field]: null }))
      setMessage(isLogo ? 'ลบโลโก้เรียบร้อย' : 'ลบลายเซ็นเรียบร้อย')
      await load()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'ลบรูปไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_460px]">
      <div className="rounded-xl border border-surface-200 bg-white overflow-hidden">
        <div className="px-4 py-3 bg-surface-50 border-b font-semibold">รายละเอียดบริษัทสำหรับระบบเงินเดือน</div>
        <div className="divide-y">
          {companies.map((company) => (
            <button key={company.id} type="button" onClick={() => chooseCompany(company)} className="w-full p-4 text-left hover:bg-emerald-50 flex gap-3 items-start">
              {company.logo_url ? <img src={company.logo_url} alt="" className="h-14 w-20 object-contain rounded border bg-white" /> : <div className="h-14 w-20 rounded bg-surface-100 flex items-center justify-center text-xs text-gray-400">LOGO</div>}
              <div className="min-w-0"><div className="font-semibold">{company.name_th}</div><div className="text-sm text-gray-500">{company.name_en || '-'}</div><div className="text-xs text-gray-500 mt-1">เลขผู้เสียภาษี {company.tax_id || '-'} · {company.phone || '-'}</div></div>
              <span className={`ml-auto text-xs rounded-full px-2 py-1 ${company.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>{company.is_active ? 'ใช้งาน' : 'ปิดใช้งาน'}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="rounded-xl border border-surface-200 bg-white p-4 space-y-3">
        <div className="flex justify-between items-center"><h3 className="font-semibold">{form.id ? 'แก้ไขบริษัท' : 'เพิ่มบริษัท'}</h3><button type="button" className="text-sm text-emerald-700" onClick={resetForm}>เพิ่มใหม่</button></div>
        {message && <div className="rounded-lg bg-blue-50 text-blue-700 px-3 py-2 text-sm">{message}</div>}
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">รหัสบริษัท *<input value={form.company_key || ''} disabled={!!form.id} onChange={(e) => setForm({ ...form, company_key: e.target.value })} className={field} placeholder="เช่น odf" /></label>
          <label className="text-sm">สาขา<input value={form.branch || ''} onChange={(e) => setForm({ ...form, branch: e.target.value })} className={field} /></label>
        </div>
        <label className="block text-sm">ชื่อบริษัท (ไทย) *<input value={form.name_th || ''} onChange={(e) => setForm({ ...form, name_th: e.target.value })} className={field} /></label>
        <label className="block text-sm">ชื่อบริษัท (อังกฤษ)<input value={form.name_en || ''} onChange={(e) => setForm({ ...form, name_en: e.target.value })} className={field} /></label>
        <label className="block text-sm">ที่อยู่<textarea value={form.address || ''} onChange={(e) => setForm({ ...form, address: e.target.value })} className={field} rows={3} /></label>
        <div className="grid grid-cols-2 gap-3"><label className="text-sm">เลขผู้เสียภาษี<input value={form.tax_id || ''} onChange={(e) => setForm({ ...form, tax_id: e.target.value })} className={field} /></label><label className="text-sm">โทรศัพท์<input value={form.phone || ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={field} /></label></div>
        <div className="text-sm">
          <span>โลโก้บริษัท (PNG)</span>
          <div className="mt-1 flex items-center gap-3 rounded-xl border border-dashed border-surface-300 p-3">
            {logoPreview ? <img src={logoPreview} alt="ตัวอย่างโลโก้" className="h-16 w-24 rounded border bg-white object-contain" /> : <div className="h-16 w-24 rounded bg-surface-100 flex items-center justify-center text-xs text-gray-400">LOGO</div>}
            <label className="cursor-pointer rounded-lg bg-blue-50 px-3 py-2 text-blue-700 font-medium hover:bg-blue-100">เลือกไฟล์ PNG<input type="file" accept="image/png,.png" className="hidden" onChange={(e) => setLogoFile(e.target.files?.[0] || null)} /></label>
            {(logoFile || form.logo_url) && <button type="button" disabled={saving} onClick={() => removeAsset('logo')} className="text-red-600 disabled:opacity-50">นำออก</button>}
          </div>
          <div className="mt-1 text-xs text-gray-500">แนะนำพื้นหลังโปร่งใส ขนาดไม่เกิน 5 MB</div>
        </div>
        <div className="grid grid-cols-2 gap-3"><label className="text-sm">ชื่อผู้จ่ายเงิน<input value={form.signatory_name || ''} onChange={(e) => setForm({ ...form, signatory_name: e.target.value })} className={field} /></label><label className="text-sm">ตำแหน่งผู้จ่ายเงิน<input value={form.signatory_title || ''} onChange={(e) => setForm({ ...form, signatory_title: e.target.value })} className={field} /></label></div>
        <div className="text-sm">
          <span>ลายเซ็นผู้จ่ายเงิน (PNG)</span>
          <div className="mt-1 flex items-center gap-3 rounded-xl border border-dashed border-surface-300 p-3">
            {signaturePreview ? <img src={signaturePreview} alt="ตัวอย่างลายเซ็น" className="h-16 w-24 rounded border bg-white object-contain" /> : <div className="h-16 w-24 rounded bg-surface-100 flex items-center justify-center text-xs text-gray-400">SIGN</div>}
            <label className="cursor-pointer rounded-lg bg-blue-50 px-3 py-2 text-blue-700 font-medium hover:bg-blue-100">เลือกไฟล์ PNG<input type="file" accept="image/png,.png" className="hidden" onChange={(e) => setSignatureFile(e.target.files?.[0] || null)} /></label>
            {(signatureFile || form.signature_url) && <button type="button" disabled={saving} onClick={() => removeAsset('signature')} className="text-red-600 disabled:opacity-50">นำออก</button>}
          </div>
          <div className="mt-1 text-xs text-gray-500">แนะนำพื้นหลังโปร่งใส ขนาดไม่เกิน 5 MB</div>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.is_active !== false} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />เปิดใช้งานบริษัทนี้</label>
        <button type="button" onClick={save} disabled={saving} className="w-full rounded-xl bg-emerald-600 text-white py-2.5 font-semibold disabled:opacity-50">{saving ? 'กำลังบันทึก...' : 'บันทึกบริษัท'}</button>
      </div>
    </div>
  )
}
