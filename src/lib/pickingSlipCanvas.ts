import { PAPER_MM, type PaperSize, type PickingSlipData } from './pickingSlipData'

/** Preview, PNG and print all use these exact paginated pages. */
export async function renderPickingSlipPages(data: PickingSlipData, paper: PaperSize, department: string): Promise<HTMLCanvasElement[]> {
  const fontSize = paper === 'A5' ? 10 : 14
  await document.fonts.load(`${fontSize}px Tahoma`, 'ใบเบิกสินค้า')
  await document.fonts.ready
  const [mmWidth, mmHeight] = PAPER_MM[paper]
  const width = mmWidth * 4
  const height = mmHeight * 4
  const margin = 32
  const contentWidth = width - margin * 2
  const bottom = height - 110
  const lineHeight = paper === 'A5' ? 18 : 21
  const minRowHeight = paper === 'A5' ? 28 : 32
  const pages: HTMLCanvasElement[] = []
  let ctx: CanvasRenderingContext2D
  let y = 0
  let pageBodyStart = 0
  const font = (bold = false, size = fontSize) => `${bold ? 700 : 400} ${size}px Tahoma, sans-serif`
  const segmenter = new Intl.Segmenter('th', { granularity: 'grapheme' })
  function wrap(text: string, maxWidth: number, bold = false): string[] {
    ctx.font = font(bold)
    const lines: string[] = []
    for (const paragraph of text.split('\n')) {
      let line = ''
      for (const { segment } of segmenter.segment(paragraph)) {
        if (line && ctx.measureText(line + segment).width > maxWidth) { lines.push(line); line = segment }
        else line += segment
      }
      lines.push(line)
    }
    return lines
  }
  function text(value: string, x: number, top: number, bold = false, size = fontSize) {
    ctx.font = font(bold, size)
    ctx.fillStyle = '#111'
    ctx.textBaseline = 'top'
    ctx.fillText(value, x, top)
  }
  function newPage() {
    const canvas = document.createElement('canvas')
    canvas.width = width * 2
    canvas.height = height * 2
    const context = canvas.getContext('2d')
    if (!context) throw new Error('ไม่สามารถสร้างหน้ากระดาษได้')
    ctx = context
    ctx.scale(2, 2)
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, width, height)
    pages.push(canvas)
    y = margin
    for (const line of wrap(`ใบเบิก: ${data.workOrderName}`, contentWidth, true)) {
      text(line, margin, y, true); y += lineHeight
    }
    const date = new Date().toLocaleDateString('th-TH')
    for (const line of wrap(`แผนก: ${department}     วันที่: ${date}`, contentWidth)) {
      text(line, margin, y); y += lineHeight
    }
    y += 12
    pageBodyStart = y
  }
  function row(lines: string[][], fractions: number[], bold = false) {
    const rowHeight = Math.max(minRowHeight, Math.max(...lines.map((cell) => cell.length)) * lineHeight + 12)
    let x = margin
    lines.forEach((cell, index) => {
      const cellWidth = contentWidth * fractions[index]
      if (bold) { ctx.fillStyle = '#ededed'; ctx.fillRect(x, y, cellWidth, rowHeight) }
      ctx.strokeStyle = '#aaa'; ctx.lineWidth = 0.7
      ctx.strokeRect(x, y, cellWidth, rowHeight)
      cell.forEach((line, lineIndex) => text(line, x + 5, y + 6 + lineIndex * lineHeight, bold))
      x += cellWidth
    })
    y += rowHeight
  }
  const sections = [
    { title: 'สินค้าเบิก', headers: ['#', 'จุดเก็บ', 'รหัส', 'แผนก', 'รายการ', 'จำนวน'], widths: [0.06, 0.20, 0.14, 0.12, 0.40, 0.08],
      values: data.mainItems.map((r, i) => [String(i + 1), r.location, r.code, r.dept, r.name, String(r.finalQty)]) },
    { title: 'อะไหล่ (หน้ายาง/โฟม)', startFreshOnOverflow: true, headers: ['#', 'รายการอะไหล่', 'จำนวน'], widths: [0.06, 0.86, 0.08],
      values: data.spareItems.map((r, i) => [String(i + 1), r.label, String(r.qty)]) },
    { title: 'สินค้าคลังย่อย', headers: ['#', 'คลังย่อย', 'รหัส', 'รายการ', 'จำนวน'], widths: [0.06, 0.24, 0.14, 0.48, 0.08],
      values: data.subItems.map((r, i) => [String(i + 1), r.warehouse, r.code, r.name, String(r.finalQty)]) },
  ]
  newPage()
  for (const section of sections) {
    if (section.values.length === 0) continue
    const headers = section.headers.map((v, i) => wrap(v, contentWidth * section.widths[i] - 10, true))
    const headerHeight = Math.max(minRowHeight, Math.max(...headers.map((c) => c.length)) * lineHeight + 12)
    const values = section.values
    const measured = values.map((values) => values.map((v, i) => wrap(v, contentWidth * section.widths[i] - 10)))
    const rowHeight = (cells: string[][]) => Math.max(minRowHeight, Math.max(...cells.map((cell) => cell.length)) * lineHeight + 12)
    let sectionBodyStart = 0
    const sectionHeader = (continued: boolean) => {
      text(section.title + (continued ? ' (ต่อ)' : ''), margin, y, true)
      y += 30
      row(headers, section.widths, true)
      sectionBodyStart = y
    }
    // Start spares on a fresh page if the complete table does not fit below
    // previous content. Tables longer than a page still paginate normally.
    const sectionHeight = 30 + headerHeight + measured.reduce((sum, cells) => sum + rowHeight(cells), 0)
    if (section.startFreshOnOverflow && y > pageBodyStart && y + sectionHeight > bottom) newPage()
    // Keep the section title and header with at least its first row (or row fragment).
    const firstHeight = Math.min(rowHeight(measured[0]), bottom - pageBodyStart - 30 - headerHeight)
    if (y + 30 + headerHeight + firstHeight > bottom) newPage()
    sectionHeader(false)
    for (const cells of measured) {
      let remaining = cells.map((cell) => [...cell])
      if (y + rowHeight(remaining) > bottom && y > sectionBodyStart) {
        newPage(); sectionHeader(true)
      }
      // Exceptionally long descriptions span pages without dropping text.
      while (remaining.some((cell) => cell.length > 0)) {
        const availableLines = Math.floor((bottom - y - 12) / lineHeight)
        if (availableLines < 1) { newPage(); sectionHeader(true); continue }
        const segment = remaining.map((cell) => cell.slice(0, availableLines))
        row(segment, section.widths)
        remaining = remaining.map((cell) => cell.slice(availableLines))
        if (remaining.some((cell) => cell.length > 0)) {
          newPage(); sectionHeader(true)
          // Repeat the original sequence number so a split row remains identifiable.
          if (!remaining[0].length) remaining[0] = [...cells[0]]
        }
      }
    }
    y += 18
  }
  text('ผู้เบิก ____________________', margin, height - 72)
  text('ผู้จ่าย ____________________', margin + contentWidth / 2, height - 72)
  pages.forEach((canvas, index) => {
    ctx = canvas.getContext('2d')!
    ctx.textAlign = 'right'
    text(`หน้า ${index + 1}/${pages.length}`, width - margin, height - 32)
    ctx.textAlign = 'left'
  })
  return pages
}
