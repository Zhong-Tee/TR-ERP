import { useEffect, useMemo, useRef, useState } from 'react'
import Modal from '../components/ui/Modal'
import { useWmsModal } from '../components/wms/useWmsModal'
import { useAuthContext } from '../contexts/AuthContext'
import type { InventoryGR, InventoryPO } from '../types'
import {
  loadGRList,
  loadGRDetail,
  loadPOsForGR,
  loadPOItemsForGR,
  receiveGR,
  loadUserDisplayNames,
  updatePOExpectedArrivalDate,
} from '../lib/purchaseApi'
import { getPublicUrl } from '../lib/qcApi'
import { supabase } from '../lib/supabase'

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  pending: { label: 'รอรับ', color: 'bg-yellow-100 text-yellow-800' },
  partial: { label: 'รับบางส่วน', color: 'bg-orange-100 text-orange-800' },
  received: { label: 'รับครบ', color: 'bg-green-100 text-green-800' },
}

const CLOSED_PO_RESOLUTION_MAP: Record<string, { label: string; color: string }> = {
  refund: { label: 'คืนเงิน', color: 'bg-blue-100 text-blue-800' },
  wrong_item: { label: 'สินค้าผิด', color: 'bg-amber-100 text-amber-800' },
  cancelled: { label: 'ยกเลิก', color: 'bg-red-100 text-red-800' },
}

const FINANCIAL_VISIBLE_ROLES = ['superadmin', 'account']

function getGRDisplayStatus(gr: InventoryGR) {
  const poStatus = (gr.inv_po as any)?.status
  const poItems = ((gr.inv_po as any)?.inv_po_items || []) as Array<{ resolution_type?: string | null }>
  if (poStatus === 'closed') {
    const types = [...new Set(poItems.map((i) => i?.resolution_type).filter(Boolean) as string[])]
    if (types.length === 1) {
      return CLOSED_PO_RESOLUTION_MAP[types[0]] || { label: 'ปิด PO', color: 'bg-gray-100 text-gray-700' }
    }
    if (types.length > 1) {
      const labels = types.map((t) => CLOSED_PO_RESOLUTION_MAP[t]?.label || t)
      return { label: labels.join('/'), color: 'bg-purple-100 text-purple-800' }
    }
    return { label: 'ปิด PO', color: 'bg-gray-100 text-gray-700' }
  }
  return STATUS_MAP[gr.status] || { label: gr.status, color: 'bg-gray-100 text-gray-700' }
}

interface ReceiveItem {
  product_id: string
  product_code: string
  product_name: string
  qty_ordered: number
  qty_received: number | ''
  qty_already_received: number
  shortage_note: string
  item_note?: string
  images: ReceiveItemImageDraft[]
}

interface ReceiveItemImageDraft {
  id: string
  file: File
  previewUrl: string
}

interface PendingImageSelection {
  itemIndex: number
  drafts: ReceiveItemImageDraft[]
}

const DAY_MS = 24 * 60 * 60 * 1000
const GR_ITEM_IMAGES_BUCKET = 'gr-item-images'
const MAX_ITEM_IMAGES = 5

function toDateOnly(value?: string | null) {
  if (!value) return null
  const dateOnly = String(value).split('T')[0]
  const parsed = new Date(`${dateOnly}T00:00:00`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function formatDateThai(value?: string | null) {
  const d = toDateOnly(value)
  if (!d) return '-'
  return d.toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: 'numeric' })
}

function formatMoney(value?: number | null, minimumFractionDigits = 2, maximumFractionDigits = minimumFractionDigits) {
  if (value == null || Number.isNaN(Number(value))) return '-'
  return Number(value).toLocaleString(undefined, { minimumFractionDigits, maximumFractionDigits })
}

function formatTotalPerPiece(total?: number | null, perPiece?: number | null) {
  if (total == null && perPiece == null) return '-'
  return `${formatMoney(total, 2, 2)} / ${formatMoney(perPiece, 2, 4)} บาท`
}

function getEtaMeta(value?: string | null) {
  const eta = toDateOnly(value)
  if (!eta) {
    return { label: 'ไม่ระบุวันที่เข้า', color: 'bg-gray-100 text-gray-600', sortValue: 999999 }
  }
  const today = toDateOnly(new Date().toISOString())!
  const daysDiff = Math.round((eta.getTime() - today.getTime()) / DAY_MS)
  if (daysDiff < 0) {
    return { label: `เลยกำหนด ${Math.abs(daysDiff)} วัน`, color: 'bg-red-100 text-red-700', sortValue: daysDiff }
  }
  if (daysDiff === 0) {
    return { label: 'กำหนดเข้า: วันนี้', color: 'bg-orange-100 text-orange-700', sortValue: daysDiff }
  }
  if (daysDiff <= 3) {
    return { label: `ใกล้ถึง: อีก ${daysDiff} วัน`, color: 'bg-amber-100 text-amber-700', sortValue: daysDiff }
  }
  return { label: `อีก ${daysDiff} วัน`, color: 'bg-red-100 text-red-700', sortValue: daysDiff }
}

function getStoragePublicUrl(bucket: string | undefined, path: string | undefined) {
  if (!path) return ''
  const { data } = supabase.storage.from(bucket || GR_ITEM_IMAGES_BUCKET).getPublicUrl(path)
  return data.publicUrl
}

