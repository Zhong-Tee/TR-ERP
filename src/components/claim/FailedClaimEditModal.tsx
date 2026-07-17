import { useEffect, useState } from 'react'
import type { Order } from '../../types'
import { supabase } from '../../lib/supabase'
import { verifyAndSaveClaimSlips } from '../../lib/claimSlipVerification'
import { useAuthContext } from '../../contexts/AuthContext'
import Modal from '../ui/Modal'
import VerificationResultModal, { type AmountStatus } from '../order/VerificationResultModal'

type ItemRow = {
  id: string
  product_name?: string | null
  ink_color?: string | null
  cartoon_pattern?: string | null
  line_pattern?: string | null
  font?: string | null
  line_1?: string | null
  line_2?: string | null
  line_3?: string | null
  quantity?: number | null
  unit_price?: number | null
  is_free?: boolean | null
}

type SlipRow = { id: string; url: string; name: string }

export default function FailedClaimEditModal({
  order,
  onClose,
  onSaved,
}: {
  order: Order | null
  onClose: () => void
  onSaved: () => void | Promise<void>
}) {
  const { user } = useAuthContext()
  const [rows, setRows] = useState<ItemRow[]>([])
  const [initialIds, setInitialIds] = useState<string[]>([])
  const [shipping, setShipping] = useState(0)
  const [slips, setSlips] = useState<SlipRow[]>([])
  const [newFiles, setNewFiles] = useState<File[]>([])
  const [newPreviews, setNewPreviews] = useState<string[]>([])
  const [zoomUrl, setZoomUrl] = useState<string | null>(null)
  const [deleteSlipTarget, setDeleteSlipTarget] = useState<SlipRow | null>(null)
  const [deletingSlip, setDeletingSlip] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [verifyResult, setVerifyResult] = useState<{
    type: 'success' | 'failed'
    accountMatch: boolean | null
    bankCodeMatch: boolean | null
    amountStatus: AmountStatus
    orderAmount: number
    totalAmount: number
    errors: string[]
    statusMessage: string
  } | null>(null)

  useEffect(() => {
    const urls = newFiles.map(URL.createObjectURL)
    setNewPreviews(urls)
    return () => urls.forEach(URL.revokeObjectURL)
  }, [newFiles])

  useEffect(() => {
    if (!order) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError('')
      setNewFiles([])
      try {
        const [{ data: itemData, error: itemErr }, { data: slipData, error: slipErr }] = await Promise.all([
          supabase.from('or_order_items').select('id, product_name, ink_color, cartoon_pattern, line_pattern, font, line_1, line_2, line_3, quantity, unit_price, is_free').eq('order_id', order.id).order('created_at'),
          supabase.from('ac_verified_slips').select('id, slip_image_url, slip_storage_path').eq('order_id', order.id).or('is_deleted.is.null,is_deleted.eq.false').order('created_at'),
        ])
        if (itemErr) throw itemErr
        if (slipErr) throw slipErr
        const loadedRows = (itemData || []) as ItemRow[]
        const loadedSlips: SlipRow[] = []
        for (const raw of (slipData || []) as { id: string; slip_image_url?: string | null; slip_storage_path?: string | null }[]) {
          let url = raw.slip_image_url || ''
          if (raw.slip_storage_path) {
            const [bucket, ...parts] = raw.slip_storage_path.split('/')
            const signed = await supabase.storage.from(bucket || 'slip-images').createSignedUrl(parts.join('/'), 3600)
            if (signed.data?.signedUrl) url = signed.data.signedUrl
          }
          if (url) loadedSlips.push({ id: raw.id, url, name: `สลิป ${loadedSlips.length + 1}` })
        }
        if (!cancelled) {
          setRows(loadedRows)
          setInitialIds(loadedRows.map((r) => r.id))
          setShipping(Number(order.shipping_cost) || 0)
          setSlips(loadedSlips)
        }
      } catch (e) {
        if (!cancelled) setError((e as Error)?.message || String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [order])

  const itemsTotal = rows.reduce((sum, r) => sum + (r.is_free ? 0 : (Number(r.quantity) || 0) * (Number(r.unit_price) || 0)), 0)
  const total = itemsTotal + (Number(shipping) || 0) - (Number(order?.discount) || 0)

  async function removeSlip(slip: SlipRow) {
    setDeletingSlip(true)
    setError('')
    try {
      const { error: deleteError } = await supabase.from('ac_verified_slips').update({ is_deleted: true }).eq('id', slip.id)
      if (deleteError) throw deleteError
      setSlips((prev) => prev.filter((s) => s.id !== slip.id))
      setDeleteSlipTarget(null)
    } catch (e) {
      setError((e as Error)?.message || String(e))
    } finally {
      setDeletingSlip(false)
    }
  }

  async function save() {
    if (!order || rows.length === 0) return
    if (rows.some((r) => (Number(r.quantity) || 0) < 1)) { setError('จำนวนสินค้าต้องไม่น้อยกว่า 1'); return }
    setSaving(true)
    setError('')
    try {
      const currentIds = new Set(rows.map((r) => r.id))
      const removedIds = initialIds.filter((id) => !currentIds.has(id))
      if (removedIds.length) {
        const { error: delErr } = await supabase.from('or_order_items').delete().in('id', removedIds)
        if (delErr) throw delErr
      }
      for (const row of rows) {
        const { id, ...values } = row
        const { error: rowErr } = await supabase.from('or_order_items').update(values).eq('id', id)
        if (rowErr) throw rowErr
      }
      const { error: orderErr } = await supabase.from('or_orders').update({ price: itemsTotal, shipping_cost: Number(shipping) || 0, total_amount: total }).eq('id', order.id)
      if (orderErr) throw orderErr

      if (newFiles.length > 0) {
        const outcome = await verifyAndSaveClaimSlips({
          orderId: order.id,
          billNo: order.bill_no,
          channelCode: order.channel_code || null,
          expectedAmount: total,
          files: newFiles,
          verifiedBy: user?.id ?? null,
        })
        if (outcome.passed) {
          const mobilePhone = (order.billing_details as { mobile_phone?: string } | null)?.mobile_phone || ''
          const { error: confirmErr } = await supabase.rpc('rpc_confirm_claim_req_shipping', {
            p_order_id: order.id,
            p_recipient_name: String(order.recipient_name || '').trim(),
            p_customer_address: String(order.customer_address || '').trim(),
            p_mobile_phone: String(mobilePhone).trim(),
          })
          if (confirmErr) throw confirmErr
        }
        const { error: statusErr } = await supabase.from('or_orders').update({ status: outcome.passed ? 'ตรวจสอบแล้ว' : 'ตรวจสอบไม่ผ่าน' }).eq('id', order.id)
        if (statusErr) throw statusErr
        setVerifyResult({
          type: outcome.passed ? 'success' : 'failed',
          accountMatch: outcome.accountMatch,
          bankCodeMatch: outcome.bankCodeMatch,
          amountStatus: outcome.amountStatus,
          orderAmount: total,
          totalAmount: outcome.totalFromSlips,
          errors: outcome.errors,
          statusMessage: outcome.passed
            ? 'ตรวจสลิปผ่าน — บิลถูกย้ายไปเมนู "ตรวจสอบแล้ว" เรียบร้อย'
            : 'ตรวจสลิปไม่ผ่าน — บิลยังอยู่ในเมนู "ตรวจสอบไม่ผ่าน"',
        })
        setNewFiles([])
        onClose()
        return
      }
      await onSaved()
      onClose()
    } catch (e) {
      setError((e as Error)?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Modal open={!!order} onClose={() => !saving && onClose()} contentClassName="max-w-7xl w-full max-h-[92vh] flex flex-col" closeOnBackdropClick={false}>
        <div className="flex min-h-0 flex-1 flex-col p-5">
          <h3 className="text-lg font-bold">แก้ไขบิลเคลม</h3>
          <p className="mb-3 text-sm text-gray-600">บิลเคลม: <strong className="font-mono">{order?.bill_no}</strong> — แก้ไขและส่งสลิปตรวจ EasySlip ซ้ำ</p>
          {loading ? <div className="py-12 text-center text-gray-500">กำลังโหลด...</div> : (
            <>
              <div className="mb-3 max-h-[38vh] min-h-[150px] overflow-auto rounded-lg border">
                <table className="w-full min-w-[1100px] text-xs sm:text-sm">
                  <thead className="sticky top-0 bg-gray-100"><tr>{['สินค้า','สีหมึก','ลาย','เส้น','ฟอนต์','บรรทัด 1','บรรทัด 2','บรรทัด 3','จำนวน','ราคา/หน่วย',''].map((h) => <th key={h} className="p-2 text-left">{h}</th>)}</tr></thead>
                  <tbody>{rows.map((row, idx) => <tr key={row.id} className="border-t">
                    <td className="p-2">{row.product_name || '–'}</td>
                    {(['ink_color','cartoon_pattern','line_pattern','font','line_1','line_2','line_3'] as const).map((field) => <td key={field} className="p-1"><input className="w-full rounded border px-2 py-1" value={row[field] || ''} onChange={(e) => setRows((p) => p.map((r,i) => i === idx ? {...r,[field]:e.target.value} : r))} /></td>)}
                    <td className="p-1"><input type="number" min={1} className="w-16 rounded border px-2 py-1" value={Number(row.quantity)||1} onChange={(e) => setRows((p) => p.map((r,i) => i===idx ? {...r,quantity:Number(e.target.value)} : r))}/></td>
                    <td className="p-1"><input type="number" min={0} step="0.01" className="w-20 rounded border px-2 py-1" value={Number(row.unit_price)||0} onChange={(e) => setRows((p) => p.map((r,i) => i===idx ? {...r,unit_price:Number(e.target.value),is_free:false} : r))}/></td>
                    <td className="p-1"><button type="button" className="text-red-600" onClick={() => setRows((p) => p.filter((_,i) => i!==idx))}>ลบ</button></td>
                  </tr>)}</tbody>
                </table>
              </div>
              <div className="mb-3 grid gap-4 lg:grid-cols-[1fr_320px]">
                <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-3">
                  <div className="mb-2 flex items-center justify-between"><strong>สลิปโอน</strong><label className="cursor-pointer rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700">อัปสลิปใหม่<input type="file" accept="image/*" multiple className="sr-only" onChange={(e) => setNewFiles(Array.from(e.target.files || []))}/></label></div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                    {slips.map((slip) => <div key={slip.id} className="overflow-hidden rounded border bg-white"><button type="button" onClick={() => setZoomUrl(slip.url)} className="block w-full"><img src={slip.url} alt={slip.name} className="h-36 w-full object-contain"/></button><button type="button" onClick={() => setDeleteSlipTarget(slip)} className="w-full border-t py-1 text-xs text-red-600">ลบสลิป</button></div>)}
                    {newPreviews.map((url,i) => <div key={url} className="overflow-hidden rounded border border-blue-300 bg-white"><button type="button" onClick={() => setZoomUrl(url)} className="block w-full"><img src={url} alt={`สลิปใหม่ ${i+1}`} className="h-36 w-full object-contain"/></button><button type="button" onClick={() => setNewFiles((p) => p.filter((_,x) => x!==i))} className="w-full border-t py-1 text-xs text-red-600">ลบ</button></div>)}
                  </div>
                </div>
                <div className="rounded-lg border bg-gray-50 p-4 text-sm space-y-2"><div className="flex justify-between"><span>ยอดสินค้า</span><span>{itemsTotal.toLocaleString('th-TH',{minimumFractionDigits:2})}</span></div><div className="flex items-center justify-between"><span>ค่าขนส่ง</span><input type="number" min={0} className="w-24 rounded border px-2 py-1 text-right" value={shipping} onChange={(e)=>setShipping(Number(e.target.value))}/></div><div className="flex justify-between border-t pt-2 font-bold"><span>ยอดสุทธิ</span><span>{total.toLocaleString('th-TH',{minimumFractionDigits:2})}</span></div></div>
              </div>
            </>
          )}
          {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-2"><button type="button" disabled={saving} onClick={onClose} className="rounded-lg border px-4 py-2">ยกเลิก</button><button type="button" disabled={saving || loading || rows.length===0} onClick={() => void save()} className="rounded-lg bg-amber-500 px-4 py-2 font-medium text-white disabled:opacity-50">{saving ? (newFiles.length ? 'กำลังตรวจ EasySlip...' : 'กำลังบันทึก...') : newFiles.length ? 'บันทึกและตรวจ EasySlip' : 'บันทึกการแก้ไข'}</button></div>
        </div>
      </Modal>
      {verifyResult && (
        <VerificationResultModal
          open
          onClose={() => {
            setVerifyResult(null)
            void onSaved()
          }}
          type={verifyResult.type}
          accountMatch={verifyResult.accountMatch}
          bankCodeMatch={verifyResult.bankCodeMatch}
          amountStatus={verifyResult.amountStatus}
          orderAmount={verifyResult.orderAmount}
          totalAmount={verifyResult.totalAmount}
          errors={verifyResult.errors}
          statusMessage={verifyResult.statusMessage}
        />
      )}
      <Modal
        open={!!deleteSlipTarget}
        onClose={() => !deletingSlip && setDeleteSlipTarget(null)}
        contentClassName="max-w-sm w-[calc(100vw-2rem)]"
        closeOnBackdropClick={!deletingSlip}
      >
        <div className="p-6">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 text-red-600">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-6 w-6" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 7h12m-10 0 1 13h6l1-13m-6 4v5m4-5v5m-5-9 1-3h4l1 3" />
            </svg>
          </div>
          <h4 className="text-center text-lg font-bold text-gray-900">ยืนยันการลบสลิป</h4>
          <p className="mt-2 text-center text-sm text-gray-600">ต้องการลบสลิปนี้ออกจากบิลเคลมหรือไม่?</p>
          <div className="mt-6 flex justify-center gap-3">
            <button
              type="button"
              disabled={deletingSlip}
              onClick={() => setDeleteSlipTarget(null)}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              ยกเลิก
            </button>
            <button
              type="button"
              disabled={deletingSlip || !deleteSlipTarget}
              onClick={() => deleteSlipTarget && void removeSlip(deleteSlipTarget)}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {deletingSlip ? 'กำลังลบ...' : 'ลบสลิป'}
            </button>
          </div>
        </div>
      </Modal>
      {zoomUrl && <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/80 p-6" onClick={() => setZoomUrl(null)}><div className="relative" onClick={(e)=>e.stopPropagation()}><img src={zoomUrl} alt="สลิปขยาย" className="max-h-[90vh] max-w-[92vw] rounded bg-white object-contain"/><button type="button" onClick={()=>setZoomUrl(null)} className="absolute right-2 top-2 h-10 w-10 rounded-full bg-black/70 text-2xl text-white">×</button></div></div>}
    </>
  )
}
