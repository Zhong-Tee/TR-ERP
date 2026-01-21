import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { CartoonPattern } from '../types'

export default function CartoonPatterns() {
  const [patterns, setPatterns] = useState<CartoonPattern[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadPatterns()
  }, [])

  async function loadPatterns() {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('cp_cartoon_patterns')
        .select('*')
        .eq('is_active', true)
        .order('pattern_name', { ascending: true })

      if (error) throw error
      setPatterns(data || [])
    } catch (error: any) {
      console.error('Error loading patterns:', error)
      alert('เกิดข้อผิดพลาดในการโหลดข้อมูล: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">จัดการลายการ์ตูน</h1>
        <button className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600">
          + เพิ่มลายการ์ตูน
        </button>
      </div>

      <div className="bg-white p-6 rounded-lg shadow">
        {patterns.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            ไม่พบข้อมูลลายการ์ตูน
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {patterns.map((pattern) => (
              <div
                key={pattern.id}
                className="border rounded-lg p-4 hover:shadow-md transition"
              >
                {pattern.image_url ? (
                  <img
                    src={pattern.image_url}
                    alt={pattern.pattern_name}
                    className="w-full h-32 object-cover rounded mb-2"
                  />
                ) : (
                  <div className="w-full h-32 bg-gray-200 rounded mb-2"></div>
                )}
                <p className="font-medium">{pattern.pattern_name}</p>
                <p className="text-sm text-gray-600">{pattern.pattern_code}</p>
                <div className="flex gap-2 mt-2">
                  <button className="flex-1 px-2 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 text-sm">
                    แก้ไข
                  </button>
                  <button className="flex-1 px-2 py-1 bg-red-500 text-white rounded hover:bg-red-600 text-sm">
                    ลบ
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
