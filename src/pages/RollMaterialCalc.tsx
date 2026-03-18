import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import Modal from '../components/ui/Modal'
import ProductImageHover from '../components/ui/ProductImageHover'
import {
  fetchRollCalcDashboard,
  upsertRollConfig,
  updateRollConfigField,
  deleteRollConfig,
  fetchAvailableFgProducts,
  fetchAvailableRmProducts,
} from '../lib/rollCalcApi'
import type { RollCalcDashboardRow, Product } from '../types'

export default function RollMaterialCalc() {
  // ── Data ─────────────────────────────────────────────
  const [rows, setRows] = useState<RollCalcDashboardRow[]>([])
  const [loading, setLoading] = useState(true)

  // ── Filters ──────────────────────────────────────────
  const [search, setSearch] = useState('')

  // ── Modals ──────────────────────────────────────────
  const [showPairModal, setShowPairModal] = useState(false)

  // ── Pair modal state ─────────────────────────────────
  const [fgProducts, setFgProducts] = useState<Product[]>([])
  const [rmProducts, setRmProducts] = useState<Product[]>([])
  const [pairFgId, setPairFgId] = useState('')
  const [pairRmIds, setPairRmIds] = useState<string[]>([])
  const [pairSaving, setPairSaving] = useState(false)
  const [fgSearch, setFgSearch] = useState('')
  const [rmSearch, setRmSearch] = useState('')
  const [fgDropOpen, setFgDropOpen] = useState(false)
  const [rmDropOpen, setRmDropOpen] = useState(false)
  const fgRef = useRef<HTMLDivElement>(null)
  const rmRef = useRef<HTMLDivElement>(null)

  // ── Inline edit debounce ─────────────────────────────
  const [editingValues, setEditingValues] = useState<Record<string, { sheets?: string }>>({})
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set())

  // ── Notify ───────────────────────────────────────────
  const [notify, setNotify] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  // ── Load data ────────────────────────────────────────
  const loadAll = useCallback(async () => {
    try {
      setLoading(true)
      const dashData = await fetchRollCalcDashboard()
      setRows(dashData)
    } catch (err: unknown) {
      console.error(err)
      const message = err instanceof Error ? err.message : 'unknown error'
      setNotify({ type: 'error', message: `โหลดข้อมูลไม่สำเร็จ: ${message}` })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  // ── Close dropdowns on outside click ─────────────────
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (fgRef.current && !fgRef.current.contains(e.target as Node)) setFgDropOpen(false)
      if (rmRef.current && !rmRef.current.contains(e.target as Node)) setRmDropOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // ── Filter ───────────────────────────────────────────
  const filtered = useMemo(() => {
    if (!search) return rows
    const s = search.toLowerCase()
    return rows.filter(
      (r) =>
        r.fg_product_code.toLowerCase().includes(s) ||
        r.fg_product_name.toLowerCase().includes(s) ||
        r.rm_product_code.toLowerCase().includes(s) ||
        r.rm_product_name.toLowerCase().includes(s),
    )
  }, [rows, search])

  // ── Pair modal ───────────────────────────────────────
  const openPairModal = async () => {
    setShowPairModal(true)
    setPairFgId('')
    setPairRmIds([])
    setFgSearch('')
    setRmSearch('')
    try {
      const [fg, rm] = await Promise.all([fetchAvailableFgProducts(), fetchAvailableRmProducts()])
      setFgProducts(fg)
      setRmProducts(rm)
    } catch {
      setNotify({ type: 'error', message: 'โหลดรายการสินค้าไม่สำเร็จ' })
    }
  }

  const handlePairSave = async () => {
    if (!pairFgId || pairRmIds.length === 0) return
    try {
      setPairSaving(true)
      await upsertRollConfig({
        fg_product_id: pairFgId,
        rm_product_ids: pairRmIds,
      })
      setShowPairModal(false)
      setNotify({ type: 'success', message: 'จับคู่สินค้าสำเร็จ' })
      await loadAll()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'unknown error'
      setNotify({ type: 'error', message: `จับคู่สินค้าไม่สำเร็จ: ${message}` })
    } finally {
      setPairSaving(false)
    }
  }

  // ── Delete config ────────────────────────────────────
  const handleDeleteConfig = async (configId: string) => {
    if (!confirm('ต้องการลบการจับคู่นี้?')) return
    try {
      await deleteRollConfig(configId)
      setRows((prev) => prev.filter((r) => r.config_id !== configId))
      setNotify({ type: 'success', message: 'ลบการจับคู่แล้ว' })
    } catch {
      setNotify({ type: 'error', message: 'ลบไม่สำเร็จ' })
    }
  }

  // ── Inline edit ──────────────────────────────────────
  const getEditValue = (configId: string) => {
    const local = editingValues[configId]?.sheets
    if (local !== undefined) return local
    const row = rows.find((r) => r.config_id === configId)
    if (!row) return ''
    const val = row.sheets_per_roll
    return val != null ? String(val) : ''
  }

  const handleInlineChange = (configId: string, value: string) => {
    setEditingValues((prev) => ({
      ...prev,
      [configId]: { ...prev[configId], sheets: value },
    }))

    const timerKey = `${configId}_sheets`
    if (debounceTimers.current[timerKey]) clearTimeout(debounceTimers.current[timerKey])

    debounceTimers.current[timerKey] = setTimeout(async () => {
      const dbField = 'sheets_per_roll'
      const numVal = value === '' ? null : Number(value)
      try {
        setSavingIds((prev) => new Set(prev).add(configId))
        await updateRollConfigField(configId, dbField, numVal)
        setRows((prev) =>
          prev.map((r) => (r.config_id === configId ? { ...r, [dbField]: numVal } : r)),
        )
        setEditingValues((prev) => {
          const copy = { ...prev }
          if (copy[configId]) {
            delete copy[configId].sheets
            if (!copy[configId].sheets) delete copy[configId]
          }
          return copy
        })
      } catch {
        setNotify({ type: 'error', message: 'บันทึกไม่สำเร็จ' })
      } finally {
        setSavingIds((prev) => {
          const next = new Set(prev)
          next.delete(configId)
          return next
        })
      }
    }, 800)
  }

  // ── Helpers ──────────────────────────────────────────
  const fmtNum = (n: number | null | undefined, digits = 2) =>
    n != null ? n.toLocaleString('th-TH', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '-'

  const filteredFg = useMemo(() => {
    if (!fgSearch) return fgProducts.slice(0, 30)
    const s = fgSearch.toLowerCase()
    return fgProducts
      .filter((p) => p.product_code.toLowerCase().includes(s) || p.product_name.toLowerCase().includes(s))
      .slice(0, 30)
  }, [fgProducts, fgSearch])

  const filteredRm = useMemo(() => {
    if (!rmSearch) return rmProducts.slice(0, 30)
    const s = rmSearch.toLowerCase()
    return rmProducts
      .filter((p) => p.product_code.toLowerCase().includes(s) || p.product_name.toLowerCase().includes(s))
      .slice(0, 30)
  }, [rmProducts, rmSearch])

  const selectedFg = fgProducts.find((p) => p.id === pairFgId)
  const selectedRms = useMemo(
    () => rmProducts.filter((p) => pairRmIds.includes(p.id)),
    [rmProducts, pairRmIds],
  )

  // ── Render ───────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
      </div>
    )
  }

  return (
    <div className="space-y-5 mt-4">
      {/* ── Notification toast ─────────────────────────── */}
      {notify && (
        <div
          className={`fixed top-20 right-6 z-[60] px-5 py-3 rounded-xl shadow-lg text-white text-sm font-medium transition-all ${
            notify.type === 'success' ? 'bg-emerald-500' : 'bg-red-500'
          }`}
        >
          <div className="flex items-center gap-2">
            <i className={`fas ${notify.type === 'success' ? 'fa-check-circle' : 'fa-exclamation-circle'}`}></i>
            {notify.message}
            <button onClick={() => setNotify(null)} className="ml-2 hover:opacity-70">
              <i className="fas fa-times"></i>
            </button>
          </div>
        </div>
      )}

      {/* ── Header + Filters ──────────────────────────── */}
      <div className="bg-white p-5 rounded-lg shadow">
        <div className="flex flex-wrap items-center gap-3">
          {/* Search */}
          <div className="relative flex-1 min-w-[220px]">
            <i className="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"></i>
            <input
              type="text"
              placeholder="ค้นหาสินค้า..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-400 focus:border-blue-400 outline-none"
            />
          </div>

          {/* Pair button */}
          <button
            onClick={openPairModal}
            className="px-4 py-2.5 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition font-medium shadow-sm"
          >
            <i className="fas fa-link mr-2"></i>จับคู่สินค้า
          </button>

          {/* Refresh */}
          <button
            onClick={loadAll}
            className="px-3 py-2.5 text-gray-500 hover:text-blue-600 transition"
            title="รีเฟรช"
          >
            <i className="fas fa-sync-alt text-lg"></i>
          </button>
        </div>
      </div>

      {/* ── Table ─────────────────────────────────────── */}
      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-blue-600 text-white text-sm">
              <th className="p-3 text-center rounded-tl-lg w-16">รูปภาพ</th>
              <th className="p-3 text-left">รหัสสินค้า</th>
              <th className="p-3 text-left">ชื่อสินค้า</th>
              <th className="p-3 text-left text-xs">RM ที่ผูก</th>
              <th className="p-3 text-right">สต๊อคคงเหลือ</th>
              <th className="p-3 text-center">แผ่น/ม้วน</th>
              <th className="p-3 text-center rounded-tr-lg w-24">จัดการ</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center py-12 text-gray-400">
                  <i className="fas fa-box-open text-4xl mb-3 block"></i>
                  {rows.length === 0 ? 'ยังไม่มีการจับคู่สินค้า กดปุ่ม "จับคู่สินค้า" เพื่อเริ่มต้น' : 'ไม่พบรายการที่ตรงกับการค้นหา'}
                </td>
              </tr>
            ) : (
              filtered.map((r, idx) => {
                const stock =
                  r.sheets_per_roll != null ? r.rm_on_hand * r.sheets_per_roll : null
                const isSaving = savingIds.has(r.config_id)

                return (
                  <tr
                    key={r.config_id}
                    className={`border-b border-gray-100 ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'} hover:bg-blue-50 transition-colors`}
                  >
                    {/* Image */}
                    <td className="p-2 text-center">
                      <ProductImageHover productCode={r.fg_product_code} productName={r.fg_product_name} size="sm" />
                    </td>

                    {/* Code */}
                    <td className="p-3 text-sm font-mono font-semibold text-gray-800">
                      {r.fg_product_code}
                    </td>

                    {/* Name */}
                    <td className="p-3 text-sm text-gray-700">{r.fg_product_name}</td>

                    {/* RM linked */}
                    <td className="p-3 text-xs text-gray-500">
                      {(() => {
                        const rmCodes = r.rm_product_code
                          .split('\n')
                          .map((x) => x.trim())
                          .filter((x) => x && x !== '-')
                        const rmNames = r.rm_product_name
                          .split('\n')
                          .map((x) => x.trim())
                          .filter((x) => x && x !== '-')
                        const firstRmCode = rmCodes[0] ?? ''
                        const firstRmName = rmNames[0] ?? ''
                        return (
                          <div className="flex items-start gap-2">
                            {firstRmCode ? (
                              <ProductImageHover productCode={firstRmCode} productName={firstRmName} size="sm" />
                            ) : (
                              <div className="w-14 h-14 bg-gray-100 rounded-lg border border-gray-200 flex items-center justify-center text-gray-400 text-[10px]">
                                ไม่มีรูป
                              </div>
                            )}
                            <div className="min-w-0">
                              <span className="font-mono whitespace-pre-line">{r.rm_product_code}</span>
                              <div className="text-gray-400 whitespace-pre-line">{r.rm_product_name}</div>
                              {rmCodes.length > 1 && (
                                <div className="mt-1 inline-flex items-center px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 text-[10px]">
                                  ผูก {rmCodes.length} รายการ
                                </div>
                              )}
                            </div>
                          </div>
                        )
                      })()}
                    </td>

                    {/* Stock (computed) */}
                    <td className="p-3 text-right text-sm font-semibold">
                      {stock != null ? (
                        <span className="text-emerald-600">{fmtNum(stock, 0)}</span>
                      ) : (
                        <span className="text-gray-300">-</span>
                      )}
                      <div className="text-xs text-gray-400 font-normal">
                        ({fmtNum(r.rm_on_hand, 0)} ม้วน)
                      </div>
                    </td>

                    {/* Sheets per roll (manual input) */}
                    <td className="p-3 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={getEditValue(r.config_id)}
                          onChange={(e) => handleInlineChange(r.config_id, e.target.value)}
                          className="w-20 px-2 py-1.5 border border-gray-300 rounded-lg text-center text-sm focus:ring-2 focus:ring-blue-400 focus:border-blue-400 outline-none"
                          placeholder="-"
                        />
                        {isSaving && <i className="fas fa-spinner fa-spin text-blue-400 text-xs"></i>}
                      </div>
                    </td>

                    {/* Actions */}
                    <td className="p-3 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => handleDeleteConfig(r.config_id)}
                          className="p-2 text-red-400 bg-red-50 hover:text-white hover:bg-red-500 rounded-lg transition"
                          title="ลบการจับคู่"
                        >
                          <i className="fas fa-trash-alt text-base"></i>
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Summary */}
      <div className="text-sm text-gray-400 text-right">
        แสดง {filtered.length} / {rows.length} รายการ
      </div>

      {/* ════════════════════════════════════════════════ */}
      {/* Pair Modal                                      */}
      {/* ════════════════════════════════════════════════ */}
      <Modal open={showPairModal} onClose={() => setShowPairModal(false)} contentClassName="max-w-5xl w-[95vw] max-h-[90vh]">
        <div className="p-6 space-y-5 min-h-[72vh]">
          <h3 className="text-lg font-bold text-gray-800">
            <i className="fas fa-link mr-2 text-blue-500"></i>จับคู่สินค้า FG กับ RM
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* FG Selector */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">สินค้า FG (สินค้าสำเร็จรูป)</label>
              <div className="relative" ref={fgRef}>
                {selectedFg ? (
                  <div className="flex items-center gap-2 px-3 py-2 border border-blue-300 rounded-lg bg-blue-50">
                    <ProductImageHover productCode={selectedFg.product_code} productName={selectedFg.product_name} size="sm" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-mono font-semibold text-gray-800">{selectedFg.product_code}</div>
                      <div className="text-xs text-gray-500 truncate">{selectedFg.product_name}</div>
                    </div>
                    <button onClick={() => { setPairFgId(''); setFgSearch('') }} className="text-gray-400 hover:text-red-500">
                      <i className="fas fa-times"></i>
                    </button>
                  </div>
                ) : (
                  <input
                    type="text"
                    placeholder="ค้นหา FG product..."
                    value={fgSearch}
                    onChange={(e) => setFgSearch(e.target.value)}
                    onFocus={() => setFgDropOpen(true)}
                    className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-400 outline-none"
                  />
                )}
                {fgDropOpen && !selectedFg && (
                  <div className="absolute z-40 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-[30rem] overflow-y-auto">
                    {filteredFg.length === 0 ? (
                      <div className="p-3 text-sm text-gray-400 text-center">ไม่พบสินค้า</div>
                    ) : (
                      filteredFg.map((p) => (
                        <button
                          key={p.id}
                          onClick={() => { setPairFgId(p.id); setFgDropOpen(false); setFgSearch('') }}
                          className="w-full flex items-center gap-2 px-3 py-2 hover:bg-blue-50 transition text-left"
                        >
                          <ProductImageHover productCode={p.product_code} productName={p.product_name} size="sm" />
                          <div className="min-w-0">
                            <div className="text-sm font-mono font-semibold">{p.product_code}</div>
                            <div className="text-xs text-gray-500 truncate">{p.product_name}</div>
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* RM Selector */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">สินค้า RM (วัตถุดิบ - ม้วน)</label>
              <div className="relative" ref={rmRef}>
                {selectedRms.length > 0 && (
                  <div className="mb-2 p-2 border border-emerald-300 rounded-lg bg-emerald-50">
                    <div className="flex flex-wrap gap-2">
                      {selectedRms.map((p) => (
                        <span key={p.id} className="inline-flex items-center gap-1 px-2 py-1 bg-white rounded border border-emerald-200 text-xs">
                          <span className="font-mono">{p.product_code}</span>
                          <button
                            onClick={() => setPairRmIds((prev) => prev.filter((id) => id !== p.id))}
                            className="text-gray-400 hover:text-red-500"
                            title="ลบรายการนี้"
                          >
                            <i className="fas fa-times"></i>
                          </button>
                        </span>
                      ))}
                    </div>
                    <button onClick={() => setPairRmIds([])} className="mt-2 text-xs text-red-500 hover:text-red-700">
                      ล้างรายการ RM ที่เลือก
                    </button>
                  </div>
                )}
                <input
                  type="text"
                  placeholder="ค้นหา RM product..."
                  value={rmSearch}
                  onChange={(e) => setRmSearch(e.target.value)}
                  onFocus={() => setRmDropOpen(true)}
                  className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-400 outline-none"
                />
                {rmDropOpen && (
                  <div className="absolute z-40 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-[30rem] overflow-y-auto">
                    {filteredRm.length === 0 ? (
                      <div className="p-3 text-sm text-gray-400 text-center">ไม่พบสินค้า</div>
                    ) : (
                      filteredRm.map((p) => (
                        <button
                          key={p.id}
                          onClick={() => {
                            setPairRmIds((prev) => (prev.includes(p.id) ? prev : [...prev, p.id]))
                            setRmSearch('')
                          }}
                          className="w-full flex items-center gap-2 px-3 py-2 hover:bg-emerald-50 transition text-left"
                        >
                          <ProductImageHover productCode={p.product_code} productName={p.product_name} size="sm" />
                          <div className="min-w-0">
                            <div className="text-sm font-mono font-semibold">{p.product_code}</div>
                            <div className="text-xs text-gray-500 truncate">{p.product_name}</div>
                          </div>
                          {pairRmIds.includes(p.id) && <i className="fas fa-check text-emerald-500 ml-auto"></i>}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <button
              onClick={() => setShowPairModal(false)}
              className="px-5 py-2.5 border border-gray-300 text-gray-600 rounded-lg hover:bg-gray-50 transition font-medium"
            >
              ยกเลิก
            </button>
            <button
              onClick={handlePairSave}
              disabled={!pairFgId || pairRmIds.length === 0 || pairSaving}
              className="px-5 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition font-medium shadow-sm"
            >
              {pairSaving ? (
                <><i className="fas fa-spinner fa-spin mr-2"></i>กำลังบันทึก...</>
              ) : (
                <><i className="fas fa-check mr-2"></i>จับคู่</>
              )}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
