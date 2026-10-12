import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import { formatDateTime } from '../../lib/utils'

type StatusEvent = {
  id: string
  previous_status: string
  requested_status: string
  resulting_status: string
  event_type: 'changed' | 'preserved'
  actor_name: string
  source: string
  reason: string | null
  created_at: string
}
const sourceNames: Record<string, string> = {
  easyslip: 'ตรวจสลิป', overpayment_request: 'ส่งคำขอโอนคืน', order_review: 'ตรวจคำสั่งซื้อ',
  order_update: 'แก้ไขบิล/กระบวนการระบบ', refund_status_repair: 'แก้สถานะขัดกับผลทวนสอบ',
}

export default function OrderStatusHistory({ orderId }: { orderId: string }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<StatusEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [hasMore, setHasMore] = useState(false)

  async function load(offset = 0) {
    setLoading(true)
    setError('')
    const result = await supabase.from('or_order_status_history')
      .select('id,previous_status,requested_status,resulting_status,event_type,actor_name,source,reason,created_at')
      .eq('order_id', orderId).order('created_at', { ascending: false }).order('id', { ascending: false })
      .range(offset, offset + 49)
    if (result.error) setError('โหลดประวัติไม่สำเร็จ: ' + result.error.message)
    else {
      const data = (result.data || []) as StatusEvent[]
      setRows((previous) => offset ? [...previous, ...data] : data)
      setHasMore(data.length === 50)
    }
    setLoading(false)
  }

  return <section className="mb-4 rounded-xl border border-gray-200 p-3">
    <button type="button" className="text-sm font-semibold text-blue-700" onClick={() => {
      const next = !open
      setOpen(next)
      if (next) void load()
    }}>{open ? '▾' : '▸'} ประวัติการเปลี่ยนสถานะ</button>
    {open && <div className="mt-2 space-y-2 text-sm">
      <p className="text-xs text-gray-500">บันทึกตั้งแต่เปิดใช้ประวัติสถานะ ไม่รวมเหตุการณ์ย้อนหลังที่ไม่ได้บันทึกไว้</p>
      {rows.map((row) => <div key={row.id} className="rounded-lg bg-gray-50 p-3">
        <p className="font-medium">{row.previous_status} → {row.resulting_status}</p>
        {row.event_type === 'preserved' && <p className="text-amber-700">ป้องกันการย้อนสถานะไป “{row.requested_status}”</p>}
        <p className="text-xs text-gray-600">{formatDateTime(row.created_at)} · {row.actor_name} · {sourceNames[row.source] || row.source}</p>
        {row.reason && <p className="mt-1 text-xs text-gray-600">{row.reason}</p>}
      </div>)}
      {error && <p role="alert" className="text-red-600">{error} <button type="button" onClick={() => void load()} className="underline">ลองใหม่</button></p>}
      {loading ? <p>กำลังโหลด…</p> : !error && rows.length === 0 ? <p className="text-gray-500">ยังไม่มีประวัติสถานะ</p> : null}
      {hasMore && !loading && !error && <button type="button" onClick={() => void load(rows.length)} className="text-blue-700 underline">ดูเพิ่มเติม</button>}
    </div>}
  </section>
}
