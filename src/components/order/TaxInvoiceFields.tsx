import { useEffect, useState, useRef } from 'react'
import { supabase } from '../../lib/supabase'
import { getAddressByZip, parseAddressText, type SubDistrictOption } from '../../lib/thaiAddress'
import { emptyTaxAddress, extractTaxIdentity, formatTaxAddress, normalizeTaxId, validTaxId, splitTaxAddressLine, resolveTaxLocality, type TaxAddress } from '../../lib/taxInvoice'

export interface TaxInvoiceFieldsValue { company_name: string; address: string; tax_id: string; branch?: string; tax_address?: TaxAddress }
type Props = { value: TaxInvoiceFieldsValue; onChange: (value: TaxInvoiceFieldsValue) => void; disabled?: boolean }
type RegistryRecord = { tax_id: string; company_name: string; branch: string; tax_address: TaxAddress }
type Result = { key: string; status: 'loading' | 'found' | 'not_found' | 'unavailable'; reason?: string; records?: RegistryRecord[] }
const fields: [keyof TaxAddress, string][] = [['house_number','บ้านเลขที่'],['building','อาคาร'],['floor','ชั้น'],['room','ห้อง'],['moo','หมู่'],['village','หมู่บ้าน'],['soi','ซอย'],['road','ถนน']]
export default function TaxInvoiceFields({ value, onChange, disabled }: Props) {
  const latest = useRef(value)
  latest.current = value
  const [autoFilling,setAutoFilling] = useState(false)
  const [raw, setRaw] = useState('')
  const [notice, setNotice] = useState('')
  const [candidates, setCandidates] = useState<string[]>([])
  const [options, setOptions] = useState<SubDistrictOption[]>([])
  const [result, setResult] = useState<Result | null>(null)
  const [retry, setRetry] = useState(0)
  const a = value.tax_address || emptyTaxAddress()
  const branch = value.branch ?? '00000'
  const key = `${value.tax_id}:${branch}`
  const updateAddress = (patch: Partial<TaxAddress>) => {
    const next = { ...a, ...patch }
    onChange({ ...value, tax_address: next, address: formatTaxAddress(next) })
  }
  useEffect(() => {
    let active = true
    setOptions([])
    if (/^\d{5}$/.test(a.postal_code)) {
      getAddressByZip(a.postal_code, supabase).then(r => { if (active) setOptions(r.options.filter(o => o.district).filter((o,i,all)=>all.findIndex(other=>other.subDistrict===o.subDistrict && other.district===o.district && other.province===o.province)===i)) }).catch(() => { if (active) setOptions([]) })
    }
    return () => { active = false }
  }, [a.postal_code])
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    if (!validTaxId(value.tax_id) || !/^\d{5}$/.test(branch) || disabled) return
    const timer = setTimeout(async () => {
      setResult({ key, status: 'loading' })
      const timeout = setTimeout(() => controller.abort(), 12000)
      try {
        const { data, error } = await supabase.functions.invoke('rd-vat-lookup', { body: { taxId: value.tax_id, branch }, signal: controller.signal })
        if (error) {
          const status = error.context instanceof Response ? error.context.status : undefined
          const reason = status === 404 ? 'ยังไม่พบบริการ rd-vat-lookup กรุณาตรวจสอบการ deploy Edge Function'
            : status === 401 ? 'บริการไม่ยอมรับการเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่แล้วลองอีกครั้ง'
            : status === 403 ? 'บัญชีนี้ไม่มีสิทธิ์ตรวจทะเบียน VAT'
            : status && status >= 500 ? 'บริการตรวจทะเบียน VAT ขัดข้องหรือหมดเวลารอ'
            : 'เชื่อมต่อบริการตรวจทะเบียน VAT ไม่ได้ กรุณาตรวจสอบการ deploy rd-vat-lookup และการเชื่อมต่อ'
          if (active) setResult({ key, status: 'unavailable', reason })
          return
        }
        if (!data || !['found', 'not_found'].includes(data.status)) throw new Error('lookup failed')
        if (active) setResult({ key, status: data.status, records: data.records })
      } catch { if (active) setResult({ key, status: 'unavailable', reason: 'เชื่อมต่อบริการตรวจทะเบียน VAT ไม่ได้ กรุณาตรวจสอบการ deploy rd-vat-lookup และการเชื่อมต่อ' }) }
      finally { clearTimeout(timeout) }
    }, 1000)
    return () => { active = false; clearTimeout(timer); controller.abort() }
  }, [value.tax_id, branch, key, retry, disabled])
  async function autofill() {
    setNotice('กำลังแยกข้อมูล…')
    setAutoFilling(true)
    const original=latest.current
    try {
      const identity = extractTaxIdentity(raw)
      const parsed = await parseAddressText(identity.addressText, supabase)
      if(latest.current !== original) { setNotice('ข้อมูลถูกแก้ระหว่างรอ กรุณากดแยกข้อมูลอีกครั้ง'); return }
      const next = { ...emptyTaxAddress(), ...splitTaxAddressLine(parsed.addressLine), postal_code: parsed.postalCode }
      const selected = resolveTaxLocality(identity.addressText, parsed.subDistrictOptions || [])
      if (selected) Object.assign(next, { sub_district: selected.subDistrict, district: selected.district, province: selected.province || parsed.province })
      // Preserve locality text until the user resolves an ambiguous postcode.
      const unresolvedAddress = parsed.recipientName && identity.addressText.startsWith(parsed.recipientName)
        ? identity.addressText.slice(parsed.recipientName.length).trim() : identity.addressText
      setCandidates(identity.taxId ? [] : identity.candidates)
      onChange({ ...value, company_name: parsed.recipientName || value.company_name, tax_id: identity.taxId || value.tax_id, tax_address: next, address: selected ? formatTaxAddress(next) : unresolvedAddress })
      setNotice(selected ? 'แยกข้อมูลแล้ว กรุณาตรวจชื่อ เลขภาษี และที่อยู่ก่อนบันทึก' : 'แยกข้อมูลแล้ว แต่ยังระบุที่อยู่ได้ไม่แน่ชัด กรุณาเลือกตำบล / แขวงก่อนบันทึก')
    } catch { setNotice('แยกข้อมูลไม่ได้ กรุณากรอกเองหรือลองใหม่') } finally {setAutoFilling(false)}
  }
  const current = validTaxId(value.tax_id) && /^\d{5}$/.test(branch) && result?.key === key ? result : null
  return <div className="space-y-3">
    <div className="grid grid-cols-1 items-stretch gap-x-4 gap-y-3 md:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-2 md:col-start-1 md:row-start-1">
        <div className="flex items-center justify-between gap-2"><label htmlFor="tax-autofill-text">วางข้อมูลเต็มเพื่อ Auto Fill</label><button type="button" disabled={disabled || autoFilling || !raw.trim()} onClick={() => void autofill()} className="tax-autofill-action shrink-0 rounded-md bg-blue-100 px-2 py-0.5 text-sm leading-5 text-blue-800 disabled:opacity-50">แยกข้อมูล</button></div>
        <textarea id="tax-autofill-text" rows={6} disabled={disabled} value={raw} onChange={e => setRaw(e.target.value)} className="block min-h-[10rem] w-full flex-1 rounded border p-2" />
        {notice && <p role="status" className="text-sm text-blue-700">{notice}</p>}
      </div>
      <div className="flex min-w-0 flex-col gap-2 md:col-start-2 md:row-start-1">
        <div className="flex flex-wrap items-center justify-between gap-2"><h4>ข้อมูลจากกรมสรรพากร</h4><div className="flex flex-wrap gap-1">{current?.status === 'found' && current.records?.map((record, i) => <button key={i} type="button" disabled={disabled} onClick={() => onChange({ ...value, ...record, address: formatTaxAddress(record.tax_address) })} className="tax-autofill-action shrink-0 rounded-md bg-blue-100 px-2 py-0.5 text-sm leading-5 text-blue-800 disabled:opacity-50">ใช้ข้อมูล{current.records!.length > 1 ? ` (${record.branch})` : ''}</button>)}</div></div>
        <div role="status" className="tax-registry-result min-h-[10rem] min-w-0 flex-1 space-y-2 break-words rounded border bg-white p-3">
          {!current && <p className="text-sm text-gray-500">กรอกเลขภาษีที่ถูกต้องครบ 13 หลัก ระบบจะค้นทะเบียน VAT ให้อัตโนมัติ</p>}
      {current?.status === 'loading' && 'กำลังตรวจสอบ…'}
      {current?.status === 'not_found' && 'ไม่พบข้อมูลในทะเบียน VAT สามารถกรอกเองได้ ผลนี้ไม่ได้ยืนยันว่าเลขภาษีผิด'}
      {current?.status === 'unavailable' && <>ยังตรวจสอบไม่ได้{current.reason && <p className="text-sm text-amber-800">{current.reason}</p>} <button type="button" onClick={() => setRetry(n => n + 1)} className="text-blue-700 underline">ตรวจสอบอีกครั้ง</button></>}
      {current?.status === 'found' && current.records?.map((record, i) => <div key={i} className="space-y-2"><p>กรมสรรพากร: {record.company_name} · สาขา {record.branch}</p><p>{formatTaxAddress(record.tax_address)}</p></div>)}
        </div>
      </div>
    </div>
    {!!candidates.length && <label className="block">พบเลขที่อาจเป็นเลขภาษี กรุณาเลือกยืนยัน<select disabled={disabled} value="" onChange={e => { onChange({ ...value, tax_id: e.target.value }); setCandidates([]) }} className="w-full rounded border p-2"><option value="">เลือกเลขภาษี</option>{candidates.map(id => <option key={id}>{id}</option>)}</select></label>}
    <div className="grid grid-cols-2 gap-3">
      <label className="col-span-2 min-w-0">เลขประจำตัวผู้เสียภาษี<input disabled={disabled} value={value.tax_id} onChange={e => onChange({ ...value, tax_id: normalizeTaxId(e.target.value) })} className="w-full rounded border p-2" />{value.tax_id && !validTaxId(value.tax_id) && <span className="text-sm text-red-700">เลขภาษีต้องเป็นตัวเลข 13 หลักและเลขตรวจสอบถูกต้อง</span>}</label>
      <label className="col-span-2 min-w-0">ชื่อลูกค้า / บริษัท<input disabled={disabled} value={value.company_name} onChange={e => onChange({ ...value, company_name: e.target.value })} className="w-full rounded border p-2" /></label>
      <label className="min-w-0">สำนักงานใหญ่ / เลขสาขา<input disabled={disabled} inputMode="numeric" maxLength={5} value={branch} onChange={e => onChange({ ...value, branch: e.target.value.replace(/\D/g, '') })} className="w-full rounded border p-2" /><span className="text-xs">สำนักงานใหญ่ใช้ 00000; สาขาใช้เลข 5 หลัก</span></label>
      {fields.map(([field, label]) => <label key={field} className="min-w-0">{label}<input disabled={disabled} value={a[field] || ''} onChange={e => updateAddress({ [field]: e.target.value, legacy_text: undefined })} className="w-full rounded border p-2" /></label>)}
      <label className="min-w-0">รหัสไปรษณีย์<input disabled={disabled} inputMode="numeric" maxLength={5} value={a.postal_code} onChange={e => updateAddress({ postal_code: e.target.value.replace(/\D/g, ''), sub_district: '', district: '', province: '' })} className="w-full rounded border p-2" />{a.postal_code && !/^\d{5}$/.test(a.postal_code) && <span className="text-red-700">กรอกตัวเลข 5 หลัก</span>}</label>
      <label className="min-w-0">ตำบล / แขวง<select disabled={disabled || !options.length} value={options.findIndex(o => o.subDistrict === a.sub_district && o.district === a.district)} onChange={e => { const selected = options[Number(e.target.value)]; if (selected) updateAddress({ sub_district: selected.subDistrict, district: selected.district, province: selected.province || '' }) }} className="w-full rounded border p-2"><option value={-1}>เลือกตำบล / แขวง</option>{options.map((o, i) => <option key={`${o.subDistrict}:${o.district}:${o.province}`} value={i}>{o.subDistrict} — {o.district}</option>)}</select>{a.postal_code.length === 5 && !options.length && <span className="text-sm text-amber-800">ยังโหลดรายการที่อยู่ไม่ได้ กรุณาลองใหม่ หรือใช้ที่อยู่เดิม</span>}</label>
      <label className="min-w-0">อำเภอ / เขต<input readOnly value={a.district} className="w-full rounded border bg-gray-100 p-2" /></label>
      <label className="min-w-0">จังหวัด<input readOnly value={a.province} className="w-full rounded border bg-gray-100 p-2" /></label>
    </div>
    <div className="space-y-1">
      <h4>ที่อยู่สำหรับใบกำกับภาษี</h4>
      {value.tax_address ? (
        <output aria-label="ที่อยู่สำหรับใบกำกับภาษี" className="block min-h-[3rem] whitespace-pre-wrap break-words rounded border bg-white p-3">{value.address || 'กรอกข้อมูลที่อยู่ด้านบนเพื่อแสดงที่อยู่สำหรับใบกำกับภาษี'}</output>
      ) : (
        <textarea aria-label="ที่อยู่สำหรับใบกำกับภาษี" disabled={disabled} value={value.address} onChange={e => onChange({ ...value, address: e.target.value })} className="w-full rounded border p-2" />
      )}
    </div>

  </div>
}
