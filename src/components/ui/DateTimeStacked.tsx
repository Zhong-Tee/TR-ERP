/**
 * แสดงวันที่บรรทัดแรก เวลาบรรทัดที่สอง (ตัวเล็กสีเทา)
 * รองรับทั้งรูปแบบ "17/7/2569 15:39:50" และ "2 กรกฎาคม 2569 เวลา 15:39"
 */
export default function DateTimeStacked({ text }: { text: string }) {
  const s = (text || '').trim()
  if (!s || s === '–') return <>–</>
  let datePart = s
  let timePart = ''
  if (s.includes(' เวลา ')) {
    const idx = s.indexOf(' เวลา ')
    datePart = s.slice(0, idx)
    timePart = s.slice(idx + ' เวลา '.length)
  } else {
    const i = s.indexOf(' ')
    if (i !== -1) {
      datePart = s.slice(0, i)
      timePart = s.slice(i + 1)
    }
  }
  return (
    <div className="leading-tight">
      <div>{datePart}</div>
      {timePart && <div className="text-xs text-gray-500">{timePart}</div>}
    </div>
  )
}
