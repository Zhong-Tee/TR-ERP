import { useState } from 'react'
import { useAuthContext } from '../contexts/AuthContext'

export default function QC() {
  const { user } = useAuthContext()
  const [file, setFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files || !e.target.files[0]) return
    setFile(e.target.files[0])
  }

  async function processQC() {
    if (!file || !user) return
    setLoading(true)
    // QC processing logic would go here
    // This is a placeholder for the full QC system
    alert('QC System - Coming Soon (Full implementation from QC_TR_V.4.9.html)')
    setLoading(false)
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">QC System</h1>
      <div className="bg-white p-6 rounded-lg shadow">
        <h2 className="text-xl font-bold mb-4">อัปโหลดไฟล์ QC</h2>
        <input
          type="file"
          accept=".csv,.xlsx,.xls"
          onChange={handleFileUpload}
          className="mb-4"
        />
        {file && (
          <div className="mb-4">
            <p>ไฟล์ที่เลือก: {file.name}</p>
            <button
              onClick={processQC}
              disabled={loading}
              className="mt-2 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
            >
              {loading ? 'กำลังประมวลผล...' : 'เริ่ม QC'}
            </button>
          </div>
        )}
        <p className="text-gray-600 text-sm">
          Note: Full QC system implementation from QC_TR_V.4.9.html will be added
        </p>
      </div>
    </div>
  )
}
