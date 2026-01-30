/**
 * Thai address: ตรวจจับรหัสไปรษณีย์ 5 หลักในช่องที่อยู่ลูกค้าก่อน แล้วค้นหา จังหวัด, แขวง/ตำบล, เขต/อำเภอ
 * จากตาราง thai_provinces, thai_districts, thai_sub_districts (ถ้ามี) หรือจาก CSV ใน public/
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { extractPhonesFromText, e164ToLocal } from './thaiPhone'

export interface SubDistrictOption {
  subDistrict: string
  district: string
}

export interface ParsedAddress {
  addressLine: string
  subDistrict: string
  district: string
  province: string
  postalCode: string
  mobilePhone: string
  /** เบอร์โทรที่ parse ได้หลายเบอร์ (รูปแบบ 0 ตามด้วย 9 หลัก) — ให้เลือกจาก dropdown ได้ */
  mobilePhoneCandidates?: string[]
  /** รายการแขวง/ตำบล + เขต/อำเภอ ตามรหัสไปรษณีย์ — ให้เลือกจาก dropdown ได้ */
  subDistrictOptions?: SubDistrictOption[]
}

interface ProvinceRow {
  id: number
  name_th: string
}

interface SubDistrictRow {
  zip_code: string
  name_th: string
  district_id: number
}

/** รหัสไปรษณีย์ 5 หลัก */
const POSTAL_REGEX = /\b([0-9]{5})\b/

// --- CSV fallback (ใช้เมื่อไม่มี DB หรือ query ไม่เจอ) ---
let cachedProvinces: ProvinceRow[] | null = null
let cachedSubDistricts: SubDistrictRow[] | null = null
let cachedSubByZip: Map<string, SubDistrictRow[]> | null = null

function parseCsvLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') inQuotes = !inQuotes
    else if (inQuotes) current += c
    else if (c === ',') {
      result.push(current.trim())
      current = ''
    } else current += c
  }
  result.push(current.trim())
  return result
}

export async function loadProvinces(): Promise<ProvinceRow[]> {
  if (cachedProvinces) return cachedProvinces
  try {
    const res = await fetch('/Thai-proince-data/provinces.csv')
    const text = await res.text()
    const lines = text.split(/\r?\n/).filter(Boolean)
    const rows: ProvinceRow[] = []
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i])
      const id = parseInt(cols[0], 10)
      const name_th = cols[1] ?? ''
      if (!isNaN(id) && name_th) rows.push({ id, name_th })
    }
    cachedProvinces = rows
    return rows
  } catch {
    return []
  }
}

export async function loadSubDistricts(): Promise<SubDistrictRow[]> {
  if (cachedSubDistricts) return cachedSubDistricts
  try {
    const res = await fetch('/Thai-proince-data/sub_districts.csv')
    const text = await res.text()
    const lines = text.split(/\r?\n/).filter(Boolean)
    const rows: SubDistrictRow[] = []
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i])
      const zip_code = (cols[1] ?? '').trim()
      const name_th = cols[2] ?? ''
      const district_id = parseInt(cols[4], 10)
      if (zip_code && name_th && !isNaN(district_id)) rows.push({ zip_code, name_th, district_id })
    }
    cachedSubDistricts = rows
    return rows
  } catch {
    return []
  }
}

function getSubDistrictsByZip(): Map<string, SubDistrictRow[]> {
  if (cachedSubByZip) return cachedSubByZip
  const list = cachedSubDistricts ?? []
  const map = new Map<string, SubDistrictRow[]>()
  for (const row of list) {
    const arr = map.get(row.zip_code) ?? []
    arr.push(row)
    map.set(row.zip_code, arr)
  }
  cachedSubByZip = map
  return map
}

