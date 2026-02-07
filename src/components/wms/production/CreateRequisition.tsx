import { useState, useEffect } from 'react'
import { useAuthContext } from '../../../contexts/AuthContext'
import { supabase } from '../../../lib/supabase'
import BarcodeScanner from './BarcodeScanner'
import { getProductImageUrl } from '../wmsUtils'
import { useWmsModal } from '../useWmsModal'

export default function CreateRequisition() {
  const { user } = useAuthContext()
  const [searchTerm, setSearchTerm] = useState('')
  const [products, setProducts] = useState<any[]>([])
  const [allProducts, setAllProducts] = useState<any[]>([])
  const [selectedItems, setSelectedItems] = useState<any[]>([])
  const [requisitionId, setRequisitionId] = useState('')
  const [notes, setNotes] = useState('')
  const [selectedTopic, setSelectedTopic] = useState('')
  const [requisitionTopics, setRequisitionTopics] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingAllProducts, setLoadingAllProducts] = useState(false)
  const [loadingTopics, setLoadingTopics] = useState(false)
  const [showScanner, setShowScanner] = useState(false)
  const [selectedProductCode, setSelectedProductCode] = useState('')
  const { showMessage, showConfirm, MessageModal, ConfirmModal } = useWmsModal()

  useEffect(() => {
    generateRequisitionId()
    loadAllProducts()
    loadRequisitionTopics()
  }, [])

  const generateRequisitionId = async () => {
    const date = new Date()
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const dateStr = `${year}${month}${day}`

    const { count } = await supabase
      .from('wms_requisitions')
      .select('*', { count: 'exact', head: true })
      .like('requisition_id', `REQ-${dateStr}-%`)

    const nextNumber = (count || 0) + 1
    const sequence = nextNumber.toString().padStart(3, '0')
    setRequisitionId(`REQ-${dateStr}-${sequence}`)
  }

  const loadRequisitionTopics = async () => {
    setLoadingTopics(true)
    try {
      const { data, error } = await supabase.from('wms_requisition_topics').select('*').order('topic_name', { ascending: true })
      if (error) throw error
      setRequisitionTopics(data || [])
    } catch (error: any) {
      showMessage({ message: `โหลดหัวข้อไม่สำเร็จ: ${error.message}` })
    } finally {
      setLoadingTopics(false)
    }
  }

  const loadAllProducts = async () => {
    setLoadingAllProducts(true)
    try {
      const { data, error } = await supabase
        .from('pr_products')
        .select('product_code, product_name, storage_location')
        .eq('is_active', true)
        .order('product_name', { ascending: true })

      if (error) throw error
      setAllProducts(data || [])
    } catch (error: any) {
      showMessage({ message: `เกิดข้อผิดพลาดในการโหลดรายการสินค้า: ${error.message}` })
    } finally {
      setLoadingAllProducts(false)
    }
  }

  const searchProducts = async () => {
    if (!searchTerm.trim()) {
      setProducts([])
      return
    }

    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('pr_products')
        .select('product_code, product_name, storage_location')
        .eq('is_active', true)
        .or(`product_code.ilike.%${searchTerm}%,product_name.ilike.%${searchTerm}%`)
        .limit(20)

      if (error) throw error
      setProducts(data || [])
    } catch (error: any) {
      showMessage({ message: `เกิดข้อผิดพลาดในการค้นหา: ${error.message}` })
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      searchProducts()
    }
  }

  const handleBarcodeScan = (barcode: string) => {
    setShowScanner(false)
    setSearchTerm(barcode)
    setTimeout(() => {
      searchProducts()
    }, 100)
  }

  const handleSelectProduct = (productCode: string) => {
    if (!productCode) return
    const product = allProducts.find((p) => p.product_code === productCode)
    if (product) {
      addItem(product)
      setSelectedProductCode('')
    }
  }

  const addItem = (product: any) => {
    const existing = selectedItems.find((item) => item.product_code === product.product_code)
    if (existing) {
      setSelectedItems(
        selectedItems.map((item) => (item.product_code === product.product_code ? { ...item, qty: item.qty + 1 } : item))
      )
    } else {
      setSelectedItems([...selectedItems, { ...product, qty: 1 }])
    }
  }

  const removeItem = (productCode: string) => {
    setSelectedItems(selectedItems.filter((item) => item.product_code !== productCode))
  }

  const updateQty = (productCode: string, newQty: number) => {
    if (newQty < 1) {
      removeItem(productCode)
      return
    }
    setSelectedItems(
      selectedItems.map((item) => (item.product_code === productCode ? { ...item, qty: newQty } : item))
    )
  }

  const submitRequisition = async () => {
    if (selectedItems.length === 0) {
      showMessage({ message: 'กรุณาเพิ่มรายการสินค้า' })
      return
    }

    if (!selectedTopic || !selectedTopic.trim()) {
      showMessage({ message: 'กรุณาเลือกหัวข้อการเบิก' })
      return
    }

    if (!notes || !notes.trim()) {
      showMessage({ message: 'กรุณากรอกหมายเหตุ' })
      return
    }

    const ok = await showConfirm({
      title: 'ยืนยันการสร้างใบเบิก',
      message: `ยืนยันการสร้างใบเบิก ${requisitionId}?\nจำนวนรายการ: ${selectedItems.length}`,
    })
    if (!ok) return

    try {
      const { data: reqData, error: reqError } = await supabase
        .from('wms_requisitions')
        .insert([
          {
            requisition_id: requisitionId,
            created_by: user?.id,
            status: 'pending',
            notes: notes.trim(),
            requisition_topic: selectedTopic || null,
          },
        ])
        .select()
        .single()

      if (reqError) throw reqError

      const items = selectedItems.map((item) => ({
        requisition_id: requisitionId,
        product_code: item.product_code,
        product_name: item.product_name,
        location: item.storage_location || item.location || null,
        qty: item.qty,
      }))

      const { error: itemsError } = await supabase.from('wms_requisition_items').insert(items)
      if (itemsError) throw itemsError

      showMessage({ message: `✅ สร้างใบเบิก ${requisitionId} สำเร็จ!\nรอการอนุมัติจากผู้จัดการ` })

      setSelectedItems([])
      setNotes('')
      setSelectedTopic('')
      setSearchTerm('')
      setProducts([])
      setSelectedProductCode('')
      generateRequisitionId()
    } catch (error: any) {
      showMessage({ message: `เกิดข้อผิดพลาด: ${error.message}` })
    }
  }

  const imgUrl = (productCode: string) => {
    if (productCode === 'SPARE_PART') {
      return 'https://placehold.co/100x100?text=SPARE'
    }
    return getProductImageUrl(productCode)
  }

  return (
    <div className="p-4 space-y-4 pb-24">
      <div className="bg-slate-800 p-4 rounded-2xl">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xl font-black text-white">สร้างใบเบิกสินค้า</h2>
          <span className="text-sm font-bold text-blue-400 bg-blue-900/30 px-3 py-1 rounded-lg">{requisitionId}</span>
        </div>
        <div className="text-xs text-gray-400">รหัสใบเบิกจะถูกสร้างอัตโนมัติ</div>
      </div>

      <div className="bg-slate-800 p-4 rounded-2xl">
        <label className="block text-sm font-bold text-gray-300 mb-2">เลือกรายการสินค้า</label>
        <select
          value={selectedProductCode}
          onChange={(e) => handleSelectProduct(e.target.value)}
          disabled={loadingAllProducts}
          className="w-full bg-slate-700 text-white px-4 py-3 rounded-xl border border-slate-600 focus:border-blue-500 focus:outline-none"
        >
          <option value="">{loadingAllProducts ? 'กำลังโหลด...' : '-- เลือกรายการสินค้า --'}</option>
          {allProducts.map((product, idx) => (
            <option key={idx} value={product.product_code}>
              {product.product_name}
            </option>
          ))}
        </select>
      </div>

      <div className="bg-slate-800 p-4 rounded-2xl">
        <label className="block text-sm font-bold text-gray-300 mb-2">ค้นหาสินค้า</label>
        <div className="flex gap-2 flex-wrap">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="รหัสสินค้า หรือ ชื่อสินค้า"
            className="flex-1 min-w-0 bg-slate-700 text-white px-3 py-2.5 rounded-xl border border-slate-600 focus:border-blue-500 focus:outline-none text-sm"
          />
          <button
            onClick={searchProducts}
            disabled={loading}
            className="bg-blue-600 text-white px-4 py-2.5 rounded-xl font-bold hover:bg-blue-700 disabled:opacity-50 text-sm whitespace-nowrap shrink-0"
          >
            {loading ? '...' : 'ค้นหา'}
          </button>
          <button
            onClick={() => setShowScanner(true)}
            className="bg-purple-600 text-white px-4 py-2.5 rounded-xl font-bold hover:bg-purple-700 shrink-0 flex items-center gap-2"
            title="สแกนบาร์โค้ด"
          >
            <i className="fas fa-qrcode"></i>
            <span className="text-sm">สแกน</span>
          </button>
        </div>
        <div className="text-xs text-gray-400 mt-2">ค้นหาได้ทั้งชื่อสินค้าและรหัสสินค้า หรือใช้ปุ่มสแกนบาร์โค้ด</div>
      </div>

      {products.length > 0 && (
        <div className="bg-slate-800 p-4 rounded-2xl">
          <h3 className="text-sm font-bold text-gray-300 mb-3">ผลการค้นหา ({products.length})</h3>
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {products.map((product, idx) => (
              <div key={idx} className="flex items-center gap-3 p-3 bg-slate-700 rounded-xl hover:bg-slate-600 transition">
                <img
                  src={imgUrl(product.product_code)}
                  className="w-16 h-16 object-cover rounded-lg"
                  onError={(e) => {
                    const target = e.target as HTMLImageElement
                    target.src = 'https://placehold.co/100x100?text=NO+IMG'
                  }}
                  alt={product.product_name}
                />
                <div className="flex-1">
                  <div className="font-bold text-white text-sm">{product.product_name}</div>
                  <div className="text-xs text-gray-400">รหัส: {product.product_code}</div>
                  <div className="text-xs text-red-400">จุดเก็บ: {product.storage_location || '---'}</div>
                </div>
                <button
                  onClick={() => addItem(product)}
                  className="bg-green-600 text-white px-4 py-2 rounded-lg font-bold text-sm hover:bg-green-700"
                >
                  <i className="fas fa-plus mr-1"></i>
                  เพิ่ม
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {selectedItems.length > 0 && (
        <div className="bg-slate-800 p-4 rounded-2xl">
          <h3 className="text-sm font-bold text-gray-300 mb-3">รายการที่เลือก ({selectedItems.length})</h3>
          <div className="space-y-3">
            {selectedItems.map((item, idx) => (
              <div key={idx} className="flex flex-col gap-3 p-3 bg-slate-700 rounded-xl">
                <div className="flex items-center gap-3">
                  <img
                    src={imgUrl(item.product_code)}
                    className="w-16 h-16 object-cover rounded-lg shrink-0"
                    onError={(e) => {
                      const target = e.target as HTMLImageElement
                      target.src = 'https://placehold.co/100x100?text=NO+IMG'
                    }}
                    alt={item.product_name}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-white text-sm break-words">{item.product_name}</div>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-600">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => updateQty(item.product_code, item.qty - 1)}
                      className="bg-red-600 text-white w-10 h-10 rounded-lg font-bold text-lg hover:bg-red-700 active:scale-95 transition-all"
                    >
                      -
                    </button>
                    <span className="text-white font-bold text-lg w-12 text-center">{item.qty}</span>
                    <button
                      onClick={() => updateQty(item.product_code, item.qty + 1)}
                      className="bg-green-600 text-white w-10 h-10 rounded-lg font-bold text-lg hover:bg-green-700 active:scale-95 transition-all"
                    >
                      +
                    </button>
                  </div>
                  <button
                    onClick={() => removeItem(item.product_code)}
                    className="bg-red-600 text-white px-4 py-2 rounded-lg font-bold hover:bg-red-700 active:scale-95 transition-all"
                  >
                    <i className="fas fa-trash mr-1"></i>
                    ลบ
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-slate-800 p-4 rounded-2xl">
        <label className="block text-sm font-bold text-gray-300 mb-2">
          หัวข้อการเบิก <span className="text-red-400">*</span>
        </label>
        <select
          value={selectedTopic}
          onChange={(e) => setSelectedTopic(e.target.value)}
          disabled={loadingTopics}
          required
          className="w-full bg-slate-700 text-white px-4 py-3 rounded-xl border border-slate-600 focus:border-blue-500 focus:outline-none"
        >
          <option value="">{loadingTopics ? 'กำลังโหลด...' : '-- เลือกหัวข้อการเบิก --'}</option>
          {requisitionTopics.map((topic, idx) => (
            <option key={idx} value={topic.topic_name}>
              {topic.topic_name}
            </option>
          ))}
        </select>
      </div>

      <div className="bg-slate-800 p-4 rounded-2xl">
        <label className="block text-sm font-bold text-gray-300 mb-2">
          หมายเหตุ <span className="text-red-400">*</span>
        </label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="กรุณากรอกหมายเหตุ..."
          required
          className="w-full bg-slate-700 text-white px-4 py-3 rounded-xl border border-slate-600 focus:border-blue-500 focus:outline-none resize-none text-base"
          rows={3}
        />
      </div>

      {selectedItems.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 p-4 bg-slate-900 border-t border-slate-700 z-10">
          <button
            onClick={submitRequisition}
            className="w-full bg-green-600 text-white py-4 rounded-2xl font-black text-lg shadow-lg hover:bg-green-700 active:scale-95 transition-all"
          >
            <i className="fas fa-check-circle mr-2"></i>
            สร้างใบเบิก ({selectedItems.length} รายการ)
          </button>
        </div>
      )}

      {showScanner && <BarcodeScanner onScan={handleBarcodeScan} onClose={() => setShowScanner(false)} />}
      {MessageModal}
      {ConfirmModal}
    </div>
  )
}