export default function PurchaseGR() {
  const { user } = useAuthContext()
  const { showMessage, showConfirm, MessageModal, ConfirmModal } = useWmsModal()
  const canSeeFinancial = FINANCIAL_VISIBLE_ROLES.includes(user?.role || '')

  const [grs, setGrs] = useState<InventoryGR[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState(() => new Date().toISOString().split('T')[0])
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().split('T')[0])

  const [newPOs, setNewPOs] = useState<InventoryPO[]>([])
  const [partialPOs, setPartialPOs] = useState<InventoryPO[]>([])

  const [receiveOpen, setReceiveOpen] = useState(false)
  const [selectedPO, setSelectedPO] = useState<InventoryPO | null>(null)
  const [isFollowUp, setIsFollowUp] = useState(false)
  const [receiveItems, setReceiveItems] = useState<ReceiveItem[]>([])
  const [domCompany, setDomCompany] = useState('')
  const [domCost, setDomCost] = useState('')
  const [grNote, setGrNote] = useState('')
  const [shortageNote, setShortageNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [shippingExpanded, setShippingExpanded] = useState(false)

  const [userMap, setUserMap] = useState<Record<string, string>>({})

  const [viewing, setViewing] = useState<InventoryGR | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const posCacheRef = useRef<{ newPOs: InventoryPO[]; partialPOs: InventoryPO[] } | null>(null)
  const receiveItemsRef = useRef<ReceiveItem[]>([])
  const pendingImageSelectionRef = useRef<PendingImageSelection | null>(null)
  const [pendingImageSelection, setPendingImageSelection] = useState<PendingImageSelection | null>(null)
  const [zoomGallery, setZoomGallery] = useState<{ images: string[]; index: number } | null>(null)
  const [etaEditOpen, setEtaEditOpen] = useState(false)
  const [etaEditPO, setEtaEditPO] = useState<InventoryPO | null>(null)
  const [etaEditDate, setEtaEditDate] = useState('')
  const [etaSaving, setEtaSaving] = useState(false)
  const [mobileSection, setMobileSection] = useState<'receive' | 'list'>('receive')

  const [debouncedSearch, setDebouncedSearch] = useState(search)
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 400)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => { loadAll() }, [statusFilter, typeFilter, debouncedSearch, dateFrom, dateTo])

  useEffect(() => {
    receiveItemsRef.current = receiveItems
  }, [receiveItems])

  useEffect(() => {
    pendingImageSelectionRef.current = pendingImageSelection
  }, [pendingImageSelection])

  const activeZoomImageUrl = zoomGallery ? zoomGallery.images[zoomGallery.index] : null

  function openZoomGallery(images: string[], startIndex = 0) {
    const filtered = images.filter((img) => !!img)
    if (filtered.length === 0) return
    const safeIndex = Math.min(Math.max(startIndex, 0), filtered.length - 1)
    setZoomGallery({ images: filtered, index: safeIndex })
  }

  function closeZoomGallery() {
    setZoomGallery(null)
  }

  function moveZoomGallery(step: -1 | 1) {
    setZoomGallery((prev) => {
      if (!prev || prev.images.length <= 1) return prev
      const nextIndex = (prev.index + step + prev.images.length) % prev.images.length
      return { ...prev, index: nextIndex }
    })
  }

  useEffect(() => {
    return () => {
      revokeDraftImages(receiveItemsRef.current)
      if (pendingImageSelectionRef.current) {
        revokeImageDraftList(pendingImageSelectionRef.current.drafts)
      }
    }
  }, [])

  useEffect(() => {
    const uid = viewing?.received_by
    if (!uid || userMap[uid]) return
    let isMounted = true
    loadUserDisplayNames([uid])
      .then((names) => {
        if (!isMounted) return
        const displayName = names?.[uid]
        if (displayName) {
          setUserMap((prev) => ({ ...prev, [uid]: displayName }))
        }
      })
      .catch((e) => {
        console.error('Load received_by display name failed:', e)
      })
    return () => {
      isMounted = false
    }
  }, [viewing?.received_by, userMap])

  async function loadAll(forceRefreshPOs = false) {
    setLoading(true)
    try {
      const [grData, poData] = await Promise.all([
        loadGRList({ status: statusFilter, search: debouncedSearch, dateFrom: dateFrom || undefined, dateTo: dateTo || undefined }),
        (!forceRefreshPOs && posCacheRef.current) ? Promise.resolve(posCacheRef.current) : loadPOsForGR(),
      ])
      const filtered = typeFilter !== 'all'
        ? grData.filter((gr: any) => gr.inv_po?.inv_pr?.pr_type === typeFilter)
        : grData
      setGrs(filtered)
      posCacheRef.current = poData
      setNewPOs(poData.newPOs)
      setPartialPOs(poData.partialPOs)

      const uids = grData.map((gr: any) => gr.received_by).filter(Boolean)
      if (uids.length) {
        const names = await loadUserDisplayNames(uids)
        setUserMap((prev) => ({ ...prev, ...names }))
      }
      window.dispatchEvent(new CustomEvent('purchase-badge-refresh'))
    } catch (e) {
      console.error('Load GR failed:', e)
    } finally {
      setLoading(false)
    }
  }

  async function openReceive(po: InventoryPO, followUp: boolean) {
    revokeDraftImages(receiveItems)
    closePendingImageSelection()
    setSelectedPO(po)
    setIsFollowUp(followUp)
    setDomCompany('')
    setDomCost('')
    setGrNote('')
    setShortageNote('')
    setShippingExpanded(false)

    try {
      const poItems = await loadPOItemsForGR(po.id)
      const items: ReceiveItem[] = poItems
        .filter((item: any) => {
          if (!followUp) return true
          const alreadyReceived = Number(item.qty_received_total) || 0
          const resolvedQty = Number(item.resolution_qty) || 0
          const remaining = Number(item.qty) - alreadyReceived - resolvedQty
          return remaining > 0
        })
        .map((item: any) => {
          const alreadyReceived = Number(item.qty_received_total) || 0
          const resolvedQty = Number(item.resolution_qty) || 0
          const remaining = Math.max(Number(item.qty) - alreadyReceived - resolvedQty, 0)
          return {
            product_id: item.product_id,
            product_code: item.pr_products?.product_code || '',
            product_name: item.pr_products?.product_name || '',
            qty_ordered: remaining,
            qty_received: remaining,
            qty_already_received: alreadyReceived,
            shortage_note: '',
            item_note: item.note || '',
            images: [],
          }
        })
      setReceiveItems(items)
      setReceiveOpen(true)
    } catch (e) {
      console.error(e)
      showMessage({ title: 'เกิดข้อผิดพลาด', message: 'โหลดรายการ PO ไม่สำเร็จ' })
    }
  }

  function updateReceiveItem(index: number, patch: Partial<ReceiveItem>) {
    setReceiveItems((prev) =>
      prev.map((item, i) => (i === index ? { ...item, ...patch } : item))
    )
  }

  function setReceiveQtyFromInput(index: number, value: string) {
    if (value === '') {
      updateReceiveItem(index, { qty_received: '' })
      return
    }
    updateReceiveItem(index, { qty_received: Number(value) || 0 })
  }

  function revokeDraftImages(items: ReceiveItem[]) {
    items.forEach((item) => {
      item.images.forEach((img) => URL.revokeObjectURL(img.previewUrl))
    })
  }

  function revokeImageDraftList(images: ReceiveItemImageDraft[]) {
    images.forEach((img) => URL.revokeObjectURL(img.previewUrl))
  }

  function closePendingImageSelection() {
    if (pendingImageSelection) {
      revokeImageDraftList(pendingImageSelection.drafts)
    }
    setPendingImageSelection(null)
  }

  function clearReceiveDraft() {
    revokeDraftImages(receiveItems)
    closePendingImageSelection()
    setReceiveItems([])
    setReceiveOpen(false)
    setSelectedPO(null)
  }

  function openEtaEdit(po: InventoryPO) {
    setEtaEditPO(po)
    setEtaEditDate(po.expected_arrival_date ? String(po.expected_arrival_date).split('T')[0] : '')
    setEtaEditOpen(true)
  }

  async function saveEtaEdit() {
    if (!etaEditPO) return
    if (!etaEditDate) {
      showMessage({ message: 'กรุณาเลือกวันที่กำหนดเข้า' })
      return
    }
    setEtaSaving(true)
    try {
      await updatePOExpectedArrivalDate({
        poId: etaEditPO.id,
        expectedArrivalDate: etaEditDate,
        userId: user?.id,
      })
      setEtaEditOpen(false)
      setEtaEditPO(null)
      await loadAll(true)
    } catch (e: any) {
      showMessage({ title: 'เกิดข้อผิดพลาด', message: 'แก้ไขกำหนดเข้าไม่สำเร็จ: ' + (e?.message || e) })
    } finally {
      setEtaSaving(false)
    }
  }

  function addReceiveItemImages(index: number, files: FileList | null) {
    if (!files || files.length === 0) return
    const target = receiveItems[index]
    if (!target) return
    const remain = Math.max(MAX_ITEM_IMAGES - target.images.length, 0)
    if (remain === 0) return

    const drafts = Array.from(files)
      .slice(0, remain)
      .map((file) => ({
        id: crypto.randomUUID(),
        file,
        previewUrl: URL.createObjectURL(file),
      }))
    if (drafts.length === 0) return

    if (pendingImageSelection) {
      revokeImageDraftList(pendingImageSelection.drafts)
    }
    setPendingImageSelection({ itemIndex: index, drafts })
  }

  function confirmPendingImageSelection() {
    if (!pendingImageSelection) return
    const { itemIndex, drafts } = pendingImageSelection
    setReceiveItems((prev) =>
      prev.map((item, i) => {
        if (i !== itemIndex) return item
        const remain = Math.max(MAX_ITEM_IMAGES - item.images.length, 0)
        return { ...item, images: [...item.images, ...drafts.slice(0, remain)] }
      })
    )
    setPendingImageSelection(null)
  }

  function removeReceiveItemImage(index: number, imageId: string) {
    setReceiveItems((prev) =>
      prev.map((item, i) => {
        if (i !== index) return item
        const target = item.images.find((img) => img.id === imageId)
        if (target) URL.revokeObjectURL(target.previewUrl)
        return { ...item, images: item.images.filter((img) => img.id !== imageId) }
      })
    )
  }

  function reorderReceiveItemImage(index: number, imageId: string, direction: -1 | 1) {
    setReceiveItems((prev) =>
      prev.map((item, i) => {
        if (i !== index) return item
        const currentIndex = item.images.findIndex((img) => img.id === imageId)
        if (currentIndex < 0) return item
        const nextIndex = currentIndex + direction
        if (nextIndex < 0 || nextIndex >= item.images.length) return item
        const cloned = [...item.images]
        const [moved] = cloned.splice(currentIndex, 1)
        cloned.splice(nextIndex, 0, moved)
        return { ...item, images: cloned }
      })
    )
  }

  async function uploadReceiveItemImages(
    poId: string,
    item: ReceiveItem,
    itemIndex: number,
    uploadedRefs: Array<{ bucket: string; path: string }>
  ) {
    const uploaded = await Promise.all(
      item.images.map(async (img, imageIndex) => {
        const ext = img.file.name.split('.').pop() || 'jpg'
        const path = `${poId}/${item.product_id}/${Date.now()}-${itemIndex + 1}-${imageIndex + 1}-${crypto.randomUUID()}.${ext}`
        const { error } = await supabase.storage.from(GR_ITEM_IMAGES_BUCKET).upload(path, img.file, { upsert: false })
        if (error) throw error
        uploadedRefs.push({ bucket: GR_ITEM_IMAGES_BUCKET, path })
        return {
          storage_bucket: GR_ITEM_IMAGES_BUCKET,
          storage_path: path,
          file_name: img.file.name,
          mime_type: img.file.type || undefined,
          size_bytes: img.file.size,
          sort_order: imageIndex + 1,
        }
      })
    )
    return uploaded
  }

  const totalReceived = receiveItems.reduce((s, i) => s + (Number(i.qty_received) || 0), 0)
  const totalOrdered = receiveItems.reduce((s, i) => s + i.qty_ordered, 0)
  const totalShortage = receiveItems.reduce((s, i) => s + Math.max(i.qty_ordered - (Number(i.qty_received) || 0), 0), 0)
  const totalExcess = receiveItems.reduce((s, i) => s + Math.max((Number(i.qty_received) || 0) - i.qty_ordered, 0), 0)
  const hasShortage = receiveItems.some((i) => (Number(i.qty_received) || 0) < i.qty_ordered)
  const hasExcess = receiveItems.some((i) => (Number(i.qty_received) || 0) > i.qty_ordered)
  const costPerPiece = totalReceived > 0 && Number(domCost) > 0 ? Number(domCost) / totalReceived : 0

  async function handleReceive() {
    if (!selectedPO) return
    if (receiveItems.some((i) => (Number(i.qty_received) || 0) < 0)) {
      showMessage({ message: 'จำนวนรับไม่สามารถติดลบได้' })
      return
    }
    const totalRcv = receiveItems.reduce((s, i) => s + (Number(i.qty_received) || 0), 0)
    const totalOrd = receiveItems.reduce((s, i) => s + i.qty_ordered, 0)
    const confirmMsg = hasExcess
      ? `ยืนยันรับสินค้าเกิน (${totalRcv}/${totalOrd} ชิ้น, เกิน ${totalExcess} ชิ้น) สำหรับ PO ${selectedPO.po_no} ?`
      : totalRcv < totalOrd
        ? `ยืนยันรับสินค้าบางส่วน (${totalRcv}/${totalOrd} ชิ้น) สำหรับ PO ${selectedPO.po_no} ?`
        : `ยืนยันรับสินค้าครบ (${totalRcv} ชิ้น) สำหรับ PO ${selectedPO.po_no} ?`
    const ok = await showConfirm({ title: 'รับสินค้า', message: confirmMsg, confirmText: 'ยืนยันรับ' })
    if (!ok) return
    setSaving(true)
    const uploadedRefs: Array<{ bucket: string; path: string }> = []
    try {
      const itemPayload = await Promise.all(
        receiveItems.map(async (i, idx) => ({
          product_id: i.product_id,
          qty_received: Number(i.qty_received) || 0,
          qty_ordered: i.qty_ordered,
          shortage_note: i.shortage_note || undefined,
          images: await uploadReceiveItemImages(selectedPO.id, i, idx, uploadedRefs),
        }))
      )

      await receiveGR({
        poId: selectedPO.id,
        items: itemPayload,
        shipping: {
          dom_shipping_company: domCompany || undefined,
          dom_shipping_cost: domCost ? Number(domCost) : undefined,
          note: grNote || undefined,
          shortage_note: shortageNote || undefined,
        },
        userId: user?.id,
      })
      clearReceiveDraft()
      await loadAll(true)
    } catch (e: any) {
      if (uploadedRefs.length > 0) {
        await Promise.all(
          uploadedRefs.map(async (ref) => {
            try {
              await supabase.storage.from(ref.bucket).remove([ref.path])
            } catch {
              // Ignore cleanup failures; DB transaction is still safe.
            }
          })
        )
      }
      showMessage({ title: 'เกิดข้อผิดพลาด', message: 'รับเข้าคลังไม่สำเร็จ: ' + (e?.message || e) })
    } finally {
      setSaving(false)
    }
  }

  async function openDetail(gr: InventoryGR) {
    setViewing(gr)
    setDetailLoading(true)
    try {
      const detail = await loadGRDetail(gr.id)
      setViewing(detail)
    } catch (e) {
      console.error(e)
    } finally {
      setDetailLoading(false)
    }
  }

  const statusTabs = [
    { key: 'all', label: 'ทั้งหมด' },
    { key: 'partial', label: 'รับบางส่วน' },
    { key: 'received', label: 'รับครบ' },
  ]

  const sortedNewPOs = useMemo(
    () => [...newPOs].sort((a, b) => getEtaMeta(a.expected_arrival_date).sortValue - getEtaMeta(b.expected_arrival_date).sortValue),
    [newPOs]
  )
  const sortedPartialPOs = useMemo(
    () => [...partialPOs].sort((a, b) => getEtaMeta(a.expected_arrival_date).sortValue - getEtaMeta(b.expected_arrival_date).sortValue),
    [partialPOs]
  )
  const partialCount = partialPOs.length
  const receiveQueueCount = sortedNewPOs.length + sortedPartialPOs.length
  const grRowsWithGroup = useMemo(() => {
    let lastPoNo = ''
    let groupIndex = -1
    return grs.map((gr) => {
      const poNo = gr.inv_po?.po_no || '-'
      if (poNo !== lastPoNo) {
        groupIndex += 1
        lastPoNo = poNo
      }
      return { gr, groupIndex }
    })
  }, [grs])

  const detailCostMeta = useMemo(() => {
    const poItems = (((viewing as any)?.inv_po?.inv_po_items) || []) as Array<{
      product_id?: string | null
      qty?: number | null
      qty_received_total?: number | null
      unit_price?: number | null
    }>
    const unitPriceByProductId: Record<string, number> = {}
    poItems.forEach((poItem) => {
      if (!poItem?.product_id) return
      if (poItem.unit_price == null) return
      unitPriceByProductId[poItem.product_id] = Number(poItem.unit_price)
    })

    const poTotalReceived = poItems.reduce((sum, poItem) => sum + (Number(poItem.qty_received_total) || 0), 0)
    const poTotalOrdered = poItems.reduce((sum, poItem) => sum + (Number(poItem.qty) || 0), 0)
    const intlShippingTotal = (viewing as any)?.inv_po?.intl_shipping_cost_thb
    const intlDenominator = poTotalReceived > 0 ? poTotalReceived : poTotalOrdered
    const intlShippingPerPiece =
      intlShippingTotal != null && intlDenominator > 0
        ? Number(intlShippingTotal) / intlDenominator
        : null

    const grItems = (viewing?.inv_gr_items || []) as Array<{ qty_received?: number | null }>
    const grTotalReceived = grItems.reduce((sum, grItem) => sum + (Number(grItem.qty_received) || 0), 0)
    const domShippingPerPiece =
      viewing?.dom_cost_per_piece != null
        ? Number(viewing.dom_cost_per_piece)
        : viewing?.dom_shipping_cost != null && grTotalReceived > 0
          ? Number(viewing.dom_shipping_cost) / grTotalReceived
          : null

    return {
      unitPriceByProductId,
      intlShippingPerPiece,
      domShippingPerPiece,
    }
  }, [viewing])

  useEffect(() => {
    if (mobileSection === 'receive' && receiveQueueCount === 0) {
      setMobileSection('list')
    }
  }, [mobileSection, receiveQueueCount])

  return (
    <div className="space-y-4 mt-4 md:mt-12">
      <div className="md:hidden bg-white rounded-xl shadow-sm border p-2">
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => setMobileSection('receive')}
            className={`px-3 py-2 rounded-lg text-sm font-semibold transition-colors ${
              mobileSection === 'receive'
                ? 'bg-emerald-600 text-white'
                : 'bg-gray-100 text-gray-600'
            }`}
          >
            รับเข้า
            {receiveQueueCount > 0 && (
              <span className={`ml-1.5 inline-flex items-center justify-center min-w-[1.1rem] h-5 px-1.5 rounded-full text-[11px] font-bold ${
                mobileSection === 'receive' ? 'bg-white text-emerald-700' : 'bg-red-500 text-white'
              }`}>
                {receiveQueueCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setMobileSection('list')}
            className={`px-3 py-2 rounded-lg text-sm font-semibold transition-colors ${
              mobileSection === 'list'
                ? 'bg-emerald-600 text-white'
                : 'bg-gray-100 text-gray-600'
            }`}
          >
            รายการ
          </button>
        </div>
      </div>

      {/* ── New POs waiting for first GR ── */}
      {sortedNewPOs.length > 0 && (
        <div className={`${mobileSection === 'receive' ? 'block' : 'hidden'} md:block bg-blue-50 border border-blue-200 rounded-xl p-3 md:p-4`}>
          <h3 className="text-sm font-semibold text-blue-800 mb-3">PO ใหม่ รอรับเข้าคลัง ({sortedNewPOs.length})</h3>

          <div className="md:hidden space-y-2">
            {sortedNewPOs.map((po) => {
              const eta = getEtaMeta(po.expected_arrival_date)
              return (
                <div
                  key={po.id}
                  className="rounded-xl bg-white border border-blue-200 p-3 text-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-gray-900">{po.po_no}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">
                          {formatDateThai(po.expected_arrival_date)}
                        </span>
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${eta.color}`}>
                          {eta.label}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={() => openEtaEdit(po)}
                      className="px-2.5 py-1.5 rounded-md border border-blue-300 bg-blue-50 text-blue-700 text-xs font-semibold whitespace-nowrap"
                    >
                      แก้ไขวันที่
                    </button>
                  </div>
                  <button
                    onClick={() => openReceive(po, false)}
                    className="mt-2 w-full px-3 py-2 bg-emerald-600 text-white rounded-lg text-sm font-semibold"
                  >
                    รับเข้าคลัง
                  </button>
                </div>
              )
            })}
          </div>

          <div className="hidden md:flex md:flex-wrap gap-2">
            {sortedNewPOs.map((po) => {
              const eta = getEtaMeta(po.expected_arrival_date)
              return (
                <div
                  key={po.id}
                  className="w-full md:w-auto px-3 py-2 bg-white border border-blue-200 rounded-lg text-sm text-blue-700"
                >
                  <div className="flex items-start justify-between gap-3">
                    <button
                      onClick={() => openReceive(po, false)}
                      className="text-left font-medium hover:text-blue-800 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-base">{po.po_no}</span>
                        <span className={`inline-block px-2 py-0.5 rounded-full text-sm font-semibold ${eta.color}`}>
                          {eta.label}
                        </span>
                      </div>
                      <div className="text-sm text-gray-600 mt-1 font-medium">
                        กำหนดเข้า: {formatDateThai(po.expected_arrival_date)}
                      </div>
                    </button>
                    <button
                      onClick={() => openEtaEdit(po)}
                      className="px-2.5 py-1.5 rounded-md border border-blue-300 bg-blue-50 text-blue-700 text-xs font-semibold hover:bg-blue-100 transition-colors whitespace-nowrap"
                    >
                      แก้ไขกำหนดเข้า
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Partial POs waiting for follow-up GR ── */}
      {sortedPartialPOs.length > 0 && (
        <div className={`${mobileSection === 'receive' ? 'block' : 'hidden'} md:block bg-amber-50 border border-amber-200 rounded-xl p-3 md:p-4`}>
          <h3 className="text-sm font-semibold text-amber-800 mb-3 flex items-center gap-2">
            PO รอรับเพิ่ม
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-amber-600 text-white text-xs font-bold">
              {partialCount}
            </span>
          </h3>

          <div className="md:hidden space-y-2">
            {sortedPartialPOs.map((po) => {
              const items = (po.inv_po_items || []) as any[]
              const totalQty = items.reduce((s: number, i: any) => s + (Number(i.qty) || 0), 0)
              const totalRecv = items.reduce((s: number, i: any) => s + (Number(i.qty_received_total) || 0), 0)
              const outstanding = totalQty - totalRecv
              const eta = getEtaMeta(po.expected_arrival_date)
              return (
                <div key={po.id} className="bg-white border border-amber-200 rounded-xl p-3 space-y-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-gray-900">{po.po_no}</div>
                      <div className="text-xs text-gray-500 mt-1">
                        รับแล้ว {totalRecv.toLocaleString()}/{totalQty.toLocaleString()}
                      </div>
                    </div>
                    <span className="inline-block px-2 py-0.5 bg-amber-100 text-amber-800 rounded-full text-xs font-semibold whitespace-nowrap">
                      ค้างรับ {outstanding.toLocaleString()} ชิ้น
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${eta.color}`}>
                      {formatDateThai(po.expected_arrival_date)}
                    </span>
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${eta.color}`}>
                      {eta.label}
                    </span>
                  </div>
                  <button
                    onClick={() => openReceive(po, true)}
                    className="w-full px-3 py-2 bg-amber-600 text-white rounded-lg text-sm font-semibold"
                  >
                    รับเพิ่ม
                  </button>
                </div>
              )
            })}
          </div>

          <div className="hidden md:block space-y-2">
            {sortedPartialPOs.map((po) => {
              const items = (po.inv_po_items || []) as any[]
              const totalQty = items.reduce((s: number, i: any) => s + (Number(i.qty) || 0), 0)
              const totalRecv = items.reduce((s: number, i: any) => s + (Number(i.qty_received_total) || 0), 0)
              const outstanding = totalQty - totalRecv
              const eta = getEtaMeta(po.expected_arrival_date)
              return (
                <div key={po.id} className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 bg-white border border-amber-200 rounded-lg px-3 md:px-4 py-2.5">
                  <div className="flex flex-wrap items-center gap-2 md:gap-3">
                    <span className="font-medium text-gray-900 text-sm">{po.po_no}</span>
                    <span className="text-xs text-gray-500">
                      รับแล้ว {totalRecv.toLocaleString()}/{totalQty.toLocaleString()}
                    </span>
                    <span className="inline-block px-2 py-0.5 bg-amber-100 text-amber-800 rounded-full text-xs font-semibold">
                      ค้างรับ {outstanding.toLocaleString()} ชิ้น
                    </span>
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${eta.color}`}>
                      {formatDateThai(po.expected_arrival_date)}
                    </span>
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${eta.color}`}>
                      {eta.label}
                    </span>
                  </div>
                  <button
                    onClick={() => openReceive(po, true)}
                    className="self-end md:self-auto px-3 py-1.5 bg-amber-600 text-white rounded-lg text-xs font-semibold hover:bg-amber-700 transition-colors"
                  >
                    รับเพิ่ม
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Filter Bar ── */}
      <div className={`${mobileSection === 'list' ? 'block' : 'hidden'} md:block bg-white rounded-xl shadow-sm border p-4`}>
        <div className="md:hidden space-y-2.5">
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1 overflow-x-auto">
            {statusTabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setStatusFilter(t.key)}
                className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors whitespace-nowrap ${
                  statusFilter === t.key ? 'bg-white shadow text-emerald-700' : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1 overflow-x-auto">
            {[
              { key: 'all', label: 'ทุกประเภท' },
              { key: 'normal', label: 'ปกติ', color: 'text-blue-700' },
              { key: 'urgent', label: 'ด่วน', color: 'text-red-700' },
            ].map((t) => (
              <button
                key={t.key}
                onClick={() => setTypeFilter(t.key)}
                className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors whitespace-nowrap ${
                  typeFilter === t.key ? `bg-white shadow ${t.color || 'text-gray-800'}` : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div>
            <input
              type="text"
              placeholder="ค้นหาเลขที่ GR..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
            />
          </div>
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="px-2 py-2 border rounded-lg text-sm text-black focus:outline-none" title="ตั้งแต่วันที่" />
            <span className="text-gray-400 text-sm">-</span>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="px-2 py-2 border rounded-lg text-sm text-black focus:outline-none" title="ถึงวันที่" />
          </div>
        </div>

        <div className="hidden md:flex md:flex-wrap md:items-center gap-3">
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
            {statusTabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setStatusFilter(t.key)}
                className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${
                  statusFilter === t.key ? 'bg-white shadow text-emerald-700' : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
            {[
              { key: 'all', label: 'ทุกประเภท' },
              { key: 'normal', label: 'ปกติ', color: 'text-blue-700' },
              { key: 'urgent', label: 'ด่วน', color: 'text-red-700' },
            ].map((t) => (
              <button
                key={t.key}
                onClick={() => setTypeFilter(t.key)}
                className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${
                  typeFilter === t.key ? `bg-white shadow ${t.color || 'text-gray-800'}` : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="w-full md:flex-1 md:min-w-[200px]">
            <input
              type="text"
              placeholder="ค้นหาเลขที่ GR..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
            />
          </div>
          <div className="w-full md:w-auto flex items-center gap-2">
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="flex-1 md:flex-none px-2 py-2 border rounded-lg text-sm text-black focus:outline-none" title="ตั้งแต่วันที่" />
            <span className="text-gray-400 text-sm">-</span>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="flex-1 md:flex-none px-2 py-2 border rounded-lg text-sm text-black focus:outline-none" title="ถึงวันที่" />
          </div>
        </div>
      </div>

      {/* ── GR List ── */}
      <div className={`${mobileSection === 'list' ? 'block' : 'hidden'} md:block bg-white rounded-xl shadow-sm border`}>
        {loading ? (
          <div className="flex justify-center items-center py-16">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-500" />
          </div>
        ) : grs.length === 0 ? (
          <div className="text-center py-16 text-gray-400">ไม่พบรายการ GR</div>
        ) : (
          <>
          <div className="md:hidden divide-y">
            {grRowsWithGroup.map(({ gr, groupIndex }) => {
              const items = (gr as any).inv_gr_items || []
              const grTotalOrdered = items.reduce((s: number, i: any) => s + (Number(i.qty_ordered) || 0), 0)
              const grTotalReceived = items.reduce((s: number, i: any) => s + (Number(i.qty_received) || 0), 0)
              const st = getGRDisplayStatus(gr)
              const eta = getEtaMeta(gr.inv_po?.expected_arrival_date)
              const poStatus = (gr.inv_po as any)?.status
              const showEtaCountdown = gr.status !== 'received' && poStatus !== 'received' && poStatus !== 'closed'
              const rowBg = groupIndex % 2 === 0 ? 'bg-blue-200' : 'bg-white'
              return (
                <div key={gr.id} className={`p-3 space-y-2 ${rowBg}`}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-semibold text-gray-900">{gr.gr_no}</div>
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold ${st.color}`}>{st.label}</span>
                  </div>
                  <div className="space-y-1 text-xs text-gray-700">
                    <div>PO: <span className="font-medium">{gr.inv_po?.po_no || '-'}</span></div>
                    <div>วันที่รับ: {gr.received_at ? new Date(gr.received_at).toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: 'numeric' }) : '-'}</div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-white/80 text-gray-700 border border-gray-200">
                        กำหนดเข้า: {formatDateThai(gr.inv_po?.expected_arrival_date)}
                      </span>
                      {showEtaCountdown && (
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full font-semibold ${eta.color}`}>
                          {eta.label}
                        </span>
                      )}
                    </div>
                    <div>
                      จำนวน: <span className={grTotalReceived < grTotalOrdered ? 'text-red-600 font-semibold' : 'font-semibold'}>{grTotalReceived}/{grTotalOrdered}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => openDetail(gr)}
                    className="w-full px-3 py-2 bg-emerald-50 text-emerald-700 rounded-lg text-sm font-semibold"
                  >
                    ดูรายละเอียด
                  </button>
                </div>
              )
            })}
          </div>
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b">
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">เลขที่ GR</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">PO</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">กำหนดเข้า</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">สถานะ</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">วันที่รับ</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">ผู้สร้าง</th>
                  <th className="px-4 py-3 text-center font-semibold text-gray-600">จำนวนรายการ</th>
                  {canSeeFinancial && (
                    <>
                      <th className="px-4 py-3 text-right font-semibold text-gray-600">ค่าขนส่ง(ตปท)/ชิ้น</th>
                      <th className="px-4 py-3 text-right font-semibold text-gray-600">ค่าขนส่ง(ไทย)/ชิ้น</th>
                    </>
                  )}
                  <th className="px-4 py-3 text-right font-semibold text-gray-600">จัดการ</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {grRowsWithGroup.map(({ gr, groupIndex }) => {
                  const items = (gr as any).inv_gr_items || []
                  const grTotalOrdered = items.reduce((s: number, i: any) => s + (Number(i.qty_ordered) || 0), 0)
                  const grTotalReceived = items.reduce((s: number, i: any) => s + (Number(i.qty_received) || 0), 0)
                  const st = getGRDisplayStatus(gr)
                  const eta = getEtaMeta(gr.inv_po?.expected_arrival_date)
                  const poStatus = (gr.inv_po as any)?.status
                  const showEtaCountdown = gr.status !== 'received' && poStatus !== 'received' && poStatus !== 'closed'
                  const rowBg = groupIndex % 2 === 0 ? 'bg-blue-200' : 'bg-white'
                  const poItems = ((gr.inv_po as any)?.inv_po_items || []) as Array<{ qty_received_total?: number | null }>
                  const poTotalReceived = poItems.reduce((sum, item) => sum + (Number(item.qty_received_total) || 0), 0)
                  const intlShippingTotal = (gr.inv_po as any)?.intl_shipping_cost_thb != null
                    ? Number((gr.inv_po as any).intl_shipping_cost_thb)
                    : null
                  const intlShippingPerPiece = intlShippingTotal != null && poTotalReceived > 0
                    ? intlShippingTotal / poTotalReceived
                    : null
                  const thaiShippingTotal = gr.dom_shipping_cost != null ? Number(gr.dom_shipping_cost) : null
                  const thaiShippingPerPiece = gr.dom_cost_per_piece != null ? Number(gr.dom_cost_per_piece) : null
                  return (
                    <tr key={gr.id} className={rowBg}>
                      <td className="px-4 py-3 font-medium text-gray-900">{gr.gr_no}</td>
                      <td className="px-4 py-3 text-gray-600">{gr.inv_po?.po_no || '-'}</td>
                      <td className="px-4 py-3 text-gray-600">
                        <div className="flex flex-col gap-1">
                          <span>{formatDateThai(gr.inv_po?.expected_arrival_date)}</span>
                          {showEtaCountdown && (
                            <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold w-fit ${eta.color}`}>
                              {eta.label}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${st.color}`}>
                          {st.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {gr.received_at ? new Date(gr.received_at).toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: 'numeric' }) : '-'}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{gr.received_by ? userMap[gr.received_by] || '-' : '-'}</td>
                      <td className="px-4 py-3 text-center text-gray-600">
                        <span className={grTotalReceived < grTotalOrdered ? 'text-red-600 font-semibold' : ''}>
                          {grTotalReceived}/{grTotalOrdered}
                        </span>
                      </td>
                      {canSeeFinancial && (
                        <>
                          <td className="px-4 py-3 text-right text-gray-600">
                            {formatTotalPerPiece(intlShippingTotal, intlShippingPerPiece)}
                          </td>
                          <td className="px-4 py-3 text-right text-gray-600">
                            {formatTotalPerPiece(thaiShippingTotal, thaiShippingPerPiece)}
                          </td>
                        </>
                      )}
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => openDetail(gr)}
                          className="px-3 py-1.5 bg-emerald-50 text-emerald-700 rounded-lg hover:bg-emerald-100 text-xs font-semibold"
                        >
                          ดูรายละเอียด
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          </>
        )}
      </div>

      {/* ── Receive GR Modal ── */}
      <Modal open={receiveOpen} onClose={clearReceiveDraft} closeOnBackdropClick={false} contentClassName="max-w-6xl">
        <div className="p-4 md:p-6 space-y-5">
          <h2 className="text-lg md:text-xl font-bold text-gray-900">
            {isFollowUp ? 'รับสินค้าเพิ่ม (Follow-up GR)' : 'ตรวจรับสินค้า (GR)'}
          </h2>
          {selectedPO && (
            <>
              <div className={`rounded-lg p-3 text-sm ${isFollowUp ? 'bg-red-50' : 'bg-orange-50'}`}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className={`font-semibold ${isFollowUp ? 'text-red-800' : 'text-orange-800'}`}>PO: {selectedPO.po_no}</span>
                  {selectedPO.supplier_name && <span className="text-gray-600">ผู้ขาย: {selectedPO.supplier_name}</span>}
                  <span className="text-gray-600">กำหนดเข้า: {formatDateThai(selectedPO.expected_arrival_date)}</span>
                  {isFollowUp && <span className="text-red-600 font-medium">รับรอบถัดไป (แสดงเฉพาะยอดค้างรับ)</span>}
                </div>
              </div>
              {(selectedPO.note || (selectedPO as any).inv_pr?.note) && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm space-y-1">
                  <div className="font-semibold text-amber-800 text-xs">หมายเหตุจากเอกสาร</div>
                  {(selectedPO as any).inv_pr?.note && (
                    <div className="text-amber-700"><span className="font-medium">PR:</span> {(selectedPO as any).inv_pr.note}</div>
                  )}
                  {selectedPO.note && (
                    <div className="text-amber-700"><span className="font-medium">PO:</span> {selectedPO.note}</div>
                  )}
                </div>
              )}
            </>
          )}

          {/* items table */}
          <div className="md:hidden space-y-3">
            {receiveItems.map((item, index) => {
              const qtyReceived = Number(item.qty_received) || 0
              const shortage = Math.max(item.qty_ordered - qtyReceived, 0)
              const imgUrl = getPublicUrl('product-images', item.product_code)
              return (
                <div key={`mobile-${item.product_id}-${index}`} className={`border rounded-lg p-3 space-y-3 ${shortage > 0 ? 'bg-red-50/40 border-red-200' : 'bg-white'}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                    <button
                      type="button"
                      onClick={() => { if (imgUrl) openZoomGallery([imgUrl], 0) }}
                      className="w-12 h-12 rounded bg-gray-200 overflow-hidden shrink-0 border"
                    >
                      {imgUrl ? (
                        <img src={imgUrl} alt="" className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-400 text-[10px]">-</div>
                      )}
                    </button>
                    <div className="min-w-0">
                      <div className="font-medium text-sm">{item.product_code} - {item.product_name}</div>
                      {item.item_note && <div className="text-xs text-amber-600 mt-0.5">* {item.item_note}</div>}
                    </div>
                    </div>
                    <div className="flex items-start gap-2 text-xs shrink-0">
                      {isFollowUp && (
                        <div className="rounded bg-blue-50 px-2.5 py-1.5 text-center min-w-[66px]">
                          <div className="text-gray-500 leading-tight">รับแล้ว</div>
                          <div className="font-bold text-blue-700 mt-0.5 leading-tight">{item.qty_already_received.toLocaleString()}</div>
                        </div>
                      )}
                      <div className="rounded bg-gray-50 px-2.5 py-1.5 text-center min-w-[72px]">
                        <div className="text-gray-500 leading-tight">{isFollowUp ? 'ค้างรับ' : 'สั่ง'}</div>
                        <div className="font-bold mt-0.5 leading-tight text-gray-900">{Number(item.qty_ordered).toLocaleString()}</div>
                      </div>
                      <div className="rounded bg-red-50 px-2.5 py-1.5 text-center min-w-[56px]">
                        <div className="text-gray-500 leading-tight">ขาด</div>
                        <div className="font-bold text-red-600 mt-0.5 leading-tight">{shortage.toLocaleString()}</div>
                      </div>
                      <div className="rounded bg-emerald-50 px-2.5 py-1.5 text-center min-w-[56px]">
                        <div className="text-gray-500 leading-tight">เกิน</div>
                        <div className="font-bold text-emerald-700 mt-0.5 leading-tight">{Math.max(qtyReceived - item.qty_ordered, 0).toLocaleString()}</div>
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs text-gray-600 mb-1">รับ</label>
                    <input
                      type="number"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      min={0}
                      step={1}
                      value={item.qty_received}
                      onFocus={() => {
                        if (item.qty_received === 0) updateReceiveItem(index, { qty_received: '' })
                      }}
                      onBlur={() => {
                        if (item.qty_received === '') updateReceiveItem(index, { qty_received: 0 })
                      }}
                      onChange={(e) => setReceiveQtyFromInput(index, e.target.value)}
                      onWheel={(e) => (e.target as HTMLInputElement).blur()}
                      className="w-full px-3 py-2 border rounded-lg text-sm text-right bg-white text-gray-900 caret-gray-900"
                    />
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-xs text-gray-600">รูป GR (สูงสุด 5)</label>
                      <span className="text-[11px] text-gray-500">{item.images.length}/{MAX_ITEM_IMAGES}</span>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <label htmlFor={`camera-mobile-${index}`} className="px-3 py-2 rounded-lg border text-xs font-medium text-gray-700 hover:bg-gray-50 cursor-pointer">
                        ถ่ายรูป
                      </label>
                      <input
                        id={`camera-mobile-${index}`}
                        type="file"
                        accept="image/*"
                        capture="environment"
                        onChange={(e) => {
                          addReceiveItemImages(index, e.target.files)
                          e.target.value = ''
                        }}
                        className="hidden"
                      />
                      <label htmlFor={`gallery-mobile-${index}`} className="px-3 py-2 rounded-lg border text-xs font-medium text-gray-700 hover:bg-gray-50 cursor-pointer">
                        เลือกรูป
                      </label>
                      <input
                        id={`gallery-mobile-${index}`}
                        type="file"
                        accept="image/*"
                        multiple
                        onChange={(e) => {
                          addReceiveItemImages(index, e.target.files)
                          e.target.value = ''
                        }}
                        className="hidden"
                      />
                    </div>
                    {item.images.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {item.images.map((image, imageIndex) => (
                          <div key={image.id} className="relative">
                            <button
                              type="button"
                              onClick={() => openZoomGallery(item.images.map((img) => img.previewUrl), imageIndex)}
                              className="block"
                            >
                              <img src={image.previewUrl} alt="" className="w-16 h-16 rounded border object-cover" />
                            </button>
                            <button
                              type="button"
                              onClick={() => removeReceiveItemImage(index, image.id)}
                              className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-600 text-white text-[10px]"
                              title="ลบรูป"
                            >
                              ×
                            </button>
                            <div className="mt-1 flex justify-center gap-1">
                              <button
                                type="button"
                                disabled={imageIndex === 0}
                                onClick={() => reorderReceiveItemImage(index, image.id, -1)}
                                className="px-1.5 py-0.5 text-[10px] border rounded disabled:opacity-40"
                              >
                                ←
                              </button>
                              <button
                                type="button"
                                disabled={imageIndex === item.images.length - 1}
                                onClick={() => reorderReceiveItemImage(index, image.id, 1)}
                                className="px-1.5 py-0.5 text-[10px] border rounded disabled:opacity-40"
                              >
                                →
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {shortage > 0 && (
                    <div>
                      <label className="block text-xs text-red-600 mb-1">หมายเหตุขาดส่ง</label>
                      <input
                        type="text"
                        value={item.shortage_note}
                        onChange={(e) => updateReceiveItem(index, { shortage_note: e.target.value })}
                        className="w-full px-2 py-1.5 border rounded-lg text-xs border-red-200"
                        placeholder="ระบุเหตุผล..."
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <div className="hidden md:block overflow-x-auto border rounded-lg">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b">
                  <th className="px-3 py-2.5 text-left font-semibold text-gray-600 w-14">รูป</th>
                  <th className="px-3 py-2.5 text-left font-semibold text-gray-600">สินค้า</th>
                  {isFollowUp && (
                    <th className="px-3 py-2.5 text-right font-semibold text-gray-600 w-24">รับแล้ว</th>
                  )}
                  <th className="px-3 py-2.5 text-right font-semibold text-gray-600 w-24">{isFollowUp ? 'ค้างรับ' : 'สั่ง'}</th>
                  <th className="px-3 py-2.5 text-right font-semibold text-gray-600 w-28">รับ</th>
                  <th className="px-3 py-2.5 text-right font-semibold text-gray-600 w-20">ขาด</th>
                  <th className="px-3 py-2.5 text-right font-semibold text-gray-600 w-20">เกิน</th>
                  <th className="px-3 py-2.5 text-left font-semibold text-gray-600 w-72">รูป GR (สูงสุด 5)</th>
                  <th className="px-3 py-2.5 text-left font-semibold text-gray-600 w-40">หมายเหตุขาดส่ง</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {receiveItems.map((item, index) => {
                  const qtyReceived = Number(item.qty_received) || 0
                  const shortage = Math.max(item.qty_ordered - qtyReceived, 0)
                  const excess = Math.max(qtyReceived - item.qty_ordered, 0)
                  const imgUrl = getPublicUrl('product-images', item.product_code)
                  return (
                    <tr key={`${item.product_id}-${index}`} className={shortage > 0 ? 'bg-red-50/50' : ''}>
                      <td className="px-3 py-2">
                        <div className="w-10 h-10 rounded bg-gray-200 overflow-hidden">
                          {imgUrl ? (
                            <img src={imgUrl} alt="" className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-gray-400 text-[10px]">-</div>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{item.product_code} - {item.product_name}</div>
                        {item.item_note && (
                          <div className="text-xs text-amber-600 mt-0.5">* {item.item_note}</div>
                        )}
                      </td>
                      {isFollowUp && (
                        <td className="px-3 py-2 text-right text-blue-600 font-medium">{item.qty_already_received.toLocaleString()}</td>
                      )}
                      <td className="px-3 py-2 text-right text-gray-600">{Number(item.qty_ordered).toLocaleString()}</td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          min={0}
                          step={1}
                          value={item.qty_received}
                          onFocus={() => {
                            if (item.qty_received === 0) updateReceiveItem(index, { qty_received: '' })
                          }}
                          onBlur={() => {
                            if (item.qty_received === '') updateReceiveItem(index, { qty_received: 0 })
                          }}
                          onChange={(e) => setReceiveQtyFromInput(index, e.target.value)}
                          onWheel={(e) => (e.target as HTMLInputElement).blur()}
                          className="w-full px-2 py-1.5 border rounded-lg text-sm text-right bg-white text-gray-900 caret-gray-900"
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        {shortage > 0 ? (
                          <span className="text-red-600 font-semibold">{shortage.toLocaleString()}</span>
                        ) : (
                          <span className="text-green-600">-</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {excess > 0 ? (
                          <span className="text-emerald-700 font-semibold">{excess.toLocaleString()}</span>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="space-y-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <label htmlFor={`camera-desktop-${index}`} className="px-2 py-1.5 rounded-lg border text-xs font-medium text-gray-700 hover:bg-gray-50 cursor-pointer">
                              ถ่ายรูป
                            </label>
                            <input
                              id={`camera-desktop-${index}`}
                              type="file"
                              accept="image/*"
                              capture="environment"
                              onChange={(e) => {
                                addReceiveItemImages(index, e.target.files)
                                e.target.value = ''
                              }}
                              className="hidden"
                            />
                            <label htmlFor={`gallery-desktop-${index}`} className="px-2 py-1.5 rounded-lg border text-xs font-medium text-gray-700 hover:bg-gray-50 cursor-pointer">
                              เลือกรูป
                            </label>
                            <input
                              id={`gallery-desktop-${index}`}
                              type="file"
                              accept="image/*"
                              multiple
                              onChange={(e) => {
                                addReceiveItemImages(index, e.target.files)
                                e.target.value = ''
                              }}
                              className="hidden"
                            />
                            <span className="text-[11px] text-gray-500 whitespace-nowrap">
                              {item.images.length}/{MAX_ITEM_IMAGES}
                            </span>
                          </div>
                          {item.images.length > 0 && (
                            <div className="flex flex-wrap gap-2">
                              {item.images.map((image, imageIndex) => (
                                <div key={image.id} className="relative">
                                  <img src={image.previewUrl} alt="" className="w-14 h-14 rounded border object-cover" />
                                  <div className="absolute -top-1 -right-1 flex gap-1">
                                    <button
                                      type="button"
                                      onClick={() => removeReceiveItemImage(index, image.id)}
                                      className="w-5 h-5 rounded-full bg-red-600 text-white text-[10px]"
                                      title="ลบรูป"
                                    >
                                      ×
                                    </button>
                                  </div>
                                  <div className="mt-1 flex justify-center gap-1">
                                    <button
                                      type="button"
                                      disabled={imageIndex === 0}
                                      onClick={() => reorderReceiveItemImage(index, image.id, -1)}
                                      className="px-1.5 py-0.5 text-[10px] border rounded disabled:opacity-40"
                                      title="เลื่อนซ้าย"
                                    >
                                      ←
                                    </button>
                                    <button
                                      type="button"
                                      disabled={imageIndex === item.images.length - 1}
                                      onClick={() => reorderReceiveItemImage(index, image.id, 1)}
                                      className="px-1.5 py-0.5 text-[10px] border rounded disabled:opacity-40"
                                      title="เลื่อนขวา"
                                    >
                                      →
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        {shortage > 0 && (
                          <input
                            type="text"
                            value={item.shortage_note}
                            onChange={(e) => updateReceiveItem(index, { shortage_note: e.target.value })}
                            className="w-full px-2 py-1.5 border rounded-lg text-xs border-red-200"
                            placeholder="ระบุเหตุผล..."
                          />
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="bg-gray-50 border-t">
                  <td colSpan={isFollowUp ? 3 : 2} className="px-3 py-2.5 text-right font-semibold text-gray-700">รวม</td>
                  <td className="px-3 py-2.5 text-right font-medium">{totalOrdered.toLocaleString()}</td>
                  <td className="px-3 py-2.5 text-right font-medium">{totalReceived.toLocaleString()}</td>
                  <td className="px-3 py-2.5 text-right font-semibold text-red-600">
                    {hasShortage ? totalShortage.toLocaleString() : '-'}
                  </td>
                  <td className="px-3 py-2.5 text-right font-semibold text-emerald-700">
                    {hasExcess ? totalExcess.toLocaleString() : '-'}
                  </td>
                  <td></td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>

          {hasShortage && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <label className="block text-xs text-red-600 font-medium mb-1">หมายเหตุภาพรวมของขาดส่ง</label>
              <input
                type="text"
                value={shortageNote}
                onChange={(e) => setShortageNote(e.target.value)}
                className="w-full px-3 py-2 border border-red-200 rounded-lg text-sm"
                placeholder="เช่น ติดตามส่งรอบหน้า..."
              />
            </div>
          )}

          {canSeeFinancial && (
            <div className="border rounded-lg">
              <button
                onClick={() => setShippingExpanded(!shippingExpanded)}
                className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                <span>ค่าขนส่งในประเทศ (ไม่บังคับ)</span>
                <svg className={`w-4 h-4 transition-transform ${shippingExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {shippingExpanded && (
                <div className="px-4 pb-4 space-y-3 border-t">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">ชื่อบริษัทขนส่ง</label>
                      <input
                        type="text"
                        value={domCompany}
                        onChange={(e) => setDomCompany(e.target.value)}
                        className="w-full px-3 py-2 border rounded-lg text-sm"
                        placeholder="เช่น Kerry, Flash, J&T..."
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">ค่าขนส่งรวม (บาท)</label>
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        value={domCost}
                        onChange={(e) => setDomCost(e.target.value)}
                        onWheel={(e) => (e.target as HTMLInputElement).blur()}
                        className="w-full px-3 py-2 border rounded-lg text-sm"
                        placeholder="0.00"
                      />
                    </div>
                  </div>
                  {costPerPiece > 0 && (
                    <div className="bg-blue-50 rounded-lg p-3 text-sm">
                      <span className="text-blue-600">ต้นทุนขนส่งต่อชิ้น:</span>{' '}
                      <span className="font-bold text-blue-800">{costPerPiece.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} บาท</span>
                      <span className="text-xs text-gray-500 ml-2">({Number(domCost).toLocaleString()} / {totalReceived.toLocaleString()} ชิ้น)</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* note */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">หมายเหตุ</label>
            <textarea
              value={grNote}
              onChange={(e) => setGrNote(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm resize-y"
              rows={2}
              placeholder="หมายเหตุเพิ่มเติม (ถ้ามี)"
              onFocus={(e) => { if (e.target.rows < 4) e.target.rows = 4 }}
            />
          </div>

          <div className="flex justify-end gap-3 pt-2 border-t">
            <button onClick={clearReceiveDraft} className="px-5 py-2.5 border rounded-lg hover:bg-gray-50 text-sm font-medium text-gray-700">
              ยกเลิก
            </button>
            <button onClick={handleReceive} disabled={saving} className="px-5 py-2.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 text-sm font-semibold">
              {saving ? 'กำลังบันทึก...' : hasExcess ? 'รับเกิน' : hasShortage ? 'รับบางส่วน' : 'รับเข้าคลัง'}
            </button>
          </div>
        </div>
      </Modal>

      {/* ── Detail Modal ── */}
      <Modal open={!!viewing} onClose={() => setViewing(null)} contentClassName="max-w-4xl">
        <div className="p-6 space-y-5">
          {detailLoading ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-500" />
            </div>
          ) : viewing ? (
            <>
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-xl font-bold text-gray-900">รายละเอียด GR</h2>
                  <div className="text-sm text-gray-500 mt-1">
                    เลขที่: <span className="font-semibold text-gray-800">{viewing.gr_no}</span>
                  </div>
                  {(viewing as any).inv_po?.po_no && (
                    <div className="text-sm text-gray-500">
                      PO: <span className="font-semibold text-gray-800">{(viewing as any).inv_po.po_no}</span>
                    </div>
                  )}
                </div>
                <span className={`inline-flex items-center justify-center text-center leading-tight px-3 py-1 rounded-full text-xs font-semibold shrink-0 min-w-[64px] ${(STATUS_MAP[viewing.status] || { color: 'bg-gray-100 text-gray-700' }).color}`}>
                  {(STATUS_MAP[viewing.status] || { label: viewing.status }).label}
                </span>
              </div>

              {/* meta */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-gray-500 text-xs">วันที่รับ</div>
                  <div className="font-medium text-gray-900">{viewing.received_at ? new Date(viewing.received_at).toLocaleString('th-TH') : '-'}</div>
                </div>
                <div className="bg-amber-50 rounded-lg p-3">
                  <div className="text-amber-700 text-xs">กำหนดเข้า (จาก PO)</div>
                  <div className="font-medium text-amber-800">{formatDateThai(viewing.inv_po?.expected_arrival_date)}</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-gray-500 text-xs">ผู้รับสินค้า</div>
                  <div className="font-medium text-gray-900">{viewing.received_by ? userMap[viewing.received_by] || '-' : '-'}</div>
                </div>
                {viewing.dom_shipping_company && (
                  <div className="bg-blue-50 rounded-lg p-3">
                    <div className="text-blue-600 text-xs">บริษัทขนส่ง</div>
                    <div className="font-medium text-blue-900">{viewing.dom_shipping_company}</div>
                  </div>
                )}
              </div>
              {canSeeFinancial && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                  <div className="bg-blue-50 rounded-lg p-3">
                    <div className="text-blue-600 text-xs">ค่าขนส่งต่างประเทศ/ชิ้น</div>
                    <div className="font-medium text-blue-900">
                      {formatTotalPerPiece(
                        (viewing as any).inv_po?.intl_shipping_cost_thb != null ? Number((viewing as any).inv_po.intl_shipping_cost_thb) : null,
                        detailCostMeta.intlShippingPerPiece
                      )}
                    </div>
                  </div>
                  <div className="bg-blue-50 rounded-lg p-3">
                    <div className="text-blue-600 text-xs">ค่าขนส่งในประเทศ/ชิ้น</div>
                    <div className="font-medium text-blue-900">
                      {formatTotalPerPiece(
                        viewing.dom_shipping_cost != null ? Number(viewing.dom_shipping_cost) : null,
                        detailCostMeta.domShippingPerPiece
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* items */}
              <div className="md:hidden space-y-3">
                {(viewing.inv_gr_items || []).map((item: any) => {
                  const prod = item.pr_products
                  const productImageUrl = prod ? getPublicUrl('product-images', prod.product_code) : ''
                  const orderQty = Number(item.qty_ordered || 0)
                  const receivedQty = Number(item.qty_received || 0)
                  const shortage = Number(item.qty_shortage || 0)
                  const excess = Math.max(receivedQty - orderQty, 0)
                  const baseUnitPrice = item.product_id ? detailCostMeta.unitPriceByProductId[item.product_id] : undefined
                  const hasCostFormulaParts =
                    baseUnitPrice != null ||
                    detailCostMeta.intlShippingPerPiece != null ||
                    detailCostMeta.domShippingPerPiece != null
                  const unitCostPerPiece = hasCostFormulaParts
                    ? (Number(baseUnitPrice) || 0) +
                      (detailCostMeta.intlShippingPerPiece || 0) +
                      (detailCostMeta.domShippingPerPiece || 0)
                    : null
                  const receiveImages = [...(item.inv_gr_item_images || [])].sort((a: any, b: any) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0))
                  return (
                    <div key={item.id} className="border rounded-lg p-3 bg-white space-y-3">
                      <div className="flex items-start gap-3">
                        <div className="w-12 h-12 rounded bg-gray-200 overflow-hidden border shrink-0">
                          {productImageUrl ? (
                            <img src={productImageUrl} alt="" className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-gray-400 text-[10px]">-</div>
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="font-semibold text-gray-900 text-sm">{prod?.product_code || '-'}</div>
                          <div className="font-medium text-gray-800 text-sm break-words">{prod?.product_name || '-'}</div>
                        </div>
                      </div>
                      <div className={`grid ${canSeeFinancial ? 'grid-cols-5' : 'grid-cols-4'} gap-2 text-xs`}>
                        <div className="rounded bg-gray-50 p-2 text-center">
                          <div className="text-gray-500">สั่ง</div>
                          <div className="font-semibold text-gray-900">{orderQty.toLocaleString()}</div>
                        </div>
                        <div className="rounded bg-blue-50 p-2 text-center">
                          <div className="text-blue-700">รับ</div>
                          <div className="font-semibold text-blue-900">{receivedQty.toLocaleString()}</div>
                        </div>
                        <div className="rounded bg-red-50 p-2 text-center">
                          <div className="text-red-600">ขาด</div>
                          <div className="font-semibold text-red-700">{shortage.toLocaleString()}</div>
                        </div>
                        <div className="rounded bg-emerald-50 p-2 text-center">
                          <div className="text-emerald-700">เกิน</div>
                          <div className="font-semibold text-emerald-800">{excess.toLocaleString()}</div>
                        </div>
                        {canSeeFinancial && (
                          <div className="rounded bg-purple-50 p-2 text-center">
                            <div className="text-purple-700">ต้นทุนรวม</div>
                            <div className="font-semibold text-purple-900">{unitCostPerPiece != null ? `${formatMoney(unitCostPerPiece, 2, 4)} บาท` : '-'}</div>
                          </div>
                        )}
                      </div>
                      <div>
                        <div className="text-xs text-gray-600 mb-1">รูปตรวจรับ</div>
                        {receiveImages.length > 0 ? (
                          <div className="flex flex-wrap gap-2">
                            {receiveImages.map((image: any, imageIndex: number) => (
                              <img
                                key={image.id}
                                src={getStoragePublicUrl(image.storage_bucket, image.storage_path)}
                                alt=""
                                className="w-14 h-14 rounded border object-cover cursor-zoom-in"
                                onClick={() =>
                                  openZoomGallery(
                                    receiveImages.map((img: any) => getStoragePublicUrl(img.storage_bucket, img.storage_path)),
                                    imageIndex
                                  )
                                }
                              />
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400">-</span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="hidden md:block overflow-x-auto border rounded-lg">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b">
                      <th className="px-3 py-2.5 text-left font-semibold text-gray-600 w-14">รูป</th>
                      <th className="px-3 py-2.5 text-left font-semibold text-gray-600">สินค้า</th>
                      <th className="px-3 py-2.5 text-right font-semibold text-gray-600">สั่ง</th>
                      <th className="px-3 py-2.5 text-right font-semibold text-gray-600">รับ</th>
                      <th className="px-3 py-2.5 text-right font-semibold text-gray-600">ขาด</th>
                      <th className="px-3 py-2.5 text-right font-semibold text-gray-600">เกิน</th>
                      {canSeeFinancial && (
                        <th className="px-3 py-2.5 text-right font-semibold text-gray-600">ต้นทุนรวม</th>
                      )}
                      <th className="px-3 py-2.5 text-left font-semibold text-gray-600">รูปตรวจรับ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {(viewing.inv_gr_items || []).map((item: any) => {
                      const prod = item.pr_products
                      const imgUrl = prod ? getPublicUrl('product-images', prod.product_code) : ''
                      const orderQty = Number(item.qty_ordered || 0)
                      const receivedQty = Number(item.qty_received || 0)
                      const shortage = Number(item.qty_shortage || 0)
                      const excess = Math.max(receivedQty - orderQty, 0)
                      const baseUnitPrice = item.product_id ? detailCostMeta.unitPriceByProductId[item.product_id] : undefined
                      const hasCostFormulaParts =
                        baseUnitPrice != null ||
                        detailCostMeta.intlShippingPerPiece != null ||
                        detailCostMeta.domShippingPerPiece != null
                      const unitCostPerPiece = hasCostFormulaParts
                        ? (Number(baseUnitPrice) || 0) +
                          (detailCostMeta.intlShippingPerPiece || 0) +
                          (detailCostMeta.domShippingPerPiece || 0)
                        : null
                      const receiveImages = [...(item.inv_gr_item_images || [])].sort((a: any, b: any) => {
                        const aOrder = Number(a.sort_order) || 0
                        const bOrder = Number(b.sort_order) || 0
                        return aOrder - bOrder
                      })
                      return (
                        <tr key={item.id} className={shortage > 0 ? 'bg-red-50/50' : ''}>
                          <td className="px-3 py-2">
                            <div className="w-10 h-10 rounded bg-gray-200 overflow-hidden">
                              {imgUrl ? (
                                <img src={imgUrl} alt="" className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center text-gray-400 text-[10px]">-</div>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <div className="font-medium text-gray-900">{prod?.product_code || '-'}</div>
                            <div className="text-sm text-gray-700 break-words">{prod?.product_name || '-'}</div>
                          </td>
                          <td className="px-3 py-2 text-right text-gray-600">{item.qty_ordered != null ? orderQty.toLocaleString() : '-'}</td>
                          <td className="px-3 py-2 text-right font-medium">{receivedQty.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right">
                            {shortage > 0 ? (
                              <span className="text-red-600 font-semibold">{shortage.toLocaleString()}</span>
                            ) : (
                              <span className="text-green-600">-</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {excess > 0 ? (
                              <span className="text-emerald-700 font-semibold">{excess.toLocaleString()}</span>
                            ) : (
                              <span className="text-gray-400">-</span>
                            )}
                          </td>
                          {canSeeFinancial && (
                            <td className="px-3 py-2 text-right text-gray-600">
                              {unitCostPerPiece != null ? `${formatMoney(unitCostPerPiece, 2, 4)} บาท` : '-'}
                            </td>
                          )}
                          <td className="px-3 py-2">
                            {receiveImages.length > 0 ? (
                              <div className="flex flex-wrap gap-2">
                                {receiveImages.map((image: any, imageIndex: number) => (
                                  <button
                                    key={image.id}
                                    type="button"
                                    className="rounded border"
                                    onClick={() =>
                                      openZoomGallery(
                                        receiveImages.map((img: any) => getStoragePublicUrl(img.storage_bucket, img.storage_path)),
                                        imageIndex
                                      )
                                    }
                                  >
                                    <img
                                      src={getStoragePublicUrl(image.storage_bucket, image.storage_path)}
                                      alt=""
                                      className="w-12 h-12 rounded object-cover cursor-zoom-in"
                                    />
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <span className="text-xs text-gray-400">-</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                <div className="bg-amber-50 rounded-lg p-3">
                  <span className="text-amber-700 font-medium">หมายเหตุ PR:</span>{' '}
                  <span className="text-gray-800">{viewing.inv_po?.inv_pr?.note?.trim() || '-'}</span>
                </div>
                <div className="bg-blue-50 rounded-lg p-3">
                  <span className="text-blue-600 font-medium">หมายเหตุ PO:</span>{' '}
                  <span className="text-gray-800">{viewing.inv_po?.note?.trim() || '-'}</span>
                </div>
                <div className="bg-blue-50 rounded-lg p-3">
                  <span className="text-blue-600 font-medium">หมายเหตุ GR:</span>{' '}
                  <span className="text-gray-800">{viewing.note?.trim() || '-'}</span>
                </div>
                <div className="bg-red-50 rounded-lg p-3">
                  <span className="text-red-600 font-medium">หมายเหตุของขาดส่ง:</span>{' '}
                  <span className="text-gray-800">{viewing.shortage_note?.trim() || '-'}</span>
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t">
                <button onClick={() => setViewing(null)} className="px-5 py-2.5 border rounded-lg bg-white text-gray-700 hover:bg-gray-50 text-sm font-medium">
                  ปิดหน้าต่าง
                </button>
              </div>
            </>
          ) : null}
        </div>
      </Modal>

      <Modal open={!!pendingImageSelection} onClose={closePendingImageSelection} closeOnBackdropClick={false} contentClassName="max-w-lg">
        <div className="p-5 space-y-4">
          <h3 className="text-lg font-bold text-gray-900">ตรวจสอบรูปก่อนเพิ่ม</h3>
          <p className="text-xs text-gray-500">ตรวจสอบรูปให้ถูกต้อง แล้วกดเพิ่มรูป</p>
          <div className="grid grid-cols-3 gap-2 max-h-[45vh] overflow-y-auto">
            {(pendingImageSelection?.drafts || []).map((img) => (
              <img key={img.id} src={img.previewUrl} alt="" className="w-full aspect-square object-cover rounded border" />
            ))}
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t">
            <button onClick={closePendingImageSelection} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">
              ยกเลิก
            </button>
            <button onClick={confirmPendingImageSelection} className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm hover:bg-emerald-700">
              เพิ่มรูป
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={!!zoomGallery} onClose={closeZoomGallery} closeOnBackdropClick contentClassName="max-w-3xl">
        <div className="p-3 relative">
          <button
            type="button"
            onClick={closeZoomGallery}
            className="absolute top-2 right-2 z-10 w-8 h-8 rounded-full bg-black/60 text-white text-lg leading-none"
            aria-label="ปิดรูปขยาย"
          >
            ×
          </button>
          {zoomGallery && zoomGallery.images.length > 1 && (
            <>
              <button
                type="button"
                onClick={() => moveZoomGallery(-1)}
                className="absolute left-2 top-1/2 -translate-y-1/2 z-10 w-9 h-9 rounded-full bg-black/60 text-white text-lg leading-none"
                aria-label="รูปก่อนหน้า"
              >
                ‹
              </button>
              <button
                type="button"
                onClick={() => moveZoomGallery(1)}
                className="absolute right-2 top-1/2 -translate-y-1/2 z-10 w-9 h-9 rounded-full bg-black/60 text-white text-lg leading-none"
                aria-label="รูปถัดไป"
              >
                ›
              </button>
              <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-10 px-2.5 py-1 rounded-full bg-black/60 text-white text-xs">
                {zoomGallery.index + 1}/{zoomGallery.images.length}
              </div>
            </>
          )}
          {activeZoomImageUrl && (
            <img src={activeZoomImageUrl} alt="" className="w-full max-h-[75vh] object-contain rounded" />
          )}
        </div>
      </Modal>
      <Modal open={etaEditOpen} onClose={() => setEtaEditOpen(false)} closeOnBackdropClick={false} contentClassName="max-w-md">
        <div className="p-6 space-y-4">
          <h2 className="text-lg font-bold text-gray-900">แก้ไขกำหนดรับเข้า</h2>
          {etaEditPO && (
            <div className="bg-orange-50 rounded-lg p-3 text-sm text-orange-800">
              PO: <span className="font-semibold">{etaEditPO.po_no}</span>
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">วันที่กำหนดเข้า</label>
            <input
              type="date"
              value={etaEditDate}
              onChange={(e) => setEtaEditDate(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm"
            />
          </div>
          <div className="flex justify-end gap-3 pt-2 border-t">
            <button onClick={() => setEtaEditOpen(false)} className="px-4 py-2 border rounded-lg hover:bg-gray-50 text-sm">
              ยกเลิก
            </button>
            <button
              onClick={saveEtaEdit}
              disabled={etaSaving}
              className="px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50 text-sm font-semibold"
            >
              {etaSaving ? 'กำลังบันทึก...' : 'บันทึก'}
            </button>
          </div>
        </div>
      </Modal>
      {MessageModal}
      {ConfirmModal}
    </div>
  )
}
