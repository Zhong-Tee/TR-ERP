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
  const [loading, setLoading] = useState(false)
  const [thumbs, setThumbs] = useState<Record<string, string[]>>({})
  const [viewer, setViewer] = useState<{ billNo: string; urls: string[]; loading: boolean } | null>(null)
  const [viewerFailed, setViewerFailed] = useState<Set<number>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('ac_refunds')
        .select('*, or_orders(bill_no, customer_name, customer_address, admin_user)')
        .eq('status', 'approved')
        .order('approved_at', { ascending: false })
      if (error) throw error
      let list = ((data || []) as RefundRow[]).filter((r) => (r.refund_slip_paths?.length || 0) > 0)

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

  // โหลด thumbnail (signed URL) ของแต่ละรายการ
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const map: Record<string, string[]> = {}
      for (const r of rows) {
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
    setViewer({ billNo: r.or_orders?.bill_no || '–', urls: [], loading: true })
    try {
      const urls = await getSignedUrlsFromStoragePaths(r.refund_slip_paths || [])
      setViewer({ billNo: r.or_orders?.bill_no || '–', urls, loading: false })
    } catch {
      setViewer({ billNo: r.or_orders?.bill_no || '–', urls: [], loading: false })
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
          <p className="text-sm text-gray-500 mt-0.5">รายการที่บัญชีอนุมัติโอนคืนและแนบสลิปแล้ว — คลิกดูสลิปเพื่อส่งให้ลูกค้า</p>
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

      {loading ? (
        <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-500 border-t-transparent" /></div>
      ) : rows.length === 0 ? (
        <div className="text-center py-12 text-gray-500 text-base">ยังไม่มีรายการโอนคืนที่มีสลิป</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-100">
          <table className="w-full text-base">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">เลขบิล</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">ชื่อลูกค้า</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">ชื่อบัญชีรับคืน</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">ธนาคาร</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">เลขบัญชี</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">จำนวนเงินคืน</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">วันที่อนุมัติ</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">สลิปโอนคืน</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-gray-100 hover:bg-emerald-50/40 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-800 whitespace-nowrap">
                    <span>{r.or_orders?.bill_no || '–'}</span>
                    {(r.or_orders?.bill_no || '').startsWith('REQ') && (
                      <span className="ml-1.5 px-1.5 py-0.5 text-xs font-medium rounded bg-amber-100 text-amber-800 border border-amber-200">เคลม</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-700">{r.or_orders?.customer_name || '–'}</td>
                  <td className="px-4 py-3 text-gray-700 text-sm max-w-[140px] truncate" title={r.refund_recipient_account_name || ''}>{r.refund_recipient_account_name?.trim() || '–'}</td>
                  <td className="px-4 py-3 text-gray-700 text-sm max-w-[120px] truncate" title={r.refund_recipient_bank || ''}>{r.refund_recipient_bank?.trim() || '–'}</td>
                  <td className="px-4 py-3 text-gray-700 text-sm font-mono tabular-nums max-w-[140px] truncate" title={r.refund_recipient_account_number || ''}>{r.refund_recipient_account_number?.trim() || '–'}</td>
                  <td className="px-4 py-3 font-semibold text-emerald-600 tabular-nums whitespace-nowrap">฿{Number(r.amount || 0).toLocaleString()}</td>
                  <td className="px-4 py-3 text-gray-500 text-sm whitespace-nowrap">{r.approved_at ? formatDateTime(r.approved_at) : '–'}</td>
                  <td className="px-4 py-3">
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
                        <button
                          type="button"
                          onClick={() => void downloadFileFromUrl(url, `สลิปโอนคืน-${viewer.billNo}-${idx + 1}.jpg`)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 text-sm font-medium transition-colors"
                        >
                          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                          ดาวน์โหลดรูป
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}
