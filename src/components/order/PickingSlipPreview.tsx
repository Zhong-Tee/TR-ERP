import { useEffect, useState } from 'react'
import Modal from '../ui/Modal'
import { buildPickingWorkbook } from '../../lib/pickingSlipWorkbook'
import { renderPickingSlipPages } from '../../lib/pickingSlipCanvas'
import { filterPickingDepartment, PAPER_MM, type PaperSize, type PickingSlipData } from '../../lib/pickingSlipData'

const safeFilePart = (s: string) => s.replace(/[/\\?%*:|"<>]/g, '_') || 'ใบเบิก'

export default function PickingSlipPreview({ data, onClose, onPrintOpened }: { data: PickingSlipData; onClose: () => void; onPrintOpened?: () => Promise<void> }) {
  const [paper, setPaper] = useState<PaperSize>('A5')
  const [department, setDepartment] = useState<string | null>(null)
  const departments = [...new Set([
    ...data.departments,
    ...data.mainItems.map((item) => item.dept),
    ...data.subItems.map((item) => item.dept),
    ...(data.spareItems.length ? [data.spareDept] : []),
  ])].filter((dept) => data.mainItems.some((item) => item.dept === dept)
    || data.subItems.some((item) => item.dept === dept)
    || (data.spareItems.length > 0 && data.spareDept === dept))
  const [pages, setPages] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    setLoading(true); setPages([]); setError('')
    renderPickingSlipPages(filterPickingDepartment(data, department), paper, department ?? 'ทั้งหมด')
      .then((result) => { if (!cancelled) setPages(result.map((canvas) => canvas.toDataURL('image/png'))) })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'สร้างพรีวิวไม่สำเร็จ') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [data, paper, department])

  async function print() {
    const popup = window.open('', '_blank')
    if (!popup) { setError('กรุณาอนุญาตหน้าต่างป๊อปอัปเพื่อเปิดหน้าพิมพ์'); return }
    try {
      let recorded = false
      let recording = false
      popup.addEventListener('beforeprint', () => {
        if (recorded || recording || !onPrintOpened) return
        recording = true
        void onPrintOpened().then(() => { recorded = true }).catch(() => {
          setError('เปิดหน้าต่างพิมพ์แล้ว แต่บันทึกสถานะไม่สำเร็จ กรุณาตรวจการเชื่อมต่อแล้วกด Print อีกครั้ง')
        }).finally(() => { recording = false })
      })
      popup.document.title = `ใบเบิก ${data.workOrderName}`
      const [width, height] = PAPER_MM[paper]
      const style = popup.document.createElement('style')
      style.textContent = `@page { size: ${paper} portrait; margin: 0; } * { box-sizing: border-box; } body { margin: 0; } .page { width: ${width}mm; height: ${height}mm; break-after: page; page-break-after: always; } .page:last-child { break-after: auto; page-break-after: auto; } img { display: block; width: 100%; height: 100%; } .toolbar { padding: 12px; font: 16px sans-serif; } @media print { .toolbar { display: none; } }`
      popup.document.head.appendChild(style)
      const toolbar = popup.document.createElement('div')
      toolbar.className = 'toolbar'
      const retry = popup.document.createElement('button')
      retry.textContent = 'Print'
      retry.onclick = () => popup.print()
      toolbar.append(retry, ` ขนาด ${paper} • เลือกเครื่องพิมพ์และขนาดกระดาษให้ตรงกับพรีวิว`)
      popup.document.body.appendChild(toolbar)
      await Promise.all(pages.map(async (src) => {
        const page = popup.document.createElement('div'); page.className = 'page'
        const img = popup.document.createElement('img'); img.src = src
        page.appendChild(img); popup.document.body.appendChild(page)
        await img.decode()
      }))
      if (!popup.closed) { popup.focus(); popup.print() }
    } catch { setError('เปิดหน้าพิมพ์ไม่สำเร็จ กรุณาลองใหม่') }
  }

  async function exportAll() {
    setExporting(true); setError('')
    try {
      const { default: JSZip } = await import('jszip')
      const zip = new JSZip()
      const base = safeFilePart(data.workOrderName)
      for (const [departmentIndex, dept] of departments.entries()) {
        const filtered = filterPickingDepartment(data, dept)
        if (!filtered.mainItems.length && !filtered.spareItems.length && !filtered.subItems.length) continue
        const images = await renderPickingSlipPages(filtered, paper, dept)
        const departmentFile = `${departmentIndex + 1}_${safeFilePart(dept)}`
        images.forEach((canvas, index) => zip.file(`${base}/${departmentFile}/ใบเบิก_${base}_${departmentFile}_${paper}_${index + 1}-${images.length}.png`, canvas.toDataURL('image/png').split(',')[1], { base64: true }))
      }
      zip.file(`${base}/ใบเบิก_${base}.xlsx`, buildPickingWorkbook(data))
      const blob = await zip.generateAsync({ type: 'blob' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a'); link.href = url; link.download = `ใบเบิก_${base}_${paper}.zip`; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
    } catch (err) { setError(err instanceof Error ? err.message : 'Export ไม่สำเร็จ') }
    finally { setExporting(false) }
  }

  return <Modal open onClose={onClose} contentClassName="max-w-6xl w-full">
    <div className="p-5 space-y-4">
      <h2 className="text-lg font-bold">ใบเบิก: {data.workOrderName}</h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm font-semibold">ขนาดกระดาษ<select value={paper} disabled={exporting} onChange={(e) => { setLoading(true); setPaper(e.target.value as PaperSize) }} className="block border rounded-lg p-2 mt-1"><option value="A5">A5</option><option value="A4">A4</option></select></label>
        <label className="text-sm font-semibold">แผนก<select value={department === null ? 'all' : `dept:${department}`} disabled={exporting} onChange={(e) => { setLoading(true); setDepartment(e.target.value === 'all' ? null : e.target.value.slice(5)) }} className="block border rounded-lg p-2 mt-1"><option value="all">ทั้งหมด</option>{departments.map((dept) => <option key={dept} value={`dept:${dept}`}>{dept || 'ไม่ระบุแผนก'}</option>)}</select></label>
        <button type="button" disabled={loading || !pages.length} onClick={() => void print()} className="px-4 py-2 rounded-lg bg-blue-600 text-white font-semibold disabled:opacity-50">Print</button>
        <button type="button" disabled={exporting || loading || !pages.length} onClick={() => void exportAll()} className="px-4 py-2 rounded-lg bg-violet-600 text-white font-semibold disabled:opacity-50">{exporting ? 'กำลัง Export...' : 'Export All (PNG, Excel)'}</button>
      </div>
      {error && <p role="alert" className="text-red-600">{error}</p>}
      <div className="max-h-[65vh] overflow-auto bg-gray-100 rounded-lg p-4 space-y-4" aria-label="พรีวิวใบเบิก">
        {loading ? <p role="status" className="text-center p-8">กำลังจัดหน้ากระดาษ...</p> : pages.map((src, i) => <figure key={i} className="mx-auto max-w-3xl"><img src={src} alt={`ใบเบิก ${data.workOrderName} หน้า ${i + 1}/${pages.length}`} className="w-full shadow bg-white" /><figcaption className="text-right text-sm text-gray-500 mt-2">หน้า {i + 1}/{pages.length}</figcaption></figure>)}
      </div>
    </div>
  </Modal>
}
