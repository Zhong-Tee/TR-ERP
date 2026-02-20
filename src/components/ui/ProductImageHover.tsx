import { useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { getProductImageUrl } from '../wms/wmsUtils'

interface ProductImageHoverProps {
  productCode: string
  productName?: string
  size?: 'sm' | 'md'
  onClickLightbox?: (url: string) => void
}

export default function ProductImageHover({
  productCode,
  productName,
  size = 'sm',
  onClickLightbox,
}: ProductImageHoverProps) {
  const [failed, setFailed] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [previewPos, setPreviewPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const [lightbox, setLightbox] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const imgRef = useRef<HTMLImageElement>(null)

  const url = productCode ? getProductImageUrl(productCode) : ''
  const displayUrl = url && !failed ? url : ''

  const sizeClasses = size === 'sm' ? 'w-14 h-14' : 'w-20 h-20'

  const PREVIEW_SIZE = 240

  const calcPosition = useCallback(() => {
    if (!imgRef.current) return
    const rect = imgRef.current.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight

    let left = rect.right + 8
    let top = rect.top + rect.height / 2 - PREVIEW_SIZE / 2

    if (left + PREVIEW_SIZE > vw - 8) {
      left = rect.left - PREVIEW_SIZE - 8
    }
    if (top < 8) top = 8
    if (top + PREVIEW_SIZE > vh - 8) top = vh - PREVIEW_SIZE - 8

    setPreviewPos({ top, left })
  }, [])

  const handleMouseEnter = () => {
    timeoutRef.current = setTimeout(() => {
      calcPosition()
      setShowPreview(true)
    }, 200)
  }

  const handleMouseLeave = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    setShowPreview(false)
  }

  const handleClick = () => {
    if (!displayUrl) return
    if (onClickLightbox) {
      onClickLightbox(displayUrl)
    } else {
      setLightbox(true)
    }
  }

  if (!displayUrl) {
    return (
      <div className={`${sizeClasses} bg-gray-200 rounded-lg flex items-center justify-center text-gray-400 text-xs leading-tight text-center`}>
        ไม่มีรูป
      </div>
    )
  }

  return (
    <>
      <div className="inline-block" onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
        <img
          ref={imgRef}
          src={displayUrl}
          alt={productName || productCode}
          className={`${sizeClasses} object-cover rounded-lg cursor-pointer border border-gray-200 hover:ring-2 hover:ring-blue-400 transition`}
          onError={() => setFailed(true)}
          onClick={handleClick}
        />
      </div>

      {showPreview && createPortal(
        <div
          className="pointer-events-none"
          style={{
            position: 'fixed',
            zIndex: 9990,
            top: previewPos.top,
            left: previewPos.left,
            width: PREVIEW_SIZE,
            height: PREVIEW_SIZE,
          }}
        >
          <div className="w-full h-full rounded-lg shadow-2xl border-2 border-white bg-white overflow-hidden">
            <img
              src={displayUrl}
              alt={productName || productCode}
              className="w-full h-full object-cover"
            />
          </div>
        </div>,
        document.body
      )}

      {lightbox && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black bg-opacity-80 p-4"
          onClick={() => setLightbox(false)}
        >
          <div className="relative max-w-[90vw] max-h-[85vh]">
            <button
              type="button"
              onClick={() => setLightbox(false)}
              className="absolute -top-3 -right-3 z-10 w-10 h-10 rounded-full bg-white border border-gray-300 text-gray-600 flex items-center justify-center text-sm font-bold hover:bg-red-500 hover:text-white hover:border-red-500 transition-colors shadow-lg"
            >
              <i className="fas fa-times"></i>
            </button>
            <img
              src={displayUrl}
              alt={productName || productCode}
              className="max-w-full max-h-[85vh] rounded-xl object-contain shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
