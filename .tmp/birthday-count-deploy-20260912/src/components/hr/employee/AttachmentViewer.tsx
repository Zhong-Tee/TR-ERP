import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { FiExternalLink, FiFile, FiFileText, FiImage, FiChevronLeft, FiChevronRight, FiAlertCircle } from 'react-icons/fi'
import ModalCloseButton from '../../ui/ModalCloseButton'
import { getHRSignedUrl } from '../../../lib/hrApi'

/** ไฟล์แนบ 1 รายการ — path คือ path ใน bucket หรือ URL เต็ม */
export type Attachment = {
  bucket: string
  path: string
  /** ชื่อที่โชว์ให้ผู้ใช้ (ไม่ใส่ = ใช้ชื่อไฟล์จาก path) */
  name?: string
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif)(\?|$)/i
const PDF_EXT = /\.pdf(\?|$)/i

export const isImageFile = (path: string) => IMAGE_EXT.test(path)
export const isPdfFile = (path: string) => PDF_EXT.test(path)

/** ชื่อไฟล์ท้าย path — ตัด prefix timestamp ที่ระบบใส่ตอนอัปโหลดออก */
export function fileNameOf(att: Attachment): string {
  if (att.name) return att.name
  const base = decodeURIComponent(att.path.split('/').pop() ?? att.path)
  return base.replace(/^\d{10,}[-_]/, '').replace(/^[0-9a-f-]{36}_\d+_/i, '')
}

/**
 * ขอ signed URL ของไฟล์แนบ (bucket ฝั่ง HR เป็น private เกือบทั้งหมด)
 * คืน url = null ระหว่างโหลด, error = true เมื่อขอไม่สำเร็จ
 */
export function useAttachmentUrl(att: Attachment | null) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const bucket = att?.bucket
  const path = att?.path

  useEffect(() => {
    if (!bucket || !path) {
      setUrl(null)
      setError(false)
      return
    }
    let cancelled = false
    setUrl(null)
    setError(false)
    getHRSignedUrl(bucket, path)
      .then((u) => { if (!cancelled) setUrl(u) })
      .catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [bucket, path])

  return { url, error }
}

const Spinner = () => (
  <div className="animate-spin rounded-full h-8 w-8 border-2 border-white/70 border-t-transparent" />
)

