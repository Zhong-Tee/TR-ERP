import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../../lib/supabase'
import { fetchAllSupabasePages } from '../../lib/supabasePagination'
import {
  normalizeCarrierName,
  normalizeShippingAddressPart,
  SHIPPING_AREA_TYPE_LABELS,
  type ShippingAreaRule,
  type ShippingAreaType,
} from '../../lib/shippingAreaRules'
import Modal from '../ui/Modal'

type ChannelOption = { channel_code: string; channel_name: string; default_carrier?: string | null }
type AddressOption = { postalCode: string; province: string; district: string; subDistrict: string }
type RuleDraft = Omit<ShippingAreaRule, 'id'> & { id?: string }
type ImportPreviewRow = { rowNumber: number; draft: RuleDraft; errors: string[]; action: 'new' | 'update' | 'error' }

const TEMPLATE_HEADERS = [
  'ผู้ให้บริการ', 'ประเภทพื้นที่', 'ช่องทางขาย', 'รหัสไปรษณีย์', 'จังหวัด', 'เขต/อำเภอ', 'แขวง/ตำบล',
  'ค่าขนส่งเพิ่ม', 'วันที่เริ่มต้น', 'วันที่สิ้นสุด', 'ตลอดไป', 'สถานะ',
] as const

const emptyDraft = (): RuleDraft => ({
  carrier: 'Flash Express',
  area_type: 'remote',
  channel_codes: [],
  postal_code: '',
  province: '',
  district: '',
  sub_district: '',
  surcharge: 0,
  is_forever: true,
  start_date: null,
  end_date: null,
  is_active: true,
})

function normalizeText(value: unknown) {
  return String(value ?? '').trim()
}

function normalizedRuleKey(rule: RuleDraft | ShippingAreaRule) {
  return [
    normalizeText(rule.carrier).toLowerCase(),
    rule.area_type,
    [...(rule.channel_codes || [])].map((code) => code.trim().toUpperCase()).sort().join(','),
    normalizeShippingAddressPart(rule.postal_code, 'postal_code'),
    normalizeShippingAddressPart(rule.province, 'province'),
    normalizeShippingAddressPart(rule.district, 'district'),
    normalizeShippingAddressPart(rule.sub_district, 'sub_district'),
    rule.is_forever ? 'forever' : `${rule.start_date || ''}:${rule.end_date || ''}`,
  ].join('|')
}

function parseBoolean(value: unknown, fallback: boolean) {
  const normalized = normalizeText(value).toLowerCase()
  if (!normalized) return fallback
  if (['ใช่', 'ตลอดไป', 'ใช้งาน', 'true', '1', 'yes', 'y'].includes(normalized)) return true
  if (['ไม่', 'ไม่ใช่', 'ไม่ใช้งาน', 'ปิด', 'ปิดใช้งาน', 'false', '0', 'no', 'n'].includes(normalized)) return false
  return fallback
}

function parseAreaType(value: unknown): ShippingAreaType | null {
  const normalized = normalizeText(value).toLowerCase()
  if (normalized === 'remote' || normalized === 'พื้นที่ห่างไกล') return 'remote'
  if (normalized === 'special_tourism' || normalized === 'พื้นที่ท่องเที่ยวพิเศษ') return 'special_tourism'
  return null
}

