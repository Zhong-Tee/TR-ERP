/**
 * อ่านบาร์โค้ดจากใบปะหน้าใน PDF — ใช้ ZXing ที่ติดมากับ html5-qrcode (ไม่ต้องเพิ่ม dependency)
 *
 * ใบปะหน้าขนส่ง (SPX/Flash) ฝังบาร์โค้ดเป็น image object แยกชิ้นในไฟล์ PDF
 * จึง decode ได้ตรงจากภาพนั้นโดยไม่ต้อง render ทั้งหน้า ซึ่งเร็วกว่า OCR หลักร้อยเท่า
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** ภาพที่ pdf.js decode ออกมาแล้ว — kind ตาม pdfjs ImageKind (1=GRAY_1BPP, 2=RGB_24BPP, 3=RGBA_32BPP) */
type PdfImage = { width: number; height: number; data: Uint8Array | Uint8ClampedArray; kind?: number }

let zxingPromise: Promise<any> | null = null
function loadZXing(): Promise<any> {
  if (!zxingPromise) {
    zxingPromise = import('html5-qrcode/third_party/zxing-js.umd.js').then((m: any) => m?.default ?? m)
  }
  return zxingPromise
}

/** RGB/RGBA/1bpp → luminance ตามสูตรถ่วงน้ำหนักสีเขียว (เหมือนที่ ZXing ใช้) */
function toLuminance(img: PdfImage): Uint8ClampedArray | null {
  const { width, height, data, kind } = img
  const size = width * height
  if (!size || !data) return null
  const out = new Uint8ClampedArray(size)
  if (kind === 3 || data.length >= size * 4) {
    for (let i = 0; i < size; i++) out[i] = (data[i * 4] * 306 + data[i * 4 + 1] * 601 + data[i * 4 + 2] * 117) >> 10
  } else if (kind === 2 || data.length >= size * 3) {
    for (let i = 0; i < size; i++) out[i] = (data[i * 3] * 306 + data[i * 3 + 1] * 601 + data[i * 3 + 2] * 117) >> 10
  } else if (data.length >= size) {
    for (let i = 0; i < size; i++) out[i] = data[i]
  } else if (data.length >= Math.ceil(size / 8)) {
    // 1 bit ต่อพิกเซล — bit 1 = ขาว
    for (let i = 0; i < size; i++) out[i] = (data[i >> 3] >> (7 - (i & 7))) & 1 ? 255 : 0
  } else {
    return null
  }
  return out
}

export type WaybillBarcodeReader = {
  /** decode จากภาพที่ pdf.js ให้มา (เร็วสุด — ไม่ต้อง render หน้า) */
  fromPdfImage(img: PdfImage): string | null
  /** decode จาก canvas ที่ render หน้าแล้ว (ใช้เมื่อ PDF ไม่ได้แยกบาร์โค้ดเป็น image object) */
  fromCanvas(canvas: HTMLCanvasElement): string | null
}

/**
 * สร้างตัวอ่านบาร์โค้ด — รองรับหลายรูปแบบเผื่อผู้ให้บริการขนส่งเปลี่ยนรูปแบบใบปะหน้าในอนาคต
 * (Code128 ที่ SPX ใช้อยู่, Code39/ITF/Codabar ที่ขนส่งเจ้าอื่นใช้, และ QR/DataMatrix/PDF417 แบบ 2 มิติ)
 */
export async function createWaybillBarcodeReader(): Promise<WaybillBarcodeReader> {
  const ZX = await loadZXing()
  const hints = new Map<any, any>()
  hints.set(ZX.DecodeHintType.POSSIBLE_FORMATS, [
    ZX.BarcodeFormat.CODE_128,
    ZX.BarcodeFormat.CODE_39,
    ZX.BarcodeFormat.ITF,
    ZX.BarcodeFormat.CODABAR,
    ZX.BarcodeFormat.EAN_13,
    ZX.BarcodeFormat.QR_CODE,
    ZX.BarcodeFormat.DATA_MATRIX,
    ZX.BarcodeFormat.PDF_417,
  ])
  hints.set(ZX.DecodeHintType.TRY_HARDER, true)
  const reader = new ZX.MultiFormatReader()
  reader.setHints(hints)

  const decodeLuma = (luma: Uint8ClampedArray, width: number, height: number): string | null => {
    try {
      const bitmap = new ZX.BinaryBitmap(new ZX.HybridBinarizer(new ZX.RGBLuminanceSource(luma, width, height)))
      const text = reader.decode(bitmap)?.getText?.()
      return text ? String(text) : null
    } catch {
      return null
    } finally {
      reader.reset()
    }
  }

  return {
    fromPdfImage(img) {
      const luma = toLuminance(img)
      return luma ? decodeLuma(luma, img.width, img.height) : null
    },
    fromCanvas(canvas) {
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx || !canvas.width || !canvas.height) return null
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const luma = toLuminance({ width: canvas.width, height: canvas.height, data, kind: 3 })
      return luma ? decodeLuma(luma, canvas.width, canvas.height) : null
    },
  }
}

/**
 * อ่านบาร์โค้ดจาก image object ที่ฝังอยู่ในหน้า PDF
 * คัดเฉพาะภาพที่รูปทรงเหมือนบาร์โค้ด (แนวยาว) และ 2 มิติ (จตุรัส) เพื่อไม่ต้อง decode ภาพทั้ง 70+ ชิ้นต่อหน้า
 * คืนค่าข้อความทั้งหมดที่อ่านได้ — ปกติจะได้ 1 ค่าคือเลขพัสดุ
 */
export async function readBarcodesFromPdfPage(page: any, OPS: any, reader: WaybillBarcodeReader): Promise<string[]> {
  const ops = await page.getOperatorList()
  const names: string[] = []
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i]
    if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject) {
      const name = ops.argsArray[i]?.[0]
      if (typeof name === 'string' && !names.includes(name)) names.push(name)
    }
  }
  const linear: PdfImage[] = []
  const square: PdfImage[] = []
  for (const name of names) {
    // objs.has() สำคัญ — objs.get() แบบ callback จะค้างถ้าภาพยังไม่ถูก resolve
    if (!page.objs.has(name)) continue
    const img = page.objs.get(name) as PdfImage | null
    if (!img?.data || !img.width || !img.height) continue
    const ratio = img.width / img.height
    if (img.width >= 120 && ratio >= 1.5) linear.push(img)
    else if (img.width >= 120 && ratio >= 0.7 && ratio <= 1.4) square.push(img)
  }
  // บาร์โค้ดแนวยาวมาก่อน แล้วค่อยลอง QR/DataMatrix
  linear.sort((a, b) => b.width / b.height - a.width / a.height)
  square.sort((a, b) => b.width - a.width)

  const found: string[] = []
  for (const img of [...linear, ...square]) {
    const text = reader.fromPdfImage(img)
    if (text && !found.includes(text)) found.push(text)
    if (found.length) break
  }
  return found
}
