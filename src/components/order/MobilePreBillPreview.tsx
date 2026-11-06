import { useEffect, useRef, useState } from 'react'
import type { PreBillDocument, PreBillItem } from '../../types/prebill'
import Modal from '../ui/Modal'
import PreBillPreview from './PreBillPreview'

export default function MobilePreBillPreview({ document, items, onClose }: {
  document: Partial<PreBillDocument>
  items: PreBillItem[]
  onClose: () => void
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.4)
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const resize = () => setScale(Math.min(1, element.clientWidth / 794))
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return <Modal open onClose={onClose} stackClassName="z-[200]" contentClassName="max-w-3xl" ariaLabelledby="mobile-prebill-preview-title">
    <h3 id="mobile-prebill-preview-title" className="px-4 py-4 pr-14 text-sm font-bold">ตัวอย่างเอกสาร</h3>
    <div ref={viewport} className="w-full overflow-hidden bg-white">
      <div style={{ width: 794, zoom: scale }}>
        <PreBillPreview document={document} items={items} />
      </div>
    </div>
  </Modal>
}