/** รูปย่อของไฟล์แนบ — รูปภาพโชว์ thumbnail จริง, ไฟล์อื่นโชว์ไอคอน */
export function AttachmentThumb({ att, onClick, className = '' }: {
  att: Attachment
  onClick?: () => void
  className?: string
}) {
  const isImage = isImageFile(att.path)
  const { url, error } = useAttachmentUrl(isImage ? att : null)

  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative shrink-0 h-20 w-20 overflow-hidden rounded-lg border border-gray-200 bg-gray-50 active:opacity-70 ${className}`}
      aria-label={`เปิด ${fileNameOf(att)}`}
    >
      {isImage && url && !error ? (
        <img src={url} alt={fileNameOf(att)} className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full flex-col items-center justify-center gap-1 text-gray-400">
          {isImage ? <FiImage className="h-6 w-6" /> : isPdfFile(att.path) ? <FiFileText className="h-6 w-6 text-red-400" /> : <FiFile className="h-6 w-6" />}
          <span className="px-1 text-[9px] leading-tight line-clamp-2 text-gray-500">{fileNameOf(att)}</span>
        </span>
      )}
    </button>
  )
}

/**
 * ตัวเปิดไฟล์แนบเต็มจอสำหรับมือถือ
 * — รูปภาพแสดงในหน้าเลย (แตะเพื่อซูม)
 * — PDF/ไฟล์อื่นใช้ <a> จริงเปิดแท็บใหม่ เพราะ window.open() หลัง await โดน popup blocker บนมือถือ
 */
export default function AttachmentViewer({ items, startIndex = 0, onClose }: {
  items: Attachment[]
  startIndex?: number
  onClose: () => void
}) {
  const [index, setIndex] = useState(startIndex)
  const [zoomed, setZoomed] = useState(false)
  const att = items[index] ?? null
  const { url, error } = useAttachmentUrl(att)
  const isImage = att ? isImageFile(att.path) : false

  // เปลี่ยนไฟล์แล้วรีเซ็ตซูม
  useEffect(() => { setZoomed(false) }, [index])

  if (!att) return null

  // render ที่ body — กัน margin/overflow/stacking context ของหน้าที่เรียกใช้มากวนตำแหน่ง
  return createPortal(
    <div className="fixed inset-0 z-[110] flex flex-col bg-black" role="dialog" aria-modal="true">
      <div className="relative flex items-center gap-2 px-3 py-3 pr-16 text-white">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{fileNameOf(att)}</span>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 rounded-lg bg-white/15 px-3 py-2 text-xs font-medium active:bg-white/30"
          >
            <FiExternalLink className="h-4 w-4" />
            เปิด/ดาวน์โหลด
          </a>
        )}
        <ModalCloseButton onClick={onClose} className="absolute right-3 top-1/2 -translate-y-1/2" />
      </div>

      <div className={`flex-1 ${zoomed ? 'overflow-auto' : 'flex items-center justify-center overflow-hidden'} px-2 pb-2`}>
        {error ? (
          <div className="flex flex-col items-center gap-3 px-8 text-center text-white/80">
            <FiAlertCircle className="h-10 w-10 text-amber-400" />
            <p className="text-sm">เปิดไฟล์ไม่สำเร็จ — ไฟล์อาจถูกลบไปแล้ว หรือคุณไม่มีสิทธิ์เข้าถึง</p>
          </div>
        ) : !url ? (
          <Spinner />
        ) : isImage ? (
          <img
            src={url}
            alt={fileNameOf(att)}
            onClick={() => setZoomed((z) => !z)}
            className={zoomed ? 'w-[200%] max-w-none' : 'max-h-full max-w-full object-contain'}
          />
        ) : isPdfFile(att.path) ? (
          // iframe เปิด PDF ได้บน Android/Chrome ส่วน iOS จะว่าง — จึงมีปุ่มเปิดแท็บใหม่กำกับเสมอ
          <div className="flex h-full w-full flex-col gap-3">
            <iframe src={url} title={fileNameOf(att)} className="min-h-0 flex-1 rounded-lg bg-white" />
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3 font-medium text-white active:bg-emerald-700"
            >
              <FiExternalLink className="h-5 w-5" />
              เปิดไฟล์ในแท็บใหม่
            </a>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 px-8 text-center text-white/80">
            <FiFile className="h-12 w-12" />
            <p className="text-sm">ไฟล์ประเภทนี้แสดงในหน้าจอไม่ได้</p>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded-xl bg-emerald-600 px-6 py-3 font-medium text-white active:bg-emerald-700"
            >
              <FiExternalLink className="h-5 w-5" />
              เปิด/ดาวน์โหลดไฟล์
            </a>
          </div>
        )}
      </div>

      {items.length > 1 && (
        <div className="flex items-center justify-between px-4 pb-6 pt-2 text-white">
          <button
            type="button"
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            disabled={index === 0}
            className="rounded-lg bg-white/15 p-3 disabled:opacity-30"
            aria-label="ไฟล์ก่อนหน้า"
          >
            <FiChevronLeft className="h-5 w-5" />
          </button>
          <span className="text-sm">{index + 1} / {items.length}</span>
          <button
            type="button"
            onClick={() => setIndex((i) => Math.min(items.length - 1, i + 1))}
            disabled={index === items.length - 1}
            className="rounded-lg bg-white/15 p-3 disabled:opacity-30"
            aria-label="ไฟล์ถัดไป"
          >
            <FiChevronRight className="h-5 w-5" />
          </button>
        </div>
      )}
    </div>,
    document.body,
  )
}

/** แถวไฟล์แนบพร้อมตัวเปิดเต็มจอในตัว — ใช้ที่หน้าไหนก็ได้ */
export function AttachmentStrip({ items, label }: { items: Attachment[]; label?: string }) {
  const [openAt, setOpenAt] = useState<number | null>(null)
  if (items.length === 0) return null
  return (
    <div className="space-y-1.5">
      {label && <p className="text-xs font-medium text-gray-500">{label}</p>}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {items.map((att, i) => (
          <AttachmentThumb key={`${att.bucket}/${att.path}`} att={att} onClick={() => setOpenAt(i)} />
        ))}
      </div>
      {openAt !== null && (
        <AttachmentViewer items={items} startIndex={openAt} onClose={() => setOpenAt(null)} />
      )}
    </div>
  )
}
