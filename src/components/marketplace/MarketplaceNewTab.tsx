import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useWmsModal } from '../wms/useWmsModal'
import { parseMarketplaceWorkbook, type MpParsedOrder } from '../../lib/marketplaceImport'
import { formatDateTime } from '../../lib/utils'
import UrgencyBadge from '../common/UrgencyBadge'
import type { User } from '../../types'
import type { MpChannelConfig, MpOrder, MpSalesUser } from '../../types/marketplace'

const CHUNK = 200

function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export default function MarketplaceNewTab({
  user,
  configs,
  salesUsers,
  refreshKey,
  onChanged,
}: {
  user: User
  configs: MpChannelConfig[]
  salesUsers: MpSalesUser[]
  refreshKey: number
  onChanged: () => void
}) {
  const { showMessage, showConfirm, MessageModal, ConfirmModal } = useWmsModal()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [configId, setConfigId] = useState('')
  const [importing, setImporting] = useState(false)
  const [orders, setOrders] = useState<MpOrder[]>([])
  const [itemCounts, setItemCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [assignTo, setAssignTo] = useState('')
  const [assigning, setAssigning] = useState(false)
  const [search, setSearch] = useState('')

  const activeConfigs = useMemo(() => configs.filter((c) => c.is_active), [configs])

  useEffect(() => {
    if (!configId && activeConfigs.length > 0) setConfigId(activeConfigs[0].id)
  }, [activeConfigs, configId])

  const loadOrders = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('mp_orders')
        .select('*')
        .eq('status', 'new')
        .order('payment_time', { ascending: true, nullsFirst: false })
      if (error) throw error
      const rows = (data || []) as MpOrder[]
      setOrders(rows)
      setSelected((prev) => new Set([...prev].filter((id) => rows.some((r) => r.id === id))))

      // จำนวนรายการสินค้าต่อออเดอร์
      const counts: Record<string, number> = {}
      for (const ids of chunked(rows.map((r) => r.id), CHUNK)) {
        const { data: items } = await supabase
          .from('mp_order_items')
          .select('mp_order_id')
          .in('mp_order_id', ids)
        ;(items || []).forEach((it: { mp_order_id: string }) => {
          counts[it.mp_order_id] = (counts[it.mp_order_id] || 0) + 1
        })
      }
      setItemCounts(counts)
    } catch (err) {
      console.error('Error loading mp_orders:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadOrders()
  }, [loadOrders, refreshKey])

  const filteredOrders = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return orders
    return orders.filter((o) =>
      [
        o.marketplace_order_no,
        o.buyer_username,
        o.channel_code,
        o.recipient_name,
        o.phone,
        o.tracking_no,
        o.platform_status,
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    )
  }, [orders, search])

  // ---------- Import ----------
  async function handleFileSelected(file: File) {
    const config = configs.find((c) => c.id === configId)
    if (!config) {
      showMessage({ message: 'กรุณาเลือกช่องทางนำเข้าก่อนอัปโหลดไฟล์' })
      return
    }
    setImporting(true)
    try {
      const result = await parseMarketplaceWorkbook(file, config)
      if (result.orders.length === 0) {
        showMessage({ message: 'ไม่พบข้อมูลออเดอร์ในไฟล์ — ตรวจสอบการจับคู่คอลัมน์ในหน้าตั้งค่า' })
        return
      }

      // เช็คซ้ำกับงานที่เคยนำเข้าแล้ว (ขอบเขต: ช่องทางขายเดียวกัน)
      const orderNos = result.orders.map((o) => o.marketplace_order_no)
      const existing = new Set<string>()
      for (const chunk of chunked(orderNos, CHUNK)) {
        const { data } = await supabase
          .from('mp_orders')
          .select('marketplace_order_no')
          .eq('channel_code', config.channel_code)
          .in('marketplace_order_no', chunk)
        ;(data || []).forEach((r: { marketplace_order_no: string }) => existing.add(r.marketplace_order_no))
      }
      const freshOrders = result.orders.filter((o) => !existing.has(o.marketplace_order_no))
      const duplicateCount = result.orders.length - freshOrders.length

      if (freshOrders.length === 0) {
        showMessage({
          title: 'ไม่มีรายการใหม่',
          message: `ออเดอร์ทั้ง ${result.orders.length} รายการในไฟล์ถูกนำเข้าไปแล้ว`,
        })
        return
      }

      // auto-match SKU → pr_products.product_code
      const skus = Array.from(
        new Set(
          freshOrders.flatMap((o) => o.items.map((it) => (it.sku_ref || '').trim()).filter(Boolean)),
        ),
      )
      const skuToProductId = new Map<string, string>()
      for (const chunk of chunked(skus, CHUNK)) {
        const { data } = await supabase
          .from('pr_products')
          .select('id, product_code')
          .in('product_code', chunk)
          .eq('is_active', true)
        ;(data || []).forEach((p: { id: string; product_code: string }) => {
          skuToProductId.set(p.product_code.trim().toLowerCase(), p.id)
        })
      }

      // insert batch
      const { data: batch, error: batchError } = await supabase
        .from('mp_import_batches')
        .insert({
          config_id: config.id,
          file_name: file.name,
          row_count: result.rowCount,
          order_count: freshOrders.length,
          duplicate_count: duplicateCount,
          uploaded_by: user.id,
        })
        .select('id')
        .single()
      if (batchError) throw batchError

      // insert orders + items (chunked)
      let insertedOrders = 0
      let unmatchedSku = 0
      for (const chunk of chunked(freshOrders, 50)) {
        const payload = chunk.map((o: MpParsedOrder) => ({
          batch_id: batch.id,
          config_id: config.id,
          channel_code: config.channel_code,
          marketplace_order_no: o.marketplace_order_no,
          platform_status: o.platform_status,
          buyer_username: o.buyer_username,
          order_date: o.order_date,
          payment_time: o.payment_time,
          recipient_name: o.recipient_name,
          phone: o.phone,
          address: o.address,
          province: o.province,
          district: o.district,
          postal_code: o.postal_code,
          buyer_note: o.buyer_note,
          tracking_no: o.tracking_no,
          shipping_fee: o.shipping_fee,
          order_total: o.order_total,
          raw_snapshot: o.raw_snapshot,
          ship_due_at: o.ship_due_at,
          overdue_at: o.overdue_at,
          status: 'new',
        }))
        const { data: inserted, error: orderError } = await supabase
          .from('mp_orders')
          .insert(payload)
          .select('id, marketplace_order_no')
        if (orderError) throw orderError
        insertedOrders += (inserted || []).length

        const idByOrderNo = new Map<string, string>()
        ;(inserted || []).forEach((r: { id: string; marketplace_order_no: string }) =>
          idByOrderNo.set(r.marketplace_order_no, r.id),
        )
        const itemsPayload = chunk.flatMap((o) => {
          const mpOrderId = idByOrderNo.get(o.marketplace_order_no)
          if (!mpOrderId) return []
          // แตกรายการที่จำนวน > 1 ให้เป็นหลายแถว แถวละ 1 ชิ้น (ลงชื่อแยกกันได้)
          let lineIndex = 0
          return o.items.flatMap((it) => {
            const productId = it.sku_ref ? skuToProductId.get(it.sku_ref.trim().toLowerCase()) || null : null
            if (!productId) unmatchedSku++
            const copies = Math.max(1, Math.round(Number(it.qty) || 1))
            const perLineTotal =
              it.line_total != null ? Math.round((Number(it.line_total) / copies) * 100) / 100 : it.unit_price
            return Array.from({ length: copies }, () => ({
              mp_order_id: mpOrderId,
              line_index: lineIndex++,
              product_name_raw: it.product_name_raw,
              sku_ref: it.sku_ref,
              variation: it.variation,
              // ชื่อตัวเลือกจากไฟล์ = "ลาย" → เติมช่องลาย (cartoon_pattern) ให้อัตโนมัติ (sales แก้ได้)
              cartoon_pattern: it.variation,
              qty: 1,
              unit_price: it.unit_price,
              line_total: perLineTotal,
              raw_snapshot: it.raw_snapshot,
              product_id: productId,
            }))
          })
        })
        for (const itemChunk of chunked(itemsPayload, CHUNK)) {
          const { error: itemError } = await supabase.from('mp_order_items').insert(itemChunk)
          if (itemError) throw itemError
        }
      }

      const warningText = result.warnings.length
        ? `\n\nคำเตือน:\n${result.warnings.slice(0, 8).join('\n')}${result.warnings.length > 8 ? '\n...' : ''}`
        : ''
      const skuText = unmatchedSku > 0 ? `\nรายการที่จับคู่ SKU ไม่ได้ (ให้ sales เลือกเอง): ${unmatchedSku}` : ''
      showMessage({
        title: 'นำเข้าสำเร็จ',
        message: `นำเข้า ${insertedOrders} ออเดอร์ (${result.rowCount} แถว)\nข้ามรายการซ้ำ ${duplicateCount} ออเดอร์${skuText}${warningText}`,
      })
      window.dispatchEvent(new CustomEvent('sidebar-refresh-counts'))
      onChanged()
      loadOrders()
    } catch (err) {
      showMessage({ title: 'นำเข้าไม่สำเร็จ', message: (err as Error).message || String(err) })
    } finally {
      setImporting(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // ---------- Assignment ----------
  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allSelected = filteredOrders.length > 0 && filteredOrders.every((o) => selected.has(o.id))

  function toggleSelectAll() {
    setSelected(allSelected ? new Set() : new Set(filteredOrders.map((o) => o.id)))
  }

  /** พิมพ์จำนวน → เลือก N รายการแรกทันที (ช่องเลขแสดงจำนวนที่เลือกจริงเสมอ) */
  function handleCountInput(raw: string) {
    if (raw.trim() === '') {
      setSelected(new Set())
      return
    }
    const n = Math.max(0, Math.min(filteredOrders.length, Math.floor(Number(raw) || 0)))
    setSelected(new Set(filteredOrders.slice(0, n).map((o) => o.id)))
  }

  async function handleAssign() {
    if (selected.size === 0) {
      showMessage({ message: 'กรุณาเลือกออเดอร์ที่ต้องการมอบหมาย' })
      return
    }
    const target = salesUsers.find((u) => u.id === assignTo)
    if (!target) {
      showMessage({ message: 'กรุณาเลือกผู้รับผิดชอบ (sales)' })
      return
    }
    const ok = await showConfirm({
      message: `มอบหมาย ${selected.size} ออเดอร์ ให้ "${target.username || target.email}" ?`,
    })
    if (!ok) return

    setAssigning(true)
    try {
      let affected = 0
      for (const chunk of chunked([...selected], CHUNK)) {
        const { data, error } = await supabase
          .from('mp_orders')
          .update({
            status: 'assigned',
            assigned_to: target.id,
            assigned_at: new Date().toISOString(),
            assigned_by: user.id,
          })
          .in('id', chunk)
          .eq('status', 'new')
          .select('id')
        if (error) throw error
        affected += (data || []).length
      }
      showMessage({
        title: 'มอบหมายแล้ว',
        message: `มอบหมาย ${affected} ออเดอร์ ให้ ${target.username || target.email} สำเร็จ`,
      })
      setSelected(new Set())
      window.dispatchEvent(new CustomEvent('sidebar-refresh-counts'))
      onChanged()
      loadOrders()
    } catch (err) {
      showMessage({ title: 'ผิดพลาด', message: (err as Error).message })
    } finally {
      setAssigning(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* อัปโหลดไฟล์ */}
      <div className="bg-white rounded-xl border border-surface-200 shadow-soft p-6">
        <h2 className="text-xl font-bold text-slate-800 mb-1">อัปโหลดไฟล์ Order</h2>
        <p className="text-sm text-slate-500 mb-4">
          เลือกช่องทางนำเข้า แล้วอัปโหลดไฟล์ Excel — ระบบจะข้ามออเดอร์ที่นำเข้าไปแล้วโดยอัตโนมัติ
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1">ช่องทางนำเข้า</label>
            <select
              value={configId}
              onChange={(e) => setConfigId(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 min-w-[220px]"
            >
              {activeConfigs.length === 0 && <option value="">— ยังไม่มีการตั้งค่า —</option>}
              {activeConfigs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.channel_code})
                </option>
              ))}
            </select>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xls,.xlsx"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) handleFileSelected(f)
            }}
          />
          <button
            type="button"
            disabled={importing || !configId}
            onClick={() => fileInputRef.current?.click()}
            className="px-5 py-2 rounded-lg bg-blue-600 text-white font-bold hover:bg-blue-700 disabled:opacity-50"
          >
            {importing ? 'กำลังนำเข้า...' : 'เลือกไฟล์อัปโหลด'}
          </button>
        </div>
      </div>

      {/* เครื่องมือมอบหมาย */}
      <div className="bg-white rounded-xl border border-surface-200 shadow-soft p-4 flex flex-wrap items-center gap-3">
        <span className="font-semibold text-slate-700">
          เลือกแล้ว {selected.size} / {filteredOrders.length} ออเดอร์
        </span>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="ค้นหา"
          className="border border-gray-300 rounded-lg px-3 py-2 w-full sm:w-80"
        />
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600">จำนวนที่เลือก</label>
          <input
            type="number"
            min={0}
            max={filteredOrders.length}
            value={selected.size}
            onChange={(e) => handleCountInput(e.target.value)}
            onFocus={(e) => e.target.select()}
            title="พิมพ์จำนวน ระบบจะเลือกรายการแรก ๆ ให้ตามจำนวนทันที"
            className="border border-gray-300 rounded-lg px-3 py-2 w-24 text-center font-semibold"
          />
        </div>
        <button
          type="button"
          onClick={() => setSelected(new Set())}
          className="px-3 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
        >
          ล้างการเลือก
        </button>
        <div className="flex items-center gap-2 ml-auto">
          <select
            value={assignTo}
            onChange={(e) => setAssignTo(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 min-w-[180px]"
          >
            <option value="">— เลือก sales —</option>
            {salesUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.username || u.email} ({u.role})
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={assigning || selected.size === 0 || !assignTo}
            onClick={handleAssign}
            className="px-5 py-2 rounded-lg bg-green-600 text-white font-bold hover:bg-green-700 disabled:opacity-50"
          >
            {assigning ? 'กำลังมอบหมาย...' : 'มอบหมายงาน'}
          </button>
        </div>
      </div>

      {/* รายการรอมอบหมาย */}
      <div className="bg-white rounded-xl border border-surface-200 shadow-soft overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[860px]">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="px-4 py-3 w-10">
                  <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} className="w-4 h-4" />
                </th>
                <th className="text-left px-4 py-3">เลขคำสั่งซื้อ</th>
                <th className="text-left px-4 py-3">ช่องทาง</th>
                <th className="text-left px-4 py-3">ผู้ซื้อ</th>
                <th className="text-left px-4 py-3">เวลาชำระเงิน</th>
                <th className="text-right px-4 py-3">รายการ</th>
                <th className="text-right px-4 py-3">ยอดรวม</th>
                <th className="text-left px-4 py-3">สถานะแพลตฟอร์ม</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-gray-400">กำลังโหลด...</td>
                </tr>
              )}
              {!loading && filteredOrders.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-gray-400">
                    {search.trim()
                      ? 'ไม่พบรายการที่ค้นหา'
                      : 'ไม่มีงานรอมอบหมาย — อัปโหลดไฟล์ Order เพื่อเริ่มต้น'}
                  </td>
                </tr>
              )}
              {!loading &&
                filteredOrders.map((o) => (
                  <tr
                    key={o.id}
                    className={`border-t border-surface-100 cursor-pointer hover:bg-blue-50/40 ${
                      selected.has(o.id) ? 'bg-blue-50/60' : ''
                    }`}
                    onClick={() => toggleSelect(o.id)}
                  >
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(o.id)}
                        onChange={() => toggleSelect(o.id)}
                        className="w-4 h-4"
                      />
                    </td>
                    <td className="px-4 py-3 font-semibold text-slate-800 whitespace-nowrap">
                      <span className="mr-2">{o.marketplace_order_no}</span>
                      <UrgencyBadge order={o} />
                    </td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-semibold">
                        {o.channel_code}
                      </span>
                    </td>
                    <td className="px-4 py-3">{o.buyer_username || '-'}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {o.payment_time ? formatDateTime(o.payment_time) : '-'}
                    </td>
                    <td className="px-4 py-3 text-right">{itemCounts[o.id] ?? '-'}</td>
                    <td className="px-4 py-3 text-right">
                      {o.order_total != null ? o.order_total.toLocaleString('th-TH') : '-'}
                    </td>
                    <td className="px-4 py-3">{o.platform_status || '-'}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {MessageModal}
      {ConfirmModal}
    </div>
  )
}
