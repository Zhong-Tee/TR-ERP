import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react'
import { FiCalendar, FiFileText, FiImage, FiSearch, FiUpload, FiX } from 'react-icons/fi'
import { supabase } from '../lib/supabase'
import Modal from '../components/ui/Modal'

type ProductRow = {
  id: string
  product_code: string
  product_name: string
  product_type: string | null
  product_category: string | null
  is_active: boolean
  info: MarketingInfo | null
  assets: MarketingAsset[]
}
type MarketingInfo = { product_id: string; highlights: string | null; launch_date: string | null }
type MarketingAsset = {
  id: string
  product_id: string
  asset_type: 'photo' | 'advertisement' | 'document'
  file_name: string
  storage_path: string
  mime_type: string | null
  uploaded_at: string
}

const BUCKET = 'product-marketing'
const PAGE_SIZE = 60

function publicUrl(path: string) {
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl
}

function thaiDate(value: string | null) {
  return value ? new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium' }).format(new Date(value)) : '-'
}

function productAge(value: string | null) {
  if (!value) return 'ยังไม่ระบุวันออกผลิตภัณฑ์'
  const start = new Date(`${value}T00:00:00`)
  const now = new Date()
  if (start > now) return `กำหนดเปิดตัวในอีก ${Math.ceil((start.getTime() - now.getTime()) / 86400000).toLocaleString()} วัน`
  let years = now.getFullYear() - start.getFullYear()
  let months = now.getMonth() - start.getMonth()
  let days = now.getDate() - start.getDate()
  if (days < 0) {
    const previousMonthDays = new Date(now.getFullYear(), now.getMonth(), 0).getDate()
    days += previousMonthDays
    months--
  }
  if (months < 0) { months += 12; years-- }
  const totalDays = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - start.getTime()) / 86400000)
  const parts = [years > 0 && `${years} ปี`, months > 0 && `${months} เดือน`, `${days} วัน`].filter(Boolean)
  return `${parts.join(' ')} (${totalDays.toLocaleString()} วัน)`
}

