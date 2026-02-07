import { useEffect, useRef, useState } from 'react'
import { Html5Qrcode } from 'html5-qrcode'
import Modal from '../../ui/Modal'

interface BarcodeScannerProps {
  onScan: (value: string) => void
  onClose: () => void
}

export default function BarcodeScanner({ onScan, onClose }: BarcodeScannerProps) {
  const scannerRef = useRef<HTMLDivElement | null>(null)
  const [isScanning, setIsScanning] = useState(false)
  const [error, setError] = useState('')
  const html5QrCodeRef = useRef<Html5Qrcode | null>(null)
  const isProcessingRef = useRef(false)

  useEffect(() => {
    return () => {
      if (html5QrCodeRef.current) {
        try {
          html5QrCodeRef.current.stop().catch(() => {})
        } catch {}
        try {
          html5QrCodeRef.current.clear()
        } catch {}
      }
    }
  }, [])

  const startScanning = async () => {
    try {
      setError('')
      setIsScanning(true)

      const elementId = 'barcode-scanner'
      const element = document.getElementById(elementId)
      if (!element) {
        throw new Error('ไม่พบ element สำหรับสแกน')
      }

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('เบราว์เซอร์ของคุณไม่รองรับการใช้งานกล้อง กรุณาใช้ HTTPS หรือ localhost')
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        stream.getTracks().forEach((track) => track.stop())
      } catch (permissionError: any) {
        if (permissionError.name === 'NotAllowedError') {
          throw new Error('กรุณาอนุญาตให้ใช้กล้องในเบราว์เซอร์')
        } else if (permissionError.name === 'NotFoundError') {
          throw new Error('ไม่พบกล้องในอุปกรณ์')
        } else {
          throw new Error('ไม่สามารถเข้าถึงกล้องได้: ' + permissionError.message)
        }
      }

      const html5QrCode = new Html5Qrcode(elementId)
      html5QrCodeRef.current = html5QrCode

      await html5QrCode.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          qrbox: function (viewfinderWidth, viewfinderHeight) {
            const minEdgePercentage = 0.7
            const minEdgeSize = Math.min(viewfinderWidth, viewfinderHeight)
            const qrboxSize = Math.floor(minEdgeSize * minEdgePercentage)
            return { width: qrboxSize, height: qrboxSize }
          },
          aspectRatio: 1.0,
        },
        (decodedText) => {
          if (isProcessingRef.current) return
          isProcessingRef.current = true

          onScan(decodedText)

          setTimeout(async () => {
            try {
              if (html5QrCodeRef.current) {
                try {
                  await html5QrCodeRef.current.stop()
                } catch {}
                try {
                  html5QrCodeRef.current.clear()
                } catch {}
              }
              setIsScanning(false)
            } catch (err) {
              console.error('Error in cleanup:', err)
              setIsScanning(false)
            } finally {
              isProcessingRef.current = false
            }
          }, 100)
        },
        () => {}
      )
    } catch (err: any) {
      console.error('Error starting scanner:', err)
      let errorMsg = 'ไม่สามารถเปิดกล้องได้'

      if (err.message) {
        errorMsg = err.message
      } else if (err.name === 'NotAllowedError') {
        errorMsg = 'กรุณาอนุญาตให้ใช้กล้องในเบราว์เซอร์'
      } else if (err.name === 'NotFoundError') {
        errorMsg = 'ไม่พบกล้องในอุปกรณ์'
      } else if (err.name === 'NotReadableError') {
        errorMsg = 'กล้องถูกใช้งานโดยแอปอื่นอยู่'
      }

      setError(errorMsg)
      setIsScanning(false)
      if (html5QrCodeRef.current) {
        html5QrCodeRef.current.clear().catch(() => {})
      }
    }
  }

  const stopScanning = async () => {
    if (html5QrCodeRef.current) {
      try {
        try {
          await html5QrCodeRef.current.stop()
        } catch {}
        try {
          html5QrCodeRef.current.clear()
        } catch {}
        setIsScanning(false)
      } catch (err) {
        console.error('Error stopping scanner:', err)
        setIsScanning(false)
      }
    }
  }

  const handleClose = async () => {
    await stopScanning()
    onClose()
  }

  return (
    <Modal open={true} onClose={handleClose} closeOnBackdropClick={false} contentClassName="max-w-md">
      <div className="bg-slate-800 rounded-2xl w-full overflow-hidden flex flex-col">
        <div className="p-4 border-b border-slate-700 flex justify-between items-center">
          <h2 className="text-xl font-black text-white">สแกนบาร์โค้ด</h2>
          <button
            onClick={handleClose}
            className="text-red-600 hover:text-red-800 text-3xl font-bold w-10 h-10 flex items-center justify-center rounded-full hover:bg-red-100 transition-all"
          >
            <i className="fas fa-times"></i>
          </button>
        </div>

        <div className="p-4 flex-1 flex flex-col items-center overflow-hidden">
          <div id="barcode-scanner" ref={scannerRef} className="w-full max-w-sm rounded-xl overflow-hidden bg-black" style={{ minHeight: '250px', maxHeight: '400px' }} />

          {error && <div className="mt-4 text-red-400 text-sm text-center">{error}</div>}

          {!isScanning && !error && <div className="mt-4 text-gray-400 text-sm text-center">กดปุ่มเริ่มสแกนเพื่อเปิดกล้อง</div>}

        <div className="mt-4 flex gap-3 w-full">
          {!isScanning ? (
            <button onClick={startScanning} className="flex-1 bg-green-600 text-white py-3 rounded-xl font-bold hover:bg-green-700">
              <i className="fas fa-camera mr-2"></i>
              เริ่มสแกน
            </button>
          ) : (
            <button onClick={stopScanning} className="flex-1 bg-red-600 text-white py-3 rounded-xl font-bold hover:bg-red-700">
              <i className="fas fa-stop mr-2"></i>
              หยุดสแกน
            </button>
          )}
          <button
            onClick={handleClose}
            className="flex-1 bg-slate-600 text-white py-3 rounded-xl font-bold hover:bg-slate-700"
          >
            ปิด
          </button>
        </div>
        </div>
      </div>
    </Modal>
  )
}
