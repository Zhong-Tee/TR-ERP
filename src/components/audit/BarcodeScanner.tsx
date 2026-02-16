import { useEffect, useRef, useState } from 'react'
import { Html5Qrcode } from 'html5-qrcode'

interface BarcodeScannerProps {
  onScan: (code: string) => void
  onClose: () => void
}

export default function BarcodeScanner({ onScan, onClose }: BarcodeScannerProps) {
  const scannerRef = useRef<HTMLDivElement>(null)
  const html5QrCodeRef = useRef<Html5Qrcode | null>(null)
  const isProcessingRef = useRef(false)
  const [isScanning, setIsScanning] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    return () => {
      if (html5QrCodeRef.current) {
        try { html5QrCodeRef.current.stop().catch(() => {}) } catch {}
        try { html5QrCodeRef.current.clear() } catch {}
      }
    }
  }, [])

  const startScanning = async () => {
    try {
      setError('')
      setIsScanning(true)

      const elementId = 'audit-barcode-scanner'
      const element = document.getElementById(elementId)
      if (!element) throw new Error('ไม่พบ element สำหรับสแกน')

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('เบราว์เซอร์ไม่รองรับกล้อง กรุณาใช้ HTTPS')
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        })
        stream.getTracks().forEach((track) => track.stop())
      } catch (permErr: any) {
        if (permErr.name === 'NotAllowedError') throw new Error('กรุณาอนุญาตให้ใช้กล้อง')
        if (permErr.name === 'NotFoundError') throw new Error('ไม่พบกล้องในอุปกรณ์')
        throw new Error('ไม่สามารถเข้าถึงกล้องได้: ' + permErr.message)
      }

      const html5QrCode = new Html5Qrcode(elementId)
      html5QrCodeRef.current = html5QrCode

      await html5QrCode.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          qrbox: (viewfinderWidth: number, viewfinderHeight: number) => {
            const minEdge = Math.min(viewfinderWidth, viewfinderHeight)
            const size = Math.floor(minEdge * 0.7)
            return { width: size, height: size }
          },
          aspectRatio: 1.0,
        },
        (decodedText: string) => {
          if (isProcessingRef.current) return
          isProcessingRef.current = true
          onScan(decodedText)
          setTimeout(async () => {
            try {
              if (html5QrCodeRef.current) {
                try { await html5QrCodeRef.current.stop() } catch {}
                try { html5QrCodeRef.current.clear() } catch {}
              }
              setIsScanning(false)
            } finally {
              isProcessingRef.current = false
            }
          }, 100)
        },
        () => {}
      )
    } catch (err: any) {
      setError(err.message || 'ไม่สามารถเปิดกล้องได้')
      setIsScanning(false)
      if (html5QrCodeRef.current) {
        try { html5QrCodeRef.current.clear() } catch {}
      }
    }
  }

  const stopScanning = async () => {
    if (html5QrCodeRef.current) {
      try { await html5QrCodeRef.current.stop() } catch {}
      try { html5QrCodeRef.current.clear() } catch {}
    }
    setIsScanning(false)
  }

  const handleClose = async () => {
    await stopScanning()
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 rounded-2xl max-w-md w-full overflow-hidden flex flex-col">
        <div className="p-4 border-b border-gray-700 flex justify-between items-center">
          <h2 className="text-lg font-bold text-white">สแกนบาร์โค้ดสินค้า</h2>
          <button
            onClick={handleClose}
            className="text-red-400 hover:text-red-300 text-2xl font-bold w-10 h-10 flex items-center justify-center rounded-full hover:bg-red-900/30 transition-all"
          >
            &times;
          </button>
        </div>

        <div className="p-4 flex-1 flex flex-col items-center overflow-hidden">
          <div
            id="audit-barcode-scanner"
            ref={scannerRef}
            className="w-full max-w-sm rounded-xl overflow-hidden bg-black"
            style={{ minHeight: '250px', maxHeight: '400px' }}
          />

          {error && <div className="mt-4 text-red-400 text-sm text-center">{error}</div>}
          {!isScanning && !error && (
            <div className="mt-4 text-gray-400 text-sm text-center">กดปุ่มเริ่มสแกนเพื่อเปิดกล้อง</div>
          )}

          <div className="mt-4 flex gap-3 w-full">
            {!isScanning ? (
              <button
                onClick={startScanning}
                className="flex-1 bg-green-600 text-white py-3.5 rounded-xl font-bold text-lg hover:bg-green-700 active:scale-95 transition-all"
              >
                เริ่มสแกน
              </button>
            ) : (
              <button
                onClick={stopScanning}
                className="flex-1 bg-red-600 text-white py-3.5 rounded-xl font-bold text-lg hover:bg-red-700 active:scale-95 transition-all"
              >
                หยุดสแกน
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
