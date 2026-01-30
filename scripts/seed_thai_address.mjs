/**
 * Seed Thai address tables (thai_provinces, thai_districts, thai_sub_districts) from CSV.
 *
 * รันหลัง migration 017_create_thai_address_tables.sql
 *
 * วิธีรัน:
 *   node scripts/seed_thai_address.mjs
 *
 * ต้องตั้งค่า env:
 *   VITE_SUPABASE_URL หรือ SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY (ใช้ key นี้เพื่อ bypass RLS ตอน insert)
 *
 * ตัวอย่าง (PowerShell):
 *   $env:SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"; node scripts/seed_thai_address.mjs
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const dataDir = path.join(root, 'file', 'Thai-proince-data')

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.error('ต้องตั้งค่า VITE_SUPABASE_URL (หรือ SUPABASE_URL) และ SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey)

function parseCsv(content) {
  const lines = content.split(/\r?\n/).filter(Boolean)
  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    const cols = []
    let cur = ''
    let inQ = false
    for (let j = 0; j < line.length; j++) {
      const c = line[j]
      if (c === '"') inQ = !inQ
      else if (!inQ && c === ',') {
        cols.push(cur.trim())
        cur = ''
      } else cur += c
    }
    cols.push(cur.trim())
    rows.push(cols)
  }
  return rows
}

async function main() {
  console.log('กำลังโหลด CSV จาก', dataDir)

  const provincesPath = path.join(dataDir, 'provinces.csv')
  const districtsPath = path.join(dataDir, 'districts.csv')
  const subDistrictsPath = path.join(dataDir, 'sub_districts.csv')

  if (!fs.existsSync(provincesPath)) {
    console.error('ไม่พบไฟล์ provinces.csv ที่', provincesPath)
    process.exit(1)
  }
  if (!fs.existsSync(districtsPath)) {
    console.error('ไม่พบไฟล์ districts.csv ที่', districtsPath)
    process.exit(1)
  }
  if (!fs.existsSync(subDistrictsPath)) {
    console.error('ไม่พบไฟล์ sub_districts.csv ที่', subDistrictsPath)
    process.exit(1)
  }

  const provincesCsv = fs.readFileSync(provincesPath, 'utf8')
  const districtsCsv = fs.readFileSync(districtsPath, 'utf8')
  const subDistrictsCsv = fs.readFileSync(subDistrictsPath, 'utf8')

  const provinceRows = parseCsv(provincesCsv)
  const districtRows = parseCsv(districtsCsv)
  const subDistrictRows = parseCsv(subDistrictsCsv)

  const provinces = provinceRows
    .map((cols) => {
      const id = parseInt(cols[0], 10)
      const name_th = (cols[1] || '').trim()
      return isNaN(id) || !name_th ? null : { id, name_th }
    })
    .filter(Boolean)

  console.log('จังหวัด:', provinces.length, 'แถว')

  const { error: errProvinces } = await supabase.from('thai_provinces').upsert(provinces, { onConflict: 'id' })
  if (errProvinces) {
    console.error('Insert thai_provinces ล้มเหลว:', errProvinces)
    process.exit(1)
  }
  console.log('thai_provinces เสร็จแล้ว')

  const districts = districtRows
    .map((cols) => {
      const id = parseInt(cols[0], 10)
      const name_th = (cols[1] || '').trim() || null
      const name_en = (cols[2] || '').trim() || null
      const province_id = parseInt(cols[3], 10)
      return isNaN(id) || isNaN(province_id) ? null : { id, province_id, name_th, name_en }
    })
    .filter(Boolean)

  console.log('เขต/อำเภอ:', districts.length, 'แถว')

  const { error: errDistricts } = await supabase.from('thai_districts').upsert(districts, { onConflict: 'id' })
  if (errDistricts) {
    console.error('Insert thai_districts ล้มเหลว:', errDistricts)
    process.exit(1)
  }
  console.log('thai_districts เสร็จแล้ว')

  const subDistricts = subDistrictRows
    .map((cols) => {
      const id = parseInt(cols[0], 10)
      const zip_code = (cols[1] || '').trim()
      const name_th = (cols[2] || '').trim()
      const district_id = parseInt(cols[4], 10)
      if (isNaN(id) || !zip_code || !name_th || isNaN(district_id)) return null
      return { id, zip_code, name_th, district_id }
    })
    .filter(Boolean)

  console.log('แขวง/ตำบล:', subDistricts.length, 'แถว')

  const BATCH = 500
  for (let i = 0; i < subDistricts.length; i += BATCH) {
    const chunk = subDistricts.slice(i, i + BATCH)
    const { error } = await supabase.from('thai_sub_districts').upsert(chunk, { onConflict: 'id' })
    if (error) {
      console.error('Insert thai_sub_districts ล้มเหลวที่แถว', i, error)
      process.exit(1)
    }
    if ((i / BATCH) % 5 === 0) console.log('  inserted', Math.min(i + BATCH, subDistricts.length), '/', subDistricts.length)
  }
  console.log('thai_sub_districts เสร็จแล้ว')
  console.log('Seed เสร็จสมบูรณ์')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
