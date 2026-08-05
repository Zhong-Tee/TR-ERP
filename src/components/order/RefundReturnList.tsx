import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { formatDateTime, downloadFileFromUrl } from '../../lib/utils'
import { getSignedUrlsFromStoragePaths } from '../../lib/slipVerification'
import { useAuthContext } from '../../contexts/AuthContext'
import {
  isAdminOrSuperadmin,
  isSalesPumpOwnerScopedRole,
  isSalesTrTeamRole,
  resolveSalesPumpOwnerAdminName,
} from '../../config/accessPolicy'
import { fetchSalesTrTeamAdminValues } from '../../lib/salesTrTeam'
import Modal from '../ui/Modal'
import type { Refund } from '../../types'

type RefundRow = Refund & {
  or_orders?: { bill_no?: string; customer_name?: string; customer_address?: string; admin_user?: string } | null
}

/**
 * แท็บ "โอนคืน" (หน้าออเดอร์) — ให้ Sales ดูรายการที่บัญชีอนุมัติโอนคืนแล้ว
 * และมีสลิปโอนคืน เพื่อคลิกดู/ส่งต่อให้ลูกค้า
 * แสดงเฉพาะรายการที่ status = approved และมี refund_slip_paths
 */
export default function RefundReturnList() {
  const { user } = useAuthContext()
  const [rows, setRows] = useState<RefundRow[]>([])
  const [subTab, setSubTab] = useState<'pending' | 'approved' | 'done'>('pending')
  const [loading, setLoading] = useState(false)
  const [thumbs, setThumbs] = useState<Record<string, string[]>>({})
  const [viewer, setViewer] = useState<{ billNo: string; urls: string[]; loading: boolean } | null>(null)
  const [viewerFailed, setViewerFailed] = useState<Set<number>>(new Set())
  const [copyResult, setCopyResult] = useState<{ index: number; message: string; error: boolean } | null>(null)
  const [slipSentModal, setSlipSentModal] = useState<{ refund: RefundRow; submitting: boolean; error: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('ac_refunds')
        .select('*, or_orders(bill_no, customer_name, customer_address, admin_user)')
        .in('status', ['pending', 'approved'])
        .order('created_at', { ascending: false })
      if (error) throw error
      let list = (data || []) as RefundRow[]

      // ขอบเขต: sales-pump = เฉพาะบิลตัวเอง, sales-tr = ทั้งทีม, admin/superadmin = ทั้งหมด
      if (isSalesPumpOwnerScopedRole(user?.role)) {
        const owner = resolveSalesPumpOwnerAdminName(user?.role, user?.username, user?.email)
        list = list.filter((r) => {
          const a = (r.or_orders?.admin_user || '').trim()
          return owner && (a === owner || a === user?.username || a === user?.email)
        })
      } else if (isSalesTrTeamRole(user?.role)) {
        let team: string[] = []
        try { team = await fetchSalesTrTeamAdminValues(supabase) } catch { team = [] }
        list = list.filter((r) => team.includes((r.or_orders?.admin_user || '').trim()))
      }
      setRows(list)
    } catch (e) {
      console.error('Error loading refund returns:', e)
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [user?.role, user?.username, user?.email])

  useEffect(() => { void load() }, [load])

  // รายการที่ "แนบสลิปแล้ว" = อนุมัติแล้ว; ที่ "ยังไม่แนบสลิป" = รอบัญชีแนบสลิป
  // เมื่อบัญชีกด "ส่งสลิปแล้ว" (refund_slip_sent_at) รายการจะย้ายไปแท็บ "เสร็จสิ้น"
  const withSlipRows = rows.filter((r) => (r.refund_slip_paths?.length || 0) > 0)
  const doneRows = withSlipRows.filter((r) => !!r.refund_slip_sent_at)
  const approvedRows = withSlipRows.filter((r) => !r.refund_slip_sent_at)
  const pendingRows = rows.filter((r) => (r.refund_slip_paths?.length || 0) === 0)
  const displayRows = subTab === 'done' ? doneRows : subTab === 'approved' ? approvedRows : pendingRows

  // โหลด thumbnail (signed URL) เฉพาะรายการที่มีสลิป
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const map: Record<string, string[]> = {}
      for (const r of rows) {
        if ((r.refund_slip_paths?.length || 0) === 0) continue
        const urls = await getSignedUrlsFromStoragePaths(r.refund_slip_paths || [])
        if (cancelled) return
        map[r.id] = urls
      }
      if (!cancelled) setThumbs(map)
    })()
    return () => { cancelled = true }
  }, [rows])

  async function openViewer(r: RefundRow) {
    setViewerFailed(new Set())
    setCopyResult(null)
    setViewer({ billNo: r.or_orders?.bill_no || '–', urls: [], loading: true })
    try {
      const urls = await getSignedUrlsFromStoragePaths(r.refund_slip_paths || [])
      setViewer({ billNo: r.or_orders?.bill_no || '–', urls, loading: false })
    } catch {
      setViewer({ billNo: r.or_orders?.bill_no || '–', urls: [], loading: false })
    }
  }

  async function copySlipImage(url: string, index: number) {
    setCopyResult(null)
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        throw new Error('เบราว์เซอร์นี้ไม่รองรับการคัดลอกรูป')
      }

      const pngBlob = fetch(url).then(async (response) => {
        if (!response.ok) throw new Error(`โหลดรูปไม่สำเร็จ (HTTP ${response.status})`)
        const sourceBlob = await response.blob()
        if (sourceBlob.type === 'image/png') return sourceBlob

        const bitmap = await createImageBitmap(sourceBlob)
        try {
          const canvas = document.createElement('canvas')
          canvas.width = bitmap.width
          canvas.height = bitmap.height
          const context = canvas.getContext('2d')
          if (!context) throw new Error('ไม่สามารถเตรียมรูปสำหรับคัดลอกได้')
          context.drawImage(bitmap, 0, 0)
          return await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('แปลงรูปไม่สำเร็จ')), 'image/png')
          })
        } finally {
          bitmap.close()
        }
      })

      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })])
      setCopyResult({ index, message: 'คัดลอกรูปแล้ว', error: false })
    } catch (error: any) {
      console.error('Error copying refund slip image:', error)
      setCopyResult({ index, message: error?.message || 'คัดลอกรูปไม่สำเร็จ', error: true })
    }
  }

  async function confirmSlipSent() {
    if (!user || !slipSentModal) return
    const refund = slipSentModal.refund
    setSlipSentModal((prev) => prev ? { ...prev, submitting: true, error: '' } : prev)
    try {
      const sentAt = new Date().toISOString()
      const { error } = await supabase
        .from('ac_refunds')
        .update({ refund_slip_sent_at: sentAt, refund_slip_sent_by: user.id })
        .eq('id', refund.id)
        .eq('status', 'approved')
        .is('refund_slip_sent_at', null)
      if (error) throw error

      setRows((prev) => prev.map((row) => row.id === refund.id
        ? { ...row, refund_slip_sent_at: sentAt, refund_slip_sent_by: user.id }
        : row))
      setSlipSentModal(null)
      setSubTab('done')
      window.dispatchEvent(new CustomEvent('sidebar-refresh-counts'))
    } catch (error: any) {
      console.error('Error marking refund slip as sent:', error)
      setSlipSentModal((prev) => prev
        ? { ...prev, submitting: false, error: error?.message || 'บันทึกสถานะไม่สำเร็จ' }
        : prev)
    }
  }

  const canSee = isAdminOrSuperadmin(user?.role) || user?.role === 'sales-tr' || isSalesPumpOwnerScopedRole(user?.role)
  if (!canSee) {
    return <div className="text-center py-12 text-gray-500">ไม่มีสิทธิ์เข้าถึงรายการโอนคืน</div>
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">รายการโอนคืน</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            {subTab === 'pending'
              ? 'รายการที่รอบัญชีอนุมัติ/แนบสลิปโอนคืน'
              : subTab === 'approved'
                ? 'รายการที่บัญชีอนุมัติและแนบสลิปแล้ว — คลิกดูสลิปเพื่อส่งให้ลูกค้า'
                : 'รายการที่บัญชียืนยันส่งสลิปให้ลูกค้าแล้ว — ปิดงานโอนคืนเรียบร้อย'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="px-4 py-2 border border-gray-300 rounded-xl hover:bg-gray-50 font-semibold text-sm disabled:opacity-50"
        >
          {loading ? 'กำลังโหลด...' : 'รีเฟรช'}
        </button>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-4 border-b border-gray-200">
        <button
          type="button"
          onClick={() => setSubTab('pending')}
          className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors ${subTab === 'pending' ? 'border-amber-500 text-amber-600' : 'border-transparent text-gray-500 hover:text-amber-600'}`}
        >
          รออนุมัติ{pendingRows.length > 0 && <span className="ml-1 text-amber-600">({pendingRows.length})</span>}
        </button>
        <button
          type="button"
          onClick={() => setSubTab('approved')}
          className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors ${subTab === 'approved' ? 'border-emerald-500 text-emerald-600' : 'border-transparent text-gray-500 hover:text-emerald-600'}`}
        >
          อนุมัติแล้ว{approvedRows.length > 0 && <span className="ml-1 text-emerald-600">({approvedRows.length})</span>}
        </button>
        <button
          type="button"
          onClick={() => setSubTab('done')}
          className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors ${subTab === 'done' ? 'border-violet-500 text-violet-600' : 'border-transparent text-gray-500 hover:text-violet-600'}`}
        >
          เสร็จสิ้น{doneRows.length > 0 && <span className="ml-1 text-violet-600">({doneRows.length})</span>}
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-500 border-t-transparent" /></div>
      ) : displayRows.length === 0 ? (
        <div className="text-center py-12 text-gray-500 text-base">
          {subTab === 'pending' ? 'ไม่มีรายการที่รอบัญชีแนบสลิป' : subTab === 'approved' ? 'ยังไม่มีรายการที่แนบสลิปแล้ว' : 'ยังไม่มีรายการโอนคืนที่เสร็จสิ้น'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-100">
          <table className="w-full text-base">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">เลขบิล</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">ชื่อลูกค้า</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">ผู้สร้าง</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">ชื่อบัญชีรับคืน</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">ธนาคาร</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">เลขบัญชี</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">จำนวนเงินคืน</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">วันที่อนุมัติ</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">{subTab === 'pending' ? 'สถานะ' : 'สลิปโอนคืน'}</th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map((r) => (
                <tr key={r.id} className="border-b border-gray-100 hover:bg-emerald-50/40 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-800 whitespace-nowrap">
                    <span>{r.or_orders?.bill_no || '–'}</span>
                    {(r.or_orders?.bill_no || '').startsWith('REQ') && (
                      <span className="ml-1.5 px-1.5 py-0.5 text-xs font-medium rounded bg-amber-100 text-amber-800 border border-amber-200">เคลม</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-700">{r.or_orders?.customer_name || '–'}</td>
                  <td className="px-4 py-3 text-gray-700 text-sm max-w-[140px] truncate" title={r.or_orders?.admin_user || ''}>{r.or_orders?.admin_user?.trim() || '–'}</td>
                  <td className="px-4 py-3 text-gray-700 text-sm max-w-[140px] truncate" title={r.refund_recipient_account_name || ''}>{r.refund_recipient_account_name?.trim() || '–'}</td>
                  <td className="px-4 py-3 text-gray-700 text-sm max-w-[120px] truncate" title={r.refund_recipient_bank || ''}>{r.refund_recipient_bank?.trim() || '–'}</td>
                  <td className="px-4 py-3 text-gray-700 text-sm font-mono tabular-nums max-w-[140px] truncate" title={r.refund_recipient_account_number || ''}>{r.refund_recipient_account_number?.trim() || '–'}</td>
                  <td className="px-4 py-3 font-semibold text-emerald-600 tabular-nums whitespace-nowrap">฿{Number(r.amount || 0).toLocaleString()}</td>
                  <td className="px-4 py-3 text-gray-500 text-sm whitespace-nowrap">{r.approved_at ? formatDateTime(r.approved_at) : '–'}</td>
                  <td className="px-4 py-3">
                    {subTab !== 'pending' ? (
                      <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void openViewer(r)}
                        title="ดูสลิปโอนคืน"
                        className="relative w-12 h-12 rounded-lg border border-emerald-300 overflow-hidden bg-gray-50 hover:ring-2 hover:ring-emerald-400 transition-all"
                      >
                        {thumbs[r.id]?.[0] ? (
                          <img src={thumbs[r.id][0]} alt="สลิปโอนคืน" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                        ) : (
                          <span className="flex items-center justify-center w-full h-full text-emerald-500"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg></span>
                        )}
                        {(r.refund_slip_paths?.length || 0) > 1 && (
                          <span className="absolute bottom-0 right-0 px-1 text-[10px] font-bold bg-emerald-600 text-white rounded-tl">{r.refund_slip_paths!.length}</span>
                        )}
                      </button>
                      {subTab === 'approved' && (
                        <button
                          type="button"
                          onClick={() => setSlipSentModal({ refund: r, submitting: false, error: '' })}
                          className="inline-flex items-center gap-1.5 whitespace-nowrap px-3 py-2 bg-sky-500 text-white rounded-lg hover:bg-sky-600 text-sm font-medium transition-colors"
                        >
                          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
                          ส่งสลิปแล้ว
                        </button>
                      )}
                      {subTab === 'done' && (
                        <span className="inline-flex px-2.5 py-1 rounded-lg text-xs font-medium bg-violet-100 text-violet-700 whitespace-nowrap">โอนคืนเสร็จสิ้น</span>
                      )}
                      </div>
                    ) : r.status === 'approved' ? (
                      <span className="inline-flex px-2.5 py-1 rounded-lg text-xs font-medium bg-sky-100 text-sky-700 whitespace-nowrap">อนุมัติแล้ว · รอแนบสลิป</span>
                    ) : (
                      <span className="inline-flex px-2.5 py-1 rounded-lg text-xs font-medium bg-amber-100 text-amber-700 whitespace-nowrap">รอบัญชีอนุมัติ</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal ดูสลิปโอนคืน */}
      {viewer && (
        <Modal open onClose={() => setViewer(null)} closeOnBackdropClick contentClassName="max-w-md w-full max-h-[90vh] overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
            <h3 className="text-base font-semibold text-gray-800">สลิปโอนคืน — บิล {viewer.billNo}</h3>
            <button type="button" onClick={() => setViewer(null)} className="p-2 rounded-lg hover:bg-gray-100 text-gray-600">✕</button>
          </div>
          <div className="p-4 overflow-y-auto flex-1">
            {viewer.loading ? (
              <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-8 w-8 border-2 border-emerald-500 border-t-transparent" /></div>
            ) : viewer.urls.length === 0 ? (
              <p className="text-center text-gray-500 py-6 text-sm">ไม่พบภาพสลิปโอนคืน</p>
            ) : (
              <div className="space-y-4">
                {viewer.urls.map((url, idx) => (
                  <div key={idx} className="flex flex-col items-center gap-2">
                    {viewerFailed.has(idx) ? (
                      <div className="flex flex-col items-center justify-center py-8 px-4 rounded-lg border border-amber-200 bg-amber-50 text-amber-800 min-h-[120px]">
                        <p className="font-medium text-sm">โหลดรูปไม่สำเร็จ</p>
                        <a href={url} target="_blank" rel="noopener noreferrer" className="mt-2 text-xs text-sky-600 hover:underline">เปิดในแท็บใหม่</a>
                      </div>
                    ) : (
                      <>
                        <img src={url} alt={`สลิปโอนคืน ${idx + 1}`} className="max-w-full h-auto rounded-lg border border-gray-200 shadow-sm" referrerPolicy="no-referrer" onError={() => setViewerFailed(prev => new Set(prev).add(idx))} />
                        <div className="flex flex-wrap items-center justify-center gap-2">
                          <button
                            type="button"
                            onClick={() => void downloadFileFromUrl(url, `สลิปโอนคืน-${viewer.billNo}-${idx + 1}.jpg`)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 text-sm font-medium transition-colors"
                          >
                            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                            ดาวน์โหลดรูป
                          </button>
                          <button
                            type="button"
                            onClick={() => void copySlipImage(url, idx)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-sky-500 text-white rounded-lg hover:bg-sky-600 text-sm font-medium transition-colors"
                          >
                            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                            คัดลอกรูป
                          </button>
                        </div>
                        {copyResult?.index === idx && (
                          <p className={`text-xs font-medium ${copyResult.error ? 'text-red-600' : 'text-emerald-600'}`}>{copyResult.message}</p>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Modal>
      )}

      {slipSentModal && (
        <Modal open onClose={() => { if (!slipSentModal.submitting) setSlipSentModal(null) }} contentClassName="max-w-md w-full">
          <div className="p-6">
            <h3 className="text-lg font-bold text-gray-900 mb-2">ยืนยันส่งสลิปโอนคืนแล้ว</h3>
            <p className="text-sm text-gray-600 mb-2">
              ยืนยันว่าได้ส่งสลิปโอนคืนของบิล <span className="font-semibold text-gray-800">{slipSentModal.refund.or_orders?.bill_no || '—'}</span> ให้ลูกค้าแล้วหรือไม่?
            </p>
            <p className="text-sm text-gray-500 mb-5">เมื่อยืนยัน รายการจะย้ายไปแท็บ “เสร็จสิ้น” ทันที</p>
            {slipSentModal.error && (
              <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{slipSentModal.error}</p>
            )}
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setSlipSentModal(null)}
                disabled={slipSentModal.submitting}
                className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50 text-sm font-medium"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={() => void confirmSlipSent()}
                disabled={slipSentModal.submitting}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-600 text-white text-sm font-medium disabled:opacity-50"
              >
                {slipSentModal.submitting && <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />}
                {slipSentModal.submitting ? 'กำลังบันทึก...' : 'ยืนยัน'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
