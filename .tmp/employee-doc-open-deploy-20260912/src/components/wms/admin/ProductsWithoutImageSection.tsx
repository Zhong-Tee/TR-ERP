import { useState, useEffect } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../../../lib/supabase'
import { getProductImageUrl } from '../wmsUtils'

async function checkImageExists(productCode: string) {
  const url = getProductImageUrl(productCode)
  if (!url) return false
  try {
    const res = await fetch(url, { method: 'HEAD' })
    return res.ok
  } catch {
    return false
  }
}

export default function ProductsWithoutImageSection() {
  const [items, setItems] = useState<{ product_code: string; product_name: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [progressPercent, setProgressPercent] = useState(0)

  const loadProductsWithoutImage = async () => {
    setLoading(true)
    setProgressPercent(0)
    try {
      const { data: productsData } = await supabase
        .from('pr_products')
        .select('product_code, product_name')
        .eq('is_active', true)

      const { data: reqItemsData } = await supabase
        .from('wms_requisition_items')
        .select('product_code, product_name')

      const codeToName = new Map<string, string>()
      if (productsData) {
        productsData.forEach((p: any) => {
          codeToName.set(p.product_code, p.product_name)
        })
      }
      if (reqItemsData) {
        reqItemsData.forEach((r: any) => {
          if (!codeToName.has(r.product_code)) {
            codeToName.set(r.product_code, r.product_name)
          }
        })
      }

      const allCodes = [
        ...new Set([...(productsData || []).map((p: any) => p.product_code), ...(reqItemsData || []).map((r: any) => r.product_code)]),
      ]
      const total = allCodes.length

      const withoutImage: { product_code: string; product_name: string }[] = []
      for (let i = 0; i < allCodes.length; i++) {
        const code = allCodes[i]
        const hasImage = await checkImageExists(code)
        if (!hasImage) {
          withoutImage.push({
            product_code: code,
            product_name: codeToName.get(code) || '(ไม่มีชื่อ)',
          })
        }
        setProgressPercent(total ? Math.round(((i + 1) / total) * 100) : 100)
      }

      setItems(withoutImage)
    } catch (err) {
      console.error('Error loading products without image:', err)
      setItems([])
    } finally {
      setLoading(false)
      setProgressPercent(100)
    }
  }

  const downloadExcel = () => {
    if (items.length === 0) return
    const exportData = items.map((row) => ({
      รหัสสินค้า: row.product_code,
      ชื่อสินค้า: row.product_name,
    }))
    const ws = XLSX.utils.json_to_sheet(exportData)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'รหัสที่ไม่มีรูป')
    const fileName = `รหัสที่ไม่มีรูป_${new Date().toISOString().split('T')[0]}.xlsx`
    XLSX.writeFile(wb, fileName)
  }

  useEffect(() => {
    loadProductsWithoutImage()
  }, [])

  return (
    <section className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-3xl font-black text-slate-800">รหัสที่ไม่มีรูป</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={downloadExcel}
            disabled={loading || items.length === 0}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-green-600 text-white text-sm font-bold hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <i className="fas fa-file-excel"></i>
            ดาวน์โหลด Excel
          </button>
          <button
            onClick={loadProductsWithoutImage}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800 text-white text-sm font-bold hover:bg-slate-700 disabled:opacity-50"
          >
            <i className={`fas ${loading ? 'fa-spinner fa-spin' : 'fa-sync-alt'}`}></i>
            โหลดใหม่
          </button>
        </div>
      </div>
      <p className="text-gray-500 text-sm mb-4">รายการรหัสสินค้าที่ไม่มีรูป</p>
      <div className="bg-white rounded-2xl border shadow-sm flex-1 min-h-0 overflow-hidden flex flex-col">
        {loading ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-6 px-8">
            <div className="flex items-center gap-3 text-gray-600">
              <i className="fas fa-spinner fa-spin text-3xl"></i>
              <span className="text-lg font-medium">กำลังตรวจสอบรูปภาพ...</span>
            </div>
            <div className="w-full max-w-md">
              <div className="flex justify-between text-sm text-gray-500 mb-1">
                <span>ความคืบหน้า</span>
                <span className="font-bold text-slate-700">{progressPercent}%</span>
              </div>
              <div className="h-3 bg-gray-200 rounded-full overflow-hidden">
                <div className="h-full bg-blue-600 transition-all duration-300 ease-out" style={{ width: `${progressPercent}%` }} />
              </div>
            </div>
          </div>
        ) : items.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-green-600 font-medium">
            <i className="fas fa-check-circle text-2xl mr-2"></i>
            ทุกรหัสมีรูปภาพครบ
          </div>
        ) : (
          <div className="overflow-y-auto flex-1">
            <table className="w-full text-left">
              <thead className="bg-slate-100 sticky top-0">
                <tr>
                  <th className="p-4 font-bold text-slate-700 border-b">รหัสสินค้า</th>
                  <th className="p-4 font-bold text-slate-700 border-b">ชื่อสินค้า</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row, idx) => (
                  <tr key={`${row.product_code}-${idx}`} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="p-4 font-mono font-semibold text-slate-800">{row.product_code}</td>
                    <td className="p-4 text-slate-700">{row.product_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}