export default function ProductInformation() {
  const [products, setProducts] = useState<ProductRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [type, setType] = useState('')
  const [category, setCategory] = useState('')
  const [incompleteOnly, setIncompleteOnly] = useState(false)
  const [selected, setSelected] = useState<ProductRow | null>(null)
  const [editingHighlights, setEditingHighlights] = useState('')
  const [editingLaunchDate, setEditingLaunchDate] = useState('')
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [notice, setNotice] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const uploadKind = useRef<'photo' | 'advertisement' | 'document'>('photo')

  async function load() {
    setLoading(true)
    const [{ data: productData, error }, { data: infoData }, { data: assetData }] = await Promise.all([
      supabase.from('pr_products').select('id,product_code,product_name,product_type,product_category,is_active').order('product_code').limit(5000),
      supabase.from('pr_product_marketing_info').select('product_id,highlights,launch_date'),
      supabase.from('pr_product_marketing_assets').select('id,product_id,asset_type,file_name,storage_path,mime_type,uploaded_at').order('uploaded_at', { ascending: false }),
    ])
    if (error) setNotice(`โหลดรายการสินค้าไม่สำเร็จ: ${error.message}`)
    const infoMap = new Map((infoData || []).map((row) => [row.product_id, row as MarketingInfo]))
    const assetMap = new Map<string, MarketingAsset[]>()
    ;(assetData || []).forEach((row) => assetMap.set(row.product_id, [...(assetMap.get(row.product_id) || []), row as MarketingAsset]))
    setProducts((productData || []).map((p) => ({ ...p, info: infoMap.get(p.id) || null, assets: assetMap.get(p.id) || [] })))
    setLoading(false)
  }

  useEffect(() => { void load() }, [])

  const categories = useMemo(() => [...new Set(products.map((p) => p.product_category).filter(Boolean) as string[])].sort(), [products])
  const filtered = useMemo(() => {
    const q = search.trim().toLocaleLowerCase('th')
    return products.filter((p) => {
      const hasImage = p.assets.some((asset) => asset.asset_type === 'photo' || asset.asset_type === 'advertisement')
      const hasDocument = p.assets.some((asset) => asset.asset_type === 'document')
      const isIncomplete = !p.info?.highlights?.trim() || !p.info?.launch_date || !hasImage || !hasDocument
      return (!q || `${p.product_code} ${p.product_name}`.toLocaleLowerCase('th').includes(q))
        && (!type || p.product_type === type)
        && (!category || p.product_category === category)
        && (!incompleteOnly || isIncomplete)
    })
  }, [products, search, type, category, incompleteOnly])

  function openProduct(product: ProductRow) {
    setSelected(product)
    setEditingHighlights(product.info?.highlights || '')
    setEditingLaunchDate(product.info?.launch_date || '')
    setNotice('')
  }

  async function saveInfo() {
    if (!selected) return
    setSaving(true)
    const { error } = await supabase.from('pr_product_marketing_info').upsert({
      product_id: selected.id,
      highlights: editingHighlights.trim() || null,
      launch_date: editingLaunchDate || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'product_id' })
    setSaving(false)
    if (error) return setNotice(`บันทึกไม่สำเร็จ: ${error.message}`)
    await load()
    setSelected((current) => current ? { ...current, info: { product_id: current.id, highlights: editingHighlights.trim() || null, launch_date: editingLaunchDate || null } } : null)
    setNotice('บันทึกข้อมูลสินค้าแล้ว')
  }

  function chooseFiles(kind: typeof uploadKind.current) {
    uploadKind.current = kind
    if (fileInput.current) {
      fileInput.current.accept = kind === 'document' ? 'application/pdf' : 'image/jpeg,image/png,image/webp,image/gif'
      fileInput.current.multiple = kind !== 'document'
      fileInput.current.click()
    }
  }

  async function uploadFiles(event: ChangeEvent<HTMLInputElement>) {
    if (!selected || !event.target.files?.length) return
    const files = [...event.target.files]
    setUploading(true)
    setNotice('')
    try {
      for (const file of files) {
        if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name} มีขนาดเกิน 20 MB`)
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
        const path = `${selected.id}/${Date.now()}-${crypto.randomUUID()}-${safeName}`
        const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false })
        if (uploadError) throw uploadError
        const { error: rowError } = await supabase.from('pr_product_marketing_assets').insert({
          product_id: selected.id, asset_type: uploadKind.current, file_name: file.name, storage_path: path, mime_type: file.type,
        })
        if (rowError) { await supabase.storage.from(BUCKET).remove([path]); throw rowError }
      }
      await load()
      const { data } = await supabase.from('pr_product_marketing_assets').select('id,product_id,asset_type,file_name,storage_path,mime_type,uploaded_at').eq('product_id', selected.id).order('uploaded_at', { ascending: false })
      setSelected((current) => current ? { ...current, assets: (data || []) as MarketingAsset[] } : null)
      setNotice(`อัปโหลดสำเร็จ ${files.length} ไฟล์`)
    } catch (error) { setNotice(`อัปโหลดไม่สำเร็จ: ${error instanceof Error ? error.message : String(error)}`) }
    finally { setUploading(false); event.target.value = '' }
  }

  async function removeAsset(asset: MarketingAsset) {
    if (!confirm(`ลบไฟล์ “${asset.file_name}” ใช่หรือไม่`)) return
    const { error } = await supabase.from('pr_product_marketing_assets').delete().eq('id', asset.id)
    if (error) return setNotice(`ลบไม่สำเร็จ: ${error.message}`)
    await supabase.storage.from(BUCKET).remove([asset.storage_path])
    setSelected((current) => current ? { ...current, assets: current.assets.filter((item) => item.id !== asset.id) } : null)
    setProducts((current) => current.map((p) => p.id === asset.product_id ? { ...p, assets: p.assets.filter((item) => item.id !== asset.id) } : p))
  }

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-6">
      <div className="mx-auto max-w-[1600px]">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div><h1 className="text-2xl font-black text-slate-900">ข้อมูลสินค้า</h1><p className="mt-1 text-sm text-slate-500">ศูนย์รวมข้อมูล รูปโฆษณา และเอกสารสำหรับทีมการตลาด</p></div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setIncompleteOnly((current) => !current)}
              aria-pressed={incompleteOnly}
              className={`whitespace-nowrap rounded-xl border px-4 py-2 text-sm font-bold transition ${incompleteOnly ? 'border-amber-500 bg-amber-500 text-white shadow-sm' : 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100'}`}
            >
              {incompleteOnly ? '✓ ข้อมูลไม่ครบ' : 'กรองข้อมูลไม่ครบ'}
            </button>
            <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-bold text-blue-700">สินค้าทั้งหมด {products.length.toLocaleString()} รายการ</div>
          </div>
        </div>
        <div className="mb-5 grid gap-3 rounded-2xl border bg-white p-4 shadow-sm md:grid-cols-[1fr_220px_240px]">
          <label className="relative block min-w-0">
            <FiSearch className="pointer-events-none absolute left-4 top-1/2 z-10 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ค้นหาด้วยชื่อหรือรหัสสินค้า..."
              className="block w-full min-w-0 rounded-xl border border-slate-200 py-3 pr-4 outline-none focus:border-blue-500"
              style={{ paddingLeft: '3rem' }}
            />
          </label>
          <select value={type} onChange={(e) => setType(e.target.value)} className="rounded-xl border border-slate-200 px-4 py-3"><option value="">ทุกประเภท</option><option value="FG">FG - สินค้าสำเร็จรูป</option><option value="PP">PP - สินค้าแปรรูป</option><option value="RM">RM - วัตถุดิบ</option></select>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="rounded-xl border border-slate-200 px-4 py-3"><option value="">ทุกหมวดหมู่</option>{categories.map((item) => <option key={item}>{item}</option>)}</select>
        </div>
        {loading ? <div className="py-24 text-center text-slate-500">กำลังโหลดข้อมูลสินค้า...</div> : filtered.length === 0 ? <div className="rounded-2xl border border-dashed bg-white py-24 text-center text-slate-500">ไม่พบสินค้าที่ตรงกับเงื่อนไข</div> : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.slice(0, PAGE_SIZE).map((p) => {
              const photos = p.assets.filter((a) => a.asset_type !== 'document')
              return <button key={p.id} onClick={() => openProduct(p)} className="overflow-hidden rounded-2xl border bg-white text-left shadow-sm transition hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-md">
                <div className="relative h-44 bg-slate-100">{photos[0] ? <img src={publicUrl(photos[0].storage_path)} className="h-full w-full object-cover" /> : <div className="flex h-full flex-col items-center justify-center text-slate-400"><FiImage className="mb-2 h-9 w-9" /><span className="text-sm">ยังไม่มีรูปการตลาด</span></div>}<span className="absolute right-3 top-3 rounded-full bg-black/65 px-2.5 py-1 text-xs font-bold text-white">{photos.length} รูป</span></div>
                <div className="p-4"><div className="mb-2 flex gap-2 text-[11px] font-bold"><span className="rounded-full bg-blue-50 px-2 py-1 text-blue-700">{p.product_type || '-'}</span><span className="truncate rounded-full bg-slate-100 px-2 py-1 text-slate-600">{p.product_category || 'ไม่ระบุหมวดหมู่'}</span></div><div className="text-xs font-bold text-blue-700">{p.product_code}</div><h2 className="mt-1 line-clamp-2 min-h-12 font-bold text-slate-800">{p.product_name}</h2><div className="mt-3 flex items-center gap-2 border-t pt-3 text-xs text-slate-500"><FiCalendar />{productAge(p.info?.launch_date || null)}</div></div>
              </button>
            })}
          </div>
        )}
        {filtered.length > PAGE_SIZE && <p className="mt-5 text-center text-sm text-slate-500">แสดง {PAGE_SIZE} จาก {filtered.length.toLocaleString()} รายการ — กรุณาค้นหาเพื่อจำกัดผลลัพธ์</p>}
      </div>
      <input ref={fileInput} type="file" className="hidden" onChange={uploadFiles} />
      <Modal open={!!selected} onClose={() => setSelected(null)} contentClassName="w-[min(960px,calc(100vw-2rem))] max-w-none max-h-[92vh]">
        {selected && <div className="p-5 md:p-7">
          <div className="mb-5 flex items-start justify-between gap-4"><div><div className="text-sm font-bold text-blue-700">{selected.product_code}</div><h2 className="text-xl font-black text-slate-900">{selected.product_name}</h2></div><button onClick={() => setSelected(null)} className="rounded-full p-2 hover:bg-slate-100"><FiX className="h-6 w-6" /></button></div>
          {notice && <div className="mb-4 rounded-xl bg-blue-50 px-4 py-3 text-sm font-medium text-blue-800">{notice}</div>}
          <div className="grid gap-5 lg:grid-cols-[310px_1fr]">
            <section className="rounded-2xl border bg-slate-50 p-4"><h3 className="mb-4 font-black">ข้อมูลสำหรับการตลาด</h3><label className="mb-4 block text-sm font-bold text-slate-700">จุดเด่นสินค้า<textarea value={editingHighlights} onChange={(e) => setEditingHighlights(e.target.value)} rows={7} placeholder="ระบุคุณสมบัติ จุดเด่น และข้อความสำคัญสำหรับการขาย..." className="mt-2 w-full rounded-xl border bg-white p-3 font-normal outline-none focus:border-blue-500" /></label><label className="block text-sm font-bold text-slate-700">วันที่ออกผลิตภัณฑ์<input type="date" value={editingLaunchDate} onChange={(e) => setEditingLaunchDate(e.target.value)} className="mt-2 w-full rounded-xl border bg-white p-3 font-normal" /></label><div className="mt-3 rounded-xl bg-white p-3 text-sm"><div className="font-bold text-slate-500">อายุผลิตภัณฑ์ ณ วันนี้</div><div className="mt-1 font-black text-blue-700">{productAge(editingLaunchDate || null)}</div></div><button onClick={saveInfo} disabled={saving} className="mt-4 w-full rounded-xl bg-blue-600 py-3 font-bold text-white disabled:opacity-50">{saving ? 'กำลังบันทึก...' : 'บันทึกข้อมูล'}</button></section>
            <div className="space-y-5">
              {(['photo', 'advertisement'] as const).map((assetType) => {
                const items = selected.assets.filter((asset) => asset.asset_type === assetType)
                const isAdvertisement = assetType === 'advertisement'
                return (
                  <section key={assetType} className="rounded-2xl border p-4">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="font-black">{isAdvertisement ? 'รูปโฆษณา' : 'รูปถ่ายสินค้า'}</h3>
                        <p className="mt-0.5 text-xs text-slate-500">{items.length.toLocaleString()} รูป</p>
                      </div>
                      <button
                        disabled={uploading}
                        onClick={() => chooseFiles(assetType)}
                        className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-bold ${isAdvertisement ? 'bg-violet-600 text-white' : 'border border-blue-200 bg-blue-50 text-blue-700'}`}
                      >
                        <FiUpload /> อัปโหลด{isAdvertisement ? 'รูปโฆษณา' : 'รูปถ่าย'}
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      {items.map((asset) => (
                        <div key={asset.id} className="group relative overflow-hidden rounded-xl border bg-slate-100">
                          <a href={publicUrl(asset.storage_path)} target="_blank" rel="noreferrer">
                            <img src={publicUrl(asset.storage_path)} className="aspect-square w-full object-cover" />
                          </a>
                          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 p-2 pt-8 text-white">
                            <div className="truncate text-xs font-bold">{isAdvertisement ? 'รูปโฆษณา' : 'รูปถ่ายสินค้า'}</div>
                            <div className="text-[11px] opacity-80">อัปโหลด {thaiDate(asset.uploaded_at)}</div>
                          </div>
                          <button onClick={() => void removeAsset(asset)} className="absolute right-2 top-2 hidden rounded-full bg-red-600 p-1.5 text-white group-hover:block"><FiX /></button>
                        </div>
                      ))}
                      {items.length === 0 && <div className="col-span-full rounded-xl border border-dashed py-10 text-center text-sm text-slate-400">ยังไม่มี{isAdvertisement ? 'รูปโฆษณา' : 'รูปถ่ายสินค้า'}</div>}
                    </div>
                  </section>
                )
              })}
              <section><div className="mb-3 flex items-center justify-between"><h3 className="font-black">เอกสารข้อมูลสินค้า (PDF)</h3><button disabled={uploading} onClick={() => chooseFiles('document')} className="flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-bold text-white"><FiUpload /> อัปโหลด PDF</button></div><div className="space-y-2">{selected.assets.filter((a) => a.asset_type === 'document').map((asset) => <div key={asset.id} className="flex items-center gap-3 rounded-xl border p-3"><div className="rounded-lg bg-red-50 p-3 text-red-600"><FiFileText className="h-5 w-5" /></div><a className="min-w-0 flex-1" href={publicUrl(asset.storage_path)} target="_blank" rel="noreferrer"><div className="truncate text-sm font-bold text-slate-800">{asset.file_name}</div><div className="text-xs text-slate-500">อัปโหลด {thaiDate(asset.uploaded_at)}</div></a><button onClick={() => void removeAsset(asset)} className="rounded-lg p-2 text-red-500 hover:bg-red-50"><FiX /></button></div>)}{selected.assets.every((a) => a.asset_type !== 'document') && <div className="rounded-xl border border-dashed py-8 text-center text-sm text-slate-400">ยังไม่มีเอกสาร PDF</div>}</div></section>
            </div>
          </div>
        </div>}
      </Modal>
    </div>
  )
}