/** ค้นหาจังหวัด + รายการแขวง/ตำบล + เขต/อำเภอ จากรหัสไปรษณีย์. addressHint = ข้อความที่อยู่ ถ้ามีจะเลือกแขวงที่ชื่ออยู่ในข้อความเป็น default */
export async function getAddressByZip(
  zipCode: string,
  supabaseClient?: SupabaseClient | null,
  addressHint?: string
): Promise<{ province: string; options: SubDistrictOption[]; subDistrict: string; district: string }> {
  const empty = { province: '', options: [], subDistrict: '', district: '' }
  const zip = (zipCode ?? '').trim()
  if (!zip || zip.length !== 5) return empty

  if (supabaseClient) {
    const { data: rows, error } = await supabaseClient
      .from('thai_sub_districts')
      .select('name_th, district_id, thai_districts(name_th, province_id, thai_provinces(name_th))')
      .eq('zip_code', zip)
      .limit(50)

    if (!error && rows && rows.length > 0) {
      type Row = { name_th?: string; thai_districts?: { name_th?: string | null; thai_provinces?: { name_th?: string } | null } | { name_th?: string | null }[] | null }
      const getDistrict = (r: Row): string => {
        const td = r.thai_districts
        if (!td) return ''
        const one = Array.isArray(td) ? td[0] : td
        return (one?.name_th ?? '').trim()
      }
      const getProvince = (r: Row): string => {
        const td = r.thai_districts
        if (!td) return ''
        const one = Array.isArray(td) ? td[0] : td
        const prov = one && 'thai_provinces' in one ? (one as { thai_provinces?: { name_th?: string } | null }).thai_provinces : null
        return prov?.name_th ?? ''
      }
      const options: SubDistrictOption[] = rows.map((r: Row) => ({
        subDistrict: r.name_th ?? '',
        district: getDistrict(r),
      }))
      const hint = (addressHint ?? '').trim()
      let chosen: Row = rows[0] as Row
      if (hint) {
        const matched = rows.find((r: Row) => r.name_th && hint.includes(r.name_th))
        if (matched) chosen = matched as Row
      }
      return {
        province: getProvince(chosen),
        options,
        subDistrict: chosen.name_th ?? '',
        district: getDistrict(chosen),
      }
    }
  }

  await loadProvinces()
  await loadSubDistricts()
  const byZip = getSubDistrictsByZip()
  const subs = byZip.get(zip) ?? []
  if (subs.length === 0) return empty

  const provinces = cachedProvinces ?? []
  const options: SubDistrictOption[] = subs.map((s) => ({
    subDistrict: s.name_th,
    district: '',
  }))
  const s = subs[0]
  const provinceId = Math.floor(s.district_id / 1000)
  const prov = provinces.find((p) => p.id === provinceId)
  return {
    province: prov?.name_th ?? '',
    options,
    subDistrict: s.name_th,
    district: '',
  }
}

/** หาตำแหน่งที่ตัดข้อความที่อยู่ — ตัดตั้งแต่ แขวง/ตำบล หรือ เขต/อำเภอ เป็นต้นไป (ที่อยู่เหลือแค่บรรทัดที่อยู่จริง ไม่รวมแขวง ตำบล เขต อำเภอ จังหวัด) */
function cutAddressLine(rest: string, subDistrict: string, district: string, province: string): string {
  const indices: number[] = []
  if (subDistrict && rest.includes(subDistrict)) indices.push(rest.indexOf(subDistrict))
  if (district && rest.includes(district)) indices.push(rest.indexOf(district))
  if (province && rest.includes(province)) indices.push(rest.indexOf(province))
  if (rest.includes('ตำบล')) indices.push(rest.indexOf('ตำบล'))
  if (rest.includes('แขวง')) indices.push(rest.indexOf('แขวง'))
  if (rest.includes('อำเภอ')) indices.push(rest.indexOf('อำเภอ'))
  if (rest.includes('เขต')) indices.push(rest.indexOf('เขต'))
  const valid = indices.filter((i) => i >= 0)
  if (valid.length === 0) return rest.replace(/\s+/g, ' ').trim()
  const cut = Math.min(...valid)
  return rest.slice(0, cut).replace(/\s+/g, ' ').trim()
}

/**
 * แยกที่อยู่จากข้อความ: แยกเบอร์โทร (E.164) ก่อน แล้วตรวจจับรหัสไปรษณีย์ 5 หลัก แล้วค้นหา จังหวัด, แขวง/ตำบล, เขต/อำเภอ จากข้อมูล (DB หรือ CSV)
 */
export async function parseAddressText(
  text: string,
  supabaseClient?: SupabaseClient | null
): Promise<ParsedAddress> {
  const empty: ParsedAddress = {
    addressLine: '',
    subDistrict: '',
    district: '',
    province: '',
    postalCode: '',
    mobilePhone: '',
    mobilePhoneCandidates: [],
  }
  const raw = (text ?? '').replace(/\r\n/g, '\n').replace(/\n/g, ' ').trim()
  if (!raw) return empty

  const { candidates: phoneCandidates, rest: restAfterPhone } = extractPhonesFromText(raw)
  const localCandidates = phoneCandidates.map(e164ToLocal)
  const mobilePhone = localCandidates[0] ?? ''
  let rest = restAfterPhone

  const postalMatch = rest.match(POSTAL_REGEX)
  const postalCode = postalMatch?.[1] ?? ''
  if (postalCode) rest = rest.replace(postalCode, ' ').replace(/\s+/g, ' ').trim()

  const { province, options: subDistrictOptions, subDistrict, district } = await getAddressByZip(postalCode, supabaseClient, rest)

  const addressLine = cutAddressLine(rest, subDistrict, district, province)

  return {
    addressLine,
    subDistrict,
    district,
    province,
    postalCode,
    mobilePhone,
    mobilePhoneCandidates: localCandidates.length > 0 ? localCandidates : undefined,
    subDistrictOptions: subDistrictOptions.length > 0 ? subDistrictOptions : undefined,
  }
}
