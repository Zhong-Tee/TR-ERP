import { useRef, useState } from 'react'
import { FiUpload } from 'react-icons/fi'
import { HR_WARNING_CERT_BUCKET, uploadHRFile } from '../../lib/hrApi'

type Props = {
  employeeId?: string
  category: 'warnings' | 'certificates'
  paths: string[]
  onChange: (paths: string[]) => void
  onError: (message: string) => void
}

export default function HRDocumentAttachments({ employeeId, category, paths, onChange, onError }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  const upload = async (files: FileList | null) => {
    if (!files?.length) return
    if (!employeeId) {
      onError('กรุณาเลือกพนักงานก่อนแนบไฟล์')
      return
    }
    setUploading(true)
    try {
      const uploaded: string[] = []
      for (const file of Array.from(files)) {
        const safeName = file.name.replace(/[^a-zA-Z0-9._ก-๙-]/g, '_')
        const path = `${employeeId}/${category}/${crypto.randomUUID()}_${safeName}`
        uploaded.push(await uploadHRFile(HR_WARNING_CERT_BUCKET, path, file))
      }
      onChange([...paths, ...uploaded])
    } catch (error) {
      onError(error instanceof Error ? error.message : 'อัปโหลดไฟล์ไม่สำเร็จ')
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">รูปภาพ / ไฟล์แนบ</label>
      <input ref={inputRef} type="file" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx" className="hidden" onChange={(event) => upload(event.target.files)} />
      <button type="button" onClick={() => inputRef.current?.click()} disabled={uploading} className="flex items-center gap-2 rounded-xl border-2 border-dashed border-emerald-300 px-4 py-2.5 text-sm text-emerald-700 hover:bg-emerald-50 disabled:opacity-60">
        <FiUpload className="w-4 h-4" />{uploading ? 'กำลังอัปโหลด...' : 'แนบรูปหรือไฟล์'}
      </button>
      {paths.length > 0 && (
        <ul className="mt-2 space-y-1">
          {paths.map((path) => (
            <li key={path} className="flex items-center justify-between gap-2 rounded-lg bg-gray-50 px-3 py-2 text-xs">
              <span className="truncate">{path.split('/').pop()?.replace(/^[0-9a-f-]+_/, '') || path}</span>
              <button type="button" onClick={() => onChange(paths.filter((item) => item !== path))} className="shrink-0 text-red-500 hover:text-red-700">ลบ</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