function parseDate(value: unknown): string | null {
  if (!value) return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear()
    const month = String(value.getMonth() + 1).padStart(2, '0')
    const day = String(value.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }
  const text = normalizeText(value)
  const iso = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/)
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`
  const thai = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/)
  if (thai) return `${thai[3]}-${thai[2].padStart(2, '0')}-${thai[1].padStart(2, '0')}`
  return null
}

function similarity(a: string, b: string) {
  const left = a.toLowerCase()
  const right = b.toLowerCase()
  const matrix = Array.from({ length: left.length + 1 }, (_, index) => [index])
  for (let index = 0; index <= right.length; index += 1) matrix[0][index] = index
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      matrix[row][column] = left[row - 1] === right[column - 1]
        ? matrix[row - 1][column - 1]
        : Math.min(matrix[row - 1][column - 1], matrix[row][column - 1], matrix[row - 1][column]) + 1
    }
  }
  return matrix[left.length][right.length]
}

function closestSuggestion(value: string, candidates: string[]) {
  if (!value || candidates.length === 0) return ''
  const unique = [...new Set(candidates.filter(Boolean))]
  return unique.sort((a, b) => similarity(value, a) - similarity(value, b))[0] || ''
}

function formatMoney(value: number) {
  return Number(value || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 })
}

export default function ShippingAreaRulesPanel({ channels }: { channels: ChannelOption[] }) {
  const [rules, setRules] = useState<ShippingAreaRule[]>([])
  const [addresses, setAddresses] = useState<AddressOption[]>([])
  const [editor, setEditor] = useState<RuleDraft | null>(null)
  const [previewRows, setPreviewRows] = useState<ImportPreviewRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [addressLoading, setAddressLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [search, setSearch] = useState('')
  const [isListCollapsed, setIsListCollapsed] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  async function loadRules() {
    setLoading(true)
    setMessage('')
    try {
      const { data, error } = await supabase.from('or_shipping_area_rules').select('*').order('province').order('district').order('sub_district')
      if (error) throw error
      setRules((data || []).map((row) => ({ ...row, surcharge: Number(row.surcharge || 0) })) as ShippingAreaRule[])
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'โหลดข้อมูลพื้นที่พิเศษไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }

  async function loadAddresses(): Promise<AddressOption[]> {
    if (addresses.length) return addresses
    setAddressLoading(true)
    try {
      type AddressRow = {
        id: number
        zip_code: string
        name_th: string
        thai_districts?: { name_th?: string | null; thai_provinces?: { name_th?: string | null } | Array<{ name_th?: string | null }> | null } | Array<{ name_th?: string | null; thai_provinces?: { name_th?: string | null } | Array<{ name_th?: string | null }> | null }> | null
      }
      const rows = await fetchAllSupabasePages<AddressRow>(async (from, to) => {
        const result = await supabase
          .from('thai_sub_districts')
          .select('id, zip_code, name_th, thai_districts(name_th, thai_provinces(name_th))')
          .order('id')
          .range(from, to)
        return { data: (result.data || []) as unknown as AddressRow[], error: result.error }
      })
      type AliasRow = {
        zip_code: string
        thai_sub_districts?: {
          name_th?: string | null
          thai_districts?: AddressRow['thai_districts']
        } | Array<{
          name_th?: string | null
          thai_districts?: AddressRow['thai_districts']
        }> | null
      }
      const aliasResult = await supabase
        .from('thai_sub_district_postal_aliases')
        .select('zip_code, thai_sub_districts(name_th, thai_districts(name_th, thai_provinces(name_th)))')
        .order('id')
      const aliasRows = aliasResult.error ? [] : (aliasResult.data || []) as unknown as AliasRow[]
      const loaded = rows.map((row) => {
        const district = Array.isArray(row.thai_districts) ? row.thai_districts[0] : row.thai_districts
        const province = Array.isArray(district?.thai_provinces) ? district?.thai_provinces[0] : district?.thai_provinces
        return {
          postalCode: row.zip_code,
          province: province?.name_th || '',
          district: district?.name_th || '',
          subDistrict: row.name_th,
        }
      })
      const aliases = aliasRows.map((row) => {
        const subDistrict = Array.isArray(row.thai_sub_districts) ? row.thai_sub_districts[0] : row.thai_sub_districts
        const district = Array.isArray(subDistrict?.thai_districts) ? subDistrict?.thai_districts[0] : subDistrict?.thai_districts
        const province = Array.isArray(district?.thai_provinces) ? district?.thai_provinces[0] : district?.thai_provinces
        return {
          postalCode: row.zip_code,
          province: province?.name_th || '',
          district: district?.name_th || '',
          subDistrict: subDistrict?.name_th || '',
        }
      })
      const unique = [...new Map([...loaded, ...aliases]
        .filter((row) => row.postalCode && row.province && row.district && row.subDistrict)
        .map((row) => [`${row.postalCode}|${row.province}|${row.district}|${row.subDistrict}`, row])).values()]
      setAddresses(unique)
      return unique
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'โหลดตัวเลือกที่อยู่ไม่สำเร็จ')
      return []
    } finally {
      setAddressLoading(false)
    }
  }

  useEffect(() => { void loadRules() }, [])

  async function openNewEditor() {
    setMessage('')
    if ((await loadAddresses()).length) setEditor({ ...emptyDraft(), carrier: carrierOptions[0] || 'Flash Express' })
  }

  async function openRuleEditor(rule: ShippingAreaRule) {
    setMessage('')
    if ((await loadAddresses()).length) setEditor({ ...rule })
  }

  async function chooseImportFile() {
    setMessage('')
    if ((await loadAddresses()).length) fileInputRef.current?.click()
  }

  const filteredRules = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    if (!keyword) return rules
    return rules.filter((rule) => `${rule.carrier} ${SHIPPING_AREA_TYPE_LABELS[rule.area_type]} ${(rule.channel_codes || []).join(' ')} ${rule.postal_code || ''} ${rule.province} ${rule.district} ${rule.sub_district || ''}`.toLowerCase().includes(keyword))
  }, [rules, search])
  const carrierOptions = useMemo(() => [...new Set(channels.map((channel) => channel.default_carrier || '').filter(Boolean))].sort(), [channels])

  const postalCodes = useMemo(() => [...new Set(addresses.map((row) => row.postalCode))].sort(), [addresses])
  const matchingPostalAddresses = useMemo(() => editor?.postal_code
    ? addresses.filter((row) => row.postalCode === normalizeShippingAddressPart(editor.postal_code, 'postal_code'))
    : addresses, [addresses, editor?.postal_code])
  const provinces = useMemo(() => [...new Set(matchingPostalAddresses.map((row) => row.province))].sort(), [matchingPostalAddresses])
  const districts = useMemo(() => [...new Set(matchingPostalAddresses
    .filter((row) => !editor?.province || normalizeShippingAddressPart(row.province, 'province') === normalizeShippingAddressPart(editor.province, 'province'))
    .map((row) => row.district))].sort(), [matchingPostalAddresses, editor?.province])
  const subDistricts = useMemo(() => [...new Set(matchingPostalAddresses
    .filter((row) => (!editor?.province || normalizeShippingAddressPart(row.province, 'province') === normalizeShippingAddressPart(editor.province, 'province'))
      && (!editor?.district || normalizeShippingAddressPart(row.district, 'district') === normalizeShippingAddressPart(editor.district, 'district')))
    .map((row) => row.subDistrict))].sort(), [matchingPostalAddresses, editor?.province, editor?.district])

  function validateAddress(draft: RuleDraft) {
    const errors: string[] = []
    const postalCode = normalizeShippingAddressPart(draft.postal_code, 'postal_code')
    if (postalCode && postalCode.length !== 5) errors.push('รหัสไปรษณีย์ต้องมี 5 หลัก หรือเว้นว่างเพื่อใช้ทั้งอำเภอ')
    if (!draft.province.trim()) errors.push('กรุณาเลือกจังหวัด')
    if (!draft.district.trim()) errors.push('กรุณาเลือกเขต/อำเภอ')
    const matching = postalCode ? addresses.filter((row) => row.postalCode === postalCode) : addresses
    if (postalCode.length === 5 && matching.length === 0) errors.push(`ไม่พบรหัสไปรษณีย์ ${postalCode} ในฐานข้อมูล`)
    if (matching.length && !matching.some((row) => normalizeShippingAddressPart(row.province, 'province') === normalizeShippingAddressPart(draft.province, 'province'))) {
      const suggestion = closestSuggestion(draft.province, matching.map((row) => row.province))
      errors.push(`จังหวัด “${draft.province}” ไม่สัมพันธ์กับรหัสไปรษณีย์${suggestion ? ` — แนะนำ “${suggestion}”` : ''}`)
    }
    const districtMatches = matching.filter((row) => normalizeShippingAddressPart(row.province, 'province') === normalizeShippingAddressPart(draft.province, 'province'))
    if (districtMatches.length && !districtMatches.some((row) => normalizeShippingAddressPart(row.district, 'district') === normalizeShippingAddressPart(draft.district, 'district'))) {
      const suggestion = closestSuggestion(draft.district, districtMatches.map((row) => row.district))
      errors.push(`ไม่พบเขต/อำเภอ “${draft.district}”${suggestion ? ` — แนะนำ “${suggestion}”` : ''}`)
    }
    if (draft.sub_district) {
      const subMatches = districtMatches.filter((row) => normalizeShippingAddressPart(row.district, 'district') === normalizeShippingAddressPart(draft.district, 'district'))
      if (!subMatches.some((row) => normalizeShippingAddressPart(row.subDistrict, 'sub_district') === normalizeShippingAddressPart(draft.sub_district, 'sub_district'))) {
        const suggestion = closestSuggestion(draft.sub_district, subMatches.map((row) => row.subDistrict))
        errors.push(`ไม่พบแขวง/ตำบล “${draft.sub_district}”${suggestion ? ` — แนะนำ “${suggestion}”` : ''}`)
      }
    }
    return errors
  }

  function validateDraft(draft: RuleDraft) {
    const errors = validateAddress(draft)
    if (!draft.carrier.trim()) errors.push('กรุณากรอกผู้ให้บริการ')
    else if (carrierOptions.length && !carrierOptions.some((carrier) => normalizeCarrierName(carrier) === normalizeCarrierName(draft.carrier))) {
      const suggestion = closestSuggestion(draft.carrier, carrierOptions)
      errors.push(`ไม่พบผู้ให้บริการ “${draft.carrier}”${suggestion ? ` — แนะนำ “${suggestion}”` : ''}`)
    }
    if (!Number.isFinite(Number(draft.surcharge)) || Number(draft.surcharge) < 0) errors.push('ค่าขนส่งเพิ่มต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป')
    if (!draft.is_forever && (!draft.start_date || !draft.end_date)) errors.push('กรุณากรอกวันที่เริ่มต้นและสิ้นสุด หรือเลือกตลอดไป')
    if (!draft.is_forever && draft.start_date && draft.end_date && draft.end_date < draft.start_date) errors.push('วันที่สิ้นสุดต้องไม่น้อยกว่าวันที่เริ่มต้น')
    return errors
  }

  async function saveEditor() {
    if (!editor) return
    const errors = validateDraft(editor)
    if (rules.some((rule) => rule.id !== editor.id && normalizedRuleKey(rule) === normalizedRuleKey(editor))) {
      errors.push('มีกฎพื้นที่ ช่องทาง และช่วงเวลานี้อยู่แล้ว')
    }
    if (errors.length) { setMessage(errors.join(' · ')); return }
    setSaving(true)
    setMessage('')
    const payload = {
      carrier: editor.carrier.trim(),
      area_type: editor.area_type,
      channel_codes: editor.channel_codes || [],
      postal_code: normalizeShippingAddressPart(editor.postal_code, 'postal_code') || null,
      province: editor.province.trim(),
      district: editor.district.trim(),
      sub_district: editor.sub_district?.trim() || null,
      surcharge: Math.max(0, Number(editor.surcharge) || 0),
      is_forever: editor.is_forever,
      start_date: editor.is_forever ? null : editor.start_date,
      end_date: editor.is_forever ? null : editor.end_date,
      is_active: editor.is_active,
      updated_at: new Date().toISOString(),
    }
    try {
      const result = editor.id
        ? await supabase.from('or_shipping_area_rules').update(payload).eq('id', editor.id)
        : await supabase.from('or_shipping_area_rules').insert(payload)
      if (result.error) throw result.error
      setEditor(null)
      await loadRules()
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'บันทึกพื้นที่พิเศษไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  async function toggleRule(rule: ShippingAreaRule) {
    const { error } = await supabase.from('or_shipping_area_rules').update({ is_active: !rule.is_active, updated_at: new Date().toISOString() }).eq('id', rule.id)
    if (error) setMessage(error.message)
    else setRules((current) => current.map((item) => item.id === rule.id ? { ...item, is_active: !item.is_active } : item))
  }

  async function deleteRule(rule: ShippingAreaRule) {
    if (!window.confirm(`ลบกฎพื้นที่ “${rule.sub_district || rule.district}” ใช่หรือไม่?`)) return
    const { error } = await supabase.from('or_shipping_area_rules').delete().eq('id', rule.id)
    if (error) setMessage(error.message)
    else setRules((current) => current.filter((item) => item.id !== rule.id))
  }

  function downloadTemplate() {
    const workbook = XLSX.utils.book_new()
    const sample = XLSX.utils.aoa_to_sheet([
      Array.from(TEMPLATE_HEADERS),
      [carrierOptions[0] || 'Flash Express', 'พื้นที่ห่างไกล', 'FBTR, OATR', '71180', 'กาญจนบุรี', 'ทองผาภูมิ', 'ปิล๊อก', 50, '', '', 'ใช่', 'ใช้งาน'],
      [carrierOptions[0] || 'Flash Express', 'พื้นที่ท่องเที่ยวพิเศษ', '', '20150', 'ชลบุรี', 'บางละมุง', 'นาเกลือ', 300, '2026-01-01', '2026-12-31', 'ไม่', 'ใช้งาน'],
    ])
    sample['!cols'] = TEMPLATE_HEADERS.map((header) => ({ wch: Math.max(header.length + 4, 16) }))
    XLSX.utils.book_append_sheet(workbook, sample, 'พื้นที่พิเศษ')
    const guide = XLSX.utils.aoa_to_sheet([
      ['หัวข้อ', 'รายละเอียด'],
      ['ช่องทางขาย', 'กรอกได้หลายช่องทางโดยคั่นด้วยเครื่องหมายจุลภาค เช่น FBTR, OATR และเว้นว่างเพื่อใช้ทุกช่องทาง'],
      ['รหัสไปรษณีย์', 'เว้นว่างเพื่อให้กฎครอบคลุมทุกรหัสไปรษณีย์ในเขต/อำเภอที่ระบุ'],
      ['แขวง/ตำบล', 'เว้นว่างเพื่อใช้ทั้งเขต/อำเภอ'],
      ['ตลอดไป', 'กรอก “ใช่” เพื่อไม่จำกัดช่วงเวลา หรือกรอก “ไม่” พร้อมวันที่เริ่มต้นและสิ้นสุด'],
      ['วันที่', 'รูปแบบ YYYY-MM-DD'],
      ['ชื่อพื้นที่', 'ต้องตรงกับฐานข้อมูลที่อยู่ ระบบจะแจ้งชื่อที่ไม่ตรงในหน้า Preview'],
    ])
    guide['!cols'] = [{ wch: 24 }, { wch: 95 }]
    XLSX.utils.book_append_sheet(workbook, guide, 'คู่มือการกรอก')
    XLSX.writeFile(workbook, 'Template_ค่าขนส่งพื้นที่พิเศษ.xlsx')
  }

  async function handleImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setMessage('')
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
      const sheet = workbook.Sheets['พื้นที่พิเศษ'] || workbook.Sheets[workbook.SheetNames[0]]
      if (!sheet) throw new Error('ไม่พบ Sheet สำหรับนำเข้า')
      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: true })
        .filter((row) => TEMPLATE_HEADERS.some((header) => normalizeText(row[header])))
      if (!rawRows.length) throw new Error('ไม่พบข้อมูลสำหรับนำเข้า')
      const validChannels = new Set(channels.map((channel) => channel.channel_code.toUpperCase()))
      const existingByKey = new Map(rules.map((rule) => [normalizedRuleKey(rule), rule]))
      const seenKeys = new Set<string>()
      const preview = rawRows.map((row, index): ImportPreviewRow => {
        const areaType = parseAreaType(row['ประเภทพื้นที่'])
        const channelCodes = normalizeText(row['ช่องทางขาย']).split(',').map((code) => code.trim().toUpperCase()).filter(Boolean)
        const forever = parseBoolean(row['ตลอดไป'], true)
        const startDate = parseDate(row['วันที่เริ่มต้น'])
        const endDate = parseDate(row['วันที่สิ้นสุด'])
        const draft: RuleDraft = {
          carrier: normalizeText(row['ผู้ให้บริการ']) || 'Flash Express',
          area_type: areaType || 'remote',
          channel_codes: channelCodes,
          postal_code: normalizeShippingAddressPart(row['รหัสไปรษณีย์'], 'postal_code'),
          province: normalizeText(row['จังหวัด']),
          district: normalizeText(row['เขต/อำเภอ']),
          sub_district: normalizeText(row['แขวง/ตำบล']),
          surcharge: Number(row['ค่าขนส่งเพิ่ม']),
          is_forever: forever,
          start_date: forever ? null : startDate,
          end_date: forever ? null : endDate,
          is_active: parseBoolean(row['สถานะ'], true),
        }
        const errors = validateDraft(draft)
        if (!areaType) errors.push(`ประเภทพื้นที่ “${normalizeText(row['ประเภทพื้นที่'])}” ไม่ถูกต้อง`)
        const invalidChannels = channelCodes.filter((code) => !validChannels.has(code))
        if (invalidChannels.length) errors.push(`ไม่พบช่องทางขาย ${invalidChannels.join(', ')}`)
        if (!forever && normalizeText(row['วันที่เริ่มต้น']) && !startDate) errors.push('รูปแบบวันที่เริ่มต้นไม่ถูกต้อง')
        if (!forever && normalizeText(row['วันที่สิ้นสุด']) && !endDate) errors.push('รูปแบบวันที่สิ้นสุดไม่ถูกต้อง')
        const key = normalizedRuleKey(draft)
        if (seenKeys.has(key)) errors.push('ข้อมูลซ้ำกับแถวก่อนหน้าในไฟล์')
        seenKeys.add(key)
        const existing = existingByKey.get(key)
        if (existing) draft.id = existing.id
        return { rowNumber: index + 2, draft, errors, action: errors.length ? 'error' : existing ? 'update' : 'new' }
      })
      setPreviewRows(preview)
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'อ่านไฟล์ Excel ไม่สำเร็จ')
    }
  }

  async function importPreview() {
    if (!previewRows || previewRows.some((row) => row.errors.length)) return
    setSaving(true)
    setMessage('')
    try {
      for (const row of previewRows) {
        const draft = row.draft
        const payload = {
          carrier: draft.carrier.trim(), area_type: draft.area_type, channel_codes: draft.channel_codes || [],
          postal_code: normalizeShippingAddressPart(draft.postal_code, 'postal_code') || null, province: draft.province.trim(),
          district: draft.district.trim(), sub_district: draft.sub_district?.trim() || null,
          surcharge: Math.max(0, Number(draft.surcharge) || 0), is_forever: draft.is_forever,
          start_date: draft.is_forever ? null : draft.start_date, end_date: draft.is_forever ? null : draft.end_date,
          is_active: draft.is_active, updated_at: new Date().toISOString(),
        }
        const result = draft.id
          ? await supabase.from('or_shipping_area_rules').update(payload).eq('id', draft.id)
          : await supabase.from('or_shipping_area_rules').insert(payload)
        if (result.error) throw new Error(`แถว ${row.rowNumber}: ${result.error.message}`)
      }
      setPreviewRows(null)
      await loadRules()
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'นำเข้าข้อมูลไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="rounded-xl border border-violet-200 bg-violet-50/30 p-4 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h3 className="font-bold text-slate-900">ค่าขนส่งพื้นที่ห่างไกล/พื้นที่ท่องเที่ยวพิเศษ</h3><p className="mt-1 text-xs text-slate-500">บวกค่าขนส่งเพิ่มเมื่อช่องทางและที่อยู่ในหน้าเปิดบิลตรงกับกฎ</p></div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setIsListCollapsed((collapsed) => !collapsed)} aria-expanded={!isListCollapsed} className="rounded-lg border border-violet-300 bg-white px-3 py-2 text-sm font-semibold text-violet-700 hover:bg-violet-50">
            {isListCollapsed ? 'แสดงรายการ' : 'หุบรายการ'}
          </button>
          <button type="button" onClick={downloadTemplate} className="rounded-lg border border-violet-300 bg-white px-3 py-2 text-sm font-semibold text-violet-700 hover:bg-violet-50">ดาวน์โหลด Template</button>
          <button type="button" onClick={() => void chooseImportFile()} disabled={addressLoading} className="rounded-lg border border-violet-300 bg-white px-3 py-2 text-sm font-semibold text-violet-700 hover:bg-violet-50 disabled:cursor-wait disabled:opacity-50">{addressLoading ? 'กำลังโหลดที่อยู่...' : 'นำเข้า Excel'}</button>
          <button type="button" onClick={() => void openNewEditor()} disabled={addressLoading} className="rounded-lg bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:cursor-wait disabled:opacity-50">+ เพิ่มพื้นที่</button>
          <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleImportFile} className="hidden" />
        </div>
      </div>
      {message && <div className="whitespace-pre-wrap rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{message}</div>}
      {!isListCollapsed && <>
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ค้นหา ผู้ให้บริการ ช่องทาง รหัสไปรษณีย์ จังหวัด อำเภอ หรือตำบล" className="w-full rounded-lg border bg-white px-3 py-2 text-sm" />
        <div className="overflow-x-auto rounded-xl border bg-white">
        <table className="w-full min-w-[1050px] text-sm">
          <thead className="bg-violet-600 text-white"><tr><th className="p-3 text-left">ผู้ให้บริการ/ประเภท</th><th className="p-3 text-left">ช่องทางขาย</th><th className="p-3 text-left">พื้นที่</th><th className="p-3 text-right">ค่าขนส่งเพิ่ม</th><th className="p-3 text-left">ช่วงเวลา</th><th className="p-3 text-center">สถานะ</th><th className="p-3 text-right">จัดการ</th></tr></thead>
          <tbody>{filteredRules.map((rule) => <tr key={rule.id} className="border-t hover:bg-violet-50/40">
            <td className="p-3"><b className="block">{rule.carrier}</b><small className="text-gray-500">{SHIPPING_AREA_TYPE_LABELS[rule.area_type]}</small></td>
            <td className="p-3">{rule.channel_codes?.length ? rule.channel_codes.join(', ') : 'ทุกช่องทาง'}</td>
            <td className="p-3"><b>{rule.postal_code || 'ทุกไปรษณีย์'}</b> · {rule.sub_district ? `ต.${rule.sub_district} ` : 'ทุกตำบล · '}{rule.district} · {rule.province}</td>
            <td className="p-3 text-right font-bold tabular-nums">+{formatMoney(rule.surcharge)} บาท</td>
            <td className="p-3">{rule.is_forever ? 'ตลอดไป' : `${rule.start_date} – ${rule.end_date}`}</td>
            <td className="p-3 text-center"><button type="button" onClick={() => void toggleRule(rule)} className={`rounded-full px-3 py-1 text-xs font-semibold ${rule.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>{rule.is_active ? 'ใช้งาน' : 'ปิด'}</button></td>
            <td className="p-3 text-right whitespace-nowrap"><button type="button" onClick={() => void openRuleEditor(rule)} disabled={addressLoading} className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">แก้ไข</button><button type="button" onClick={() => void deleteRule(rule)} className="ml-2 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600">ลบ</button></td>
          </tr>)}</tbody>
        </table>
        {!loading && filteredRules.length === 0 && <div className="py-10 text-center text-sm text-gray-400">ยังไม่มีข้อมูลพื้นที่พิเศษ</div>}
        {loading && <div className="py-10 text-center text-sm text-gray-400">กำลังโหลด...</div>}
        </div>
      </>}

      <Modal open={editor != null} onClose={() => !saving && setEditor(null)} contentClassName="max-w-4xl w-full max-h-[92vh] overflow-y-auto">
        {editor && <div className="space-y-5 p-6">
          <div><h3 className="text-xl font-bold">{editor.id ? 'แก้ไขพื้นที่พิเศษ' : 'เพิ่มพื้นที่พิเศษ'}</h3><p className="text-sm text-gray-500">เลือกข้อมูลจากฐานที่อยู่เพื่อให้จับคู่หน้าเปิดบิลได้ถูกต้อง</p></div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="text-sm font-semibold">ผู้ให้บริการ<input list="shipping-carrier-options" value={editor.carrier} onChange={(event) => setEditor({ ...editor, carrier: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2" /><datalist id="shipping-carrier-options">{carrierOptions.map((carrier) => <option key={carrier} value={carrier} />)}</datalist></label>
            <label className="text-sm font-semibold">ประเภทพื้นที่<select value={editor.area_type} onChange={(event) => setEditor({ ...editor, area_type: event.target.value as ShippingAreaType })} className="mt-1 w-full rounded-lg border px-3 py-2"><option value="remote">พื้นที่ห่างไกล</option><option value="special_tourism">พื้นที่ท่องเที่ยวพิเศษ</option></select></label>
          </div>
          <div><h4 className="mb-2 text-sm font-bold">ช่องทางขาย</h4><p className="mb-2 text-xs text-gray-500">ไม่เลือก = ใช้ทุกช่องทาง</p><div className="grid gap-2 sm:grid-cols-2 md:grid-cols-4">{channels.map((channel) => <label key={channel.channel_code} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"><input type="checkbox" checked={(editor.channel_codes || []).includes(channel.channel_code)} onChange={(event) => setEditor({ ...editor, channel_codes: event.target.checked ? [...(editor.channel_codes || []), channel.channel_code] : (editor.channel_codes || []).filter((code) => code !== channel.channel_code) })} />{channel.channel_code} · {channel.channel_name}</label>)}</div></div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="text-sm font-semibold">รหัสไปรษณีย์ <span className="font-normal text-gray-400">(เว้นว่าง = ทั้งอำเภอ)</span><input list="shipping-postal-options" value={editor.postal_code || ''} onChange={(event) => {
              const postal = normalizeShippingAddressPart(event.target.value, 'postal_code')
              const rows = addresses.filter((row) => row.postalCode === postal)
              const nextProvince = [...new Set(rows.map((row) => row.province))]
              const nextDistrict = [...new Set(rows.map((row) => row.district))]
              setEditor({ ...editor, postal_code: postal, province: nextProvince.length === 1 ? nextProvince[0] : '', district: nextDistrict.length === 1 ? nextDistrict[0] : '', sub_district: '' })
            }} className="mt-1 w-full rounded-lg border px-3 py-2" placeholder="ค้นหารหัสไปรษณีย์" /><datalist id="shipping-postal-options">{postalCodes.map((postal) => <option key={postal} value={postal} />)}</datalist></label>
            <label className="text-sm font-semibold">จังหวัด<select value={editor.province} onChange={(event) => setEditor({ ...editor, province: event.target.value, district: '', sub_district: '' })} className="mt-1 w-full rounded-lg border px-3 py-2"><option value="">-- เลือกจังหวัด --</option>{provinces.map((province) => <option key={province}>{province}</option>)}</select></label>
            <label className="text-sm font-semibold">เขต/อำเภอ<select value={editor.district} onChange={(event) => setEditor({ ...editor, district: event.target.value, sub_district: '' })} className="mt-1 w-full rounded-lg border px-3 py-2"><option value="">-- เลือกเขต/อำเภอ --</option>{districts.map((district) => <option key={district}>{district}</option>)}</select></label>
            <label className="text-sm font-semibold">แขวง/ตำบล<select value={editor.sub_district || ''} onChange={(event) => setEditor({ ...editor, sub_district: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2"><option value="">ทุกตำบลในอำเภอ</option>{subDistricts.map((subDistrict) => <option key={subDistrict}>{subDistrict}</option>)}</select></label>
            <label className="text-sm font-semibold">ค่าขนส่งเพิ่ม (บาท)<input type="number" min="0" step="0.01" value={editor.surcharge} onWheel={(event) => event.currentTarget.blur()} onChange={(event) => setEditor({ ...editor, surcharge: Math.max(0, Number(event.target.value) || 0) })} className="mt-1 w-full rounded-lg border px-3 py-2 text-right tabular-nums" /></label>
            <label className="flex items-center gap-3 self-end rounded-lg border p-3"><input type="checkbox" checked={editor.is_active} onChange={(event) => setEditor({ ...editor, is_active: event.target.checked })} className="h-5 w-5" /><b className="text-sm">เปิดใช้งาน</b></label>
          </div>
          <div className="grid gap-4 rounded-xl border bg-gray-50 p-4 md:grid-cols-3">
            <label className="flex items-center gap-3"><input type="checkbox" checked={editor.is_forever} onChange={(event) => setEditor({ ...editor, is_forever: event.target.checked, start_date: event.target.checked ? null : editor.start_date, end_date: event.target.checked ? null : editor.end_date })} className="h-5 w-5" /><b className="text-sm">ตลอดไป</b></label>
            <label className="text-sm font-semibold">วันที่เริ่มต้น<input type="date" value={editor.start_date || ''} disabled={editor.is_forever} onChange={(event) => setEditor({ ...editor, start_date: event.target.value || null })} className="mt-1 w-full rounded-lg border px-3 py-2 disabled:bg-gray-100" /></label>
            <label className="text-sm font-semibold">วันที่สิ้นสุด<input type="date" value={editor.end_date || ''} disabled={editor.is_forever} onChange={(event) => setEditor({ ...editor, end_date: event.target.value || null })} className="mt-1 w-full rounded-lg border px-3 py-2 disabled:bg-gray-100" /></label>
          </div>
          {message && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{message}</div>}
          <div className="flex justify-end gap-3 border-t pt-4"><button type="button" onClick={() => setEditor(null)} disabled={saving} className="rounded-lg border px-4 py-2 font-semibold">ยกเลิก</button><button type="button" onClick={() => void saveEditor()} disabled={saving} className="rounded-lg bg-violet-600 px-5 py-2 font-semibold text-white disabled:opacity-50">{saving ? 'กำลังบันทึก...' : 'บันทึกพื้นที่'}</button></div>
        </div>}
      </Modal>

      <Modal open={previewRows != null} onClose={() => !saving && setPreviewRows(null)} contentClassName="max-w-6xl w-full max-h-[92vh] overflow-y-auto">
        {previewRows && <div className="space-y-4 p-6">
          <div><h3 className="text-xl font-bold">ตรวจสอบข้อมูลก่อนนำเข้า</h3><p className="text-sm text-gray-500">ใหม่ {previewRows.filter((row) => row.action === 'new').length} · อัปเดต {previewRows.filter((row) => row.action === 'update').length} · ผิดพลาด {previewRows.filter((row) => row.action === 'error').length}</p></div>
          <div className="max-h-[58vh] overflow-auto rounded-xl border"><table className="w-full min-w-[1050px] text-sm"><thead className="sticky top-0 bg-gray-100"><tr><th className="p-2 text-left">แถว</th><th className="p-2 text-left">สถานะ</th><th className="p-2 text-left">ประเภท/ช่องทาง</th><th className="p-2 text-left">พื้นที่</th><th className="p-2 text-right">ค่าขนส่ง</th><th className="p-2 text-left">ผลตรวจ</th></tr></thead><tbody>{previewRows.map((row) => <tr key={row.rowNumber} className={`border-t ${row.errors.length ? 'bg-red-50' : ''}`}><td className="p-2">{row.rowNumber}</td><td className="p-2 font-semibold">{row.action === 'new' ? 'เพิ่มใหม่' : row.action === 'update' ? 'อัปเดต' : 'ผิดพลาด'}</td><td className="p-2">{SHIPPING_AREA_TYPE_LABELS[row.draft.area_type]}<br /><small>{row.draft.channel_codes?.length ? row.draft.channel_codes.join(', ') : 'ทุกช่องทาง'}</small></td><td className="p-2">{row.draft.postal_code} · {row.draft.sub_district || 'ทุกตำบล'} · {row.draft.district} · {row.draft.province}</td><td className="p-2 text-right">+{formatMoney(row.draft.surcharge)}</td><td className={`p-2 ${row.errors.length ? 'text-red-700' : 'text-emerald-700'}`}>{row.errors.length ? row.errors.join(' · ') : 'ข้อมูลถูกต้อง'}</td></tr>)}</tbody></table></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setPreviewRows(null)} disabled={saving} className="rounded-lg border px-4 py-2 font-semibold">ยกเลิก</button><button type="button" onClick={() => void importPreview()} disabled={saving || previewRows.some((row) => row.errors.length > 0)} className="rounded-lg bg-violet-600 px-5 py-2 font-semibold text-white disabled:opacity-40">{saving ? 'กำลังนำเข้า...' : 'ยืนยันนำเข้า'}</button></div>
        </div>}
      </Modal>
    </section>
  )
}
