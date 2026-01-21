import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { Product } from '../types'

export default function Products() {
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')

  useEffect(() => {
    loadProducts()
  }, [searchTerm])

  async function loadProducts() {
    setLoading(true)
    try {
      let query = supabase
        .from('pr_products')
        .select('*')
        .eq('is_active', true)
        .order('product_code', { ascending: true })

      if (searchTerm) {
        query = query.or(
          `product_code.ilike.%${searchTerm}%,product_name.ilike.%${searchTerm}%`
        )
      }

      const { data, error } = await query

      if (error) throw error
      setProducts(data || [])
    } catch (error: any) {
      console.error('Error loading products:', error)
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
        <h1 className="text-3xl font-bold">จัดการสินค้า</h1>
        <button className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600">
          + เพิ่มสินค้า
        </button>
      </div>

      <div className="bg-white p-6 rounded-lg shadow">
        <input
          type="text"
          placeholder="ค้นหารหัสสินค้าหรือชื่อสินค้า..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="w-full px-4 py-2 border rounded-lg mb-4"
        />

        {products.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            ไม่พบข้อมูลสินค้า
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-100">
                <tr>
                  <th className="p-3 text-left">รูป</th>
                  <th className="p-3 text-left">รหัสสินค้า</th>
                  <th className="p-3 text-left">ชื่อสินค้า</th>
                  <th className="p-3 text-left">หมวดหมู่</th>
                  <th className="p-3 text-left">การจัดการ</th>
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <tr key={product.id} className="border-t">
                    <td className="p-3">
                      {product.image_url ? (
                        <img
                          src={product.image_url}
                          alt={product.product_name}
                          className="w-16 h-16 object-cover rounded"
                        />
                      ) : (
                        <div className="w-16 h-16 bg-gray-200 rounded"></div>
                      )}
                    </td>
                    <td className="p-3 font-medium">{product.product_code}</td>
                    <td className="p-3">{product.product_name}</td>
                    <td className="p-3">{product.product_category || '-'}</td>
                    <td className="p-3">
                      <div className="flex gap-2">
                        <button className="px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 text-sm">
                          แก้ไข
                        </button>
                        <button className="px-3 py-1 bg-red-500 text-white rounded hover:bg-red-600 text-sm">
                          ลบ
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
