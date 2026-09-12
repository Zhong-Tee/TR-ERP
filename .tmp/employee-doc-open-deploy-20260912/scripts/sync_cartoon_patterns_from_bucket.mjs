/**
 * ซิงค์รายการลายการ์ตูนจาก Bucket cartoon-patterns เข้าตาราง cp_cartoon_patterns
 * ใช้ชื่อไฟล์ (ตัดนามสกุล) เป็น pattern_name และเพิ่มเฉพาะรายการที่ยังไม่มีในตาราง
 *
 * วิธีรัน:
 *   node scripts/sync_cartoon_patterns_from_bucket.mjs
 *
 * ใช้ค่าจาก .env ที่ root โปรเจกต์ (VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
 * หรือตั้ง env ใน shell ก่อนรัน
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

function loadEnv() {
  const envPath = path.join(root, '.env')
  if (!fs.existsSync(envPath)) return
  const content = fs.readFileSync(envPath, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (key && !process.env[key]) process.env[key] = value
  }
}
loadEnv()

const BUCKET = 'cartoon-patterns'

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.error('ต้องตั้งค่า VITE_SUPABASE_URL (หรือ SUPABASE_URL) และ SUPABASE_SERVICE_ROLE_KEY')
  console.error('(ใส่ใน .env ที่ root โปรเจกต์ หรือตั้งใน shell ก่อนรัน)')
  console.error('')
  console.error('Service Role Key: Supabase Dashboard > Project Settings > API > คัดลอก "service_role" (คีย์สีแดง)')
  process.exit(1)
}

// ตรวจว่าเป็น Service Role จริง ไม่ใช่ anon (anon จะ list storage ได้ 0 เพราะ RLS)
try {
  const payload = JSON.parse(Buffer.from(serviceRoleKey.split('.')[1], 'base64').toString())
  if (payload.role === 'anon') {
    console.error('ผิดคีย์: ตอนนี้ใช้เป็น anon key (VITE_SUPABASE_ANON_KEY)')
    console.error('สคริปต์ต้องใช้ Service Role Key เท่านั้น')
    console.error('แก้ไข: ใส่ SUPABASE_SERVICE_ROLE_KEY=eyJ... (จาก Dashboard > Project Settings > API > service_role) ใน .env')
    process.exit(1)
  }
} catch (_) {}

const supabase = createClient(supabaseUrl, serviceRoleKey)

/** List ไฟล์ทั้งหมดใน path (รวมโฟลเดอร์ย่อย) แล้วคืนรายชื่อไฟล์ที่มีนามสกุล */
async function listAllFiles(pathPrefix = '') {
  const { data: items, error } = await supabase.storage
    .from(BUCKET)
    .list(pathPrefix, { limit: 1000 })

  if (error) throw error
  if (!items || items.length === 0) return []

  const fileNames = []
  for (const item of items) {
    const name = item.name
    if (typeof name !== 'string') continue
    const fullPath = pathPrefix ? pathPrefix + '/' + name : name
    const hasExtension = name.includes('.')
    if (hasExtension) {
      fileNames.push(fullPath)
    } else {
      const nested = await listAllFiles(fullPath)
      fileNames.push(...nested)
    }
  }
  return fileNames
}

/** จาก path เช่น "folder/img.jpg" หรือ "img.jpg" คืนชื่อไฟล์ไม่รวมนามสกุล สำหรับใช้เป็น pattern_name */
function pathToPatternName(filePath) {
  const base = filePath.split('/').pop() || filePath
  return base.includes('.') ? base.replace(/\.[^.]+$/, '') : base
}

async function main() {
  console.log('กำลัง list ไฟล์ใน Bucket', BUCKET, '...')
  const { data: rootItems, error: rootError } = await supabase.storage.from(BUCKET).list('', { limit: 1000 })
  if (rootError) {
    console.error('List bucket error:', rootError.message)
    process.exit(1)
  }
  const rootCount = rootItems?.length ?? 0
  console.log('ที่ root ได้', rootCount, 'รายการ')
  if (rootCount > 0 && rootItems[0]) {
    console.log('ตัวอย่าง item แรก:', JSON.stringify(rootItems[0]))
  }

  let filePaths
  try {
    filePaths = await listAllFiles('')
  } catch (listError) {
    console.error('List bucket error:', listError.message)
    if (listError.message) console.error('รายละเอียด:', listError)
    process.exit(1)
  }

  if (filePaths.length > 0) {
    console.log('list ได้', filePaths.length, 'ไฟล์ (ตัวอย่าง:', filePaths.slice(0, 5).join(', '), filePaths.length > 5 ? '...' : '', ')')
  }

  const patternNamesFromBucket = [...new Set(
    filePaths.map(pathToPatternName).filter((s) => s.trim() !== '')
  )]

  if (!patternNamesFromBucket.length) {
    console.log('ไม่พบไฟล์รูปใน Bucket', BUCKET, '(ชื่อไฟล์ต้องมีจุด เช่น .jpg .png)')
    if (filePaths.length === 0) {
      console.log('')
      console.log('ถ้าใน Dashboard มีรูปแต่สคริปต์ได้ 0 รายการ ให้ตรวจสอบ:')
      console.log('1. ใช้ Service Role Key จริงหรือไม่ (Supabase Dashboard > Project Settings > API > service_role คีย์สีแดง)')
      console.log('   อย่าใช้ anon key ใน .env ต้องเป็น SUPABASE_SERVICE_ROLE_KEY=eyJ... (ยาวกว่า anon)')
      console.log('2. ชื่อ bucket ตรงกับ "' + BUCKET + '" หรือไม่ (ตัวเล็ก-ใหญ่ต้องตรง)')
      console.log('3. รัน migration 030_storage_policies_product_cartoon_buckets.sql แล้วหรือยัง')
    }
    return
  }

  console.log('พบชื่อจากไฟล์ใน Bucket:', patternNamesFromBucket.length, 'ชื่อ')

  console.log('กำลังดึง pattern_name ที่มีในตาราง cp_cartoon_patterns ...')
  const { data: existing, error: existingError } = await supabase.from('cp_cartoon_patterns').select('pattern_name')

  if (existingError) {
    console.error('Select error:', existingError.message)
    process.exit(1)
  }

  const existingSet = new Set((existing || []).map((r) => r.pattern_name))
  const toInsert = patternNamesFromBucket.filter((name) => !existingSet.has(name))

  if (!toInsert.length) {
    console.log('รายการในตารางครบตามรูปใน Bucket แล้ว ไม่มีรายการใหม่')
    return
  }

  console.log('จะเพิ่มรายการใหม่:', toInsert.length, 'รายการ')
  console.log('ชื่อ:', toInsert.join(', '))

  const rows = toInsert.map((pattern_name) => ({ pattern_name, is_active: true }))
  const { error: insertError } = await supabase.from('cp_cartoon_patterns').insert(rows)

  if (insertError) {
    console.error('Insert error:', insertError.message)
    process.exit(1)
  }

  console.log('เพิ่มลายการ์ตูนจาก Bucket เรียบร้อย', toInsert.length, 'รายการ')

  // แสดง SQL ที่เทียบเท่าการ insert (สำหรับบันทึก/รันมือ)
  const values = toInsert.map((name) => `('${name.replace(/'/g, "''")}', true)`).join(',\n  ')
  console.log('\n-- SQL ที่เทียบเท่า (สำหรับอ้างอิง):')
  console.log('INSERT INTO cp_cartoon_patterns (pattern_name, is_active) VALUES\n  ' + values + '\n;')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
