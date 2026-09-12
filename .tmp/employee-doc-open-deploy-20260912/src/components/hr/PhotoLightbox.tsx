import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import ModalCloseButton from '../ui/ModalCloseButton'

/** แสดงรูปขนาดใหญ่เต็มจอ — ปิดได้ด้วยปุ่ม X มุมขวาบน, คลิกพื้นหลัง หรือกด Esc */
export default function PhotoLightbox({ url, alt, onClose }: { url: string; alt?: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div className="fixed inset-0 z-[1200] bg-black/80 flex items-center justify-center p-6" role="dialog" aria-modal="true" aria-label={alt || 'ดูรูปขนาดใหญ่'} onClick={onClose}>
      <ModalCloseButton onClick={onClose} className="absolute right-4 top-4" />
      <img src={url} alt={alt ?? ''} onClick={(e) => e.stopPropagation()} className="max-w-full max-h-full rounded-2xl object-contain shadow-2xl" />
    </div>,
    document.body,
  )
}
