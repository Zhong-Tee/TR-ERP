import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { FiX } from 'react-icons/fi'

/** แสดงรูปขนาดใหญ่เต็มจอ — ปิดได้ด้วยปุ่ม X มุมขวาบน, คลิกพื้นหลัง หรือกด Esc */
export default function PhotoLightbox({ url, alt, onClose }: { url: string; alt?: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div className="fixed inset-0 z-[1200] bg-black/80 flex items-center justify-center p-6" role="dialog" aria-modal="true" aria-label={alt || 'ดูรูปขนาดใหญ่'} onClick={onClose}>
      <button type="button" onClick={onClose} aria-label="ปิด" className="absolute top-4 right-4 p-2 rounded-full bg-white/15 text-white hover:bg-white/30 transition-colors">
        <FiX className="w-7 h-7" />
      </button>
      <img src={url} alt={alt ?? ''} onClick={(e) => e.stopPropagation()} className="max-w-full max-h-full rounded-2xl object-contain shadow-2xl" />
    </div>,
    document.body,
  )
}
