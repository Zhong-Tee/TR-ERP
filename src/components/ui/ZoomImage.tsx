import { useRef, useState } from 'react'

interface ZoomImageProps {
  src: string
  size?: string
}

export default function ZoomImage({ src, size = 'w-16 h-16' }: ZoomImageProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  const handleEnter = () => {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    setPos({ top: rect.top, left: rect.right + 8 })
  }
  const handleLeave = () => setPos(null)

  return (
    <div ref={ref} className={`${size} flex-shrink-0 cursor-pointer`} onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      <div className={`${size} rounded-lg bg-gray-200 overflow-hidden`}>
        <img src={src} alt="" className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
      </div>
      {pos && (
        <img
          src={src}
          alt=""
          className="fixed w-48 h-48 object-cover rounded-xl shadow-2xl border-2 border-white pointer-events-none"
          style={{ top: pos.top, left: pos.left, zIndex: 9999 }}
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
      )}
    </div>
  )
}
