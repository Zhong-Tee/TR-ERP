import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { Order, OrderItem, Product, CartoonPattern } from '../../types'
import { useAuthContext } from '../../contexts/AuthContext'
import SlipUpload from './SlipUpload'

interface OrderFormProps {
  order?: Order | null
  onSave: () => void
  onCancel: () => void
}

export default function OrderForm({ order, onSave, onCancel }: OrderFormProps) {
  const { user } = useAuthContext()
  const [loading, setLoading] = useState(false)
  const [products, setProducts] = useState<Product[]>([])
  const [cartoonPatterns, setCartoonPatterns] = useState<CartoonPattern[]>([])
  const [channels, setChannels] = useState<{ channel_code: string; channel_name: string }[]>([])
  const [inkTypes, setInkTypes] = useState<{ id: number; ink_name: string }[]>([])
  const [fonts, setFonts] = useState<{ font_code: string; font_name: string }[]>([])
  const [items, setItems] = useState<Partial<OrderItem>[]>([])
  const [showTaxInvoice, setShowTaxInvoice] = useState(false)
  const [showCashBill, setShowCashBill] = useState(false)
  const [productSearchTerm, setProductSearchTerm] = useState<{ [key: number]: string }>({})
  
  const [formData, setFormData] = useState({
    channel_code: '',
    customer_name: '',
    customer_address: '',
    price: 0,
    shipping_cost: 0,
    discount: 0,
    total_amount: 0,
    payment_method: 'โอน',
    promotion: '',
    payment_date: '',
    payment_time: '',
  })

  const [taxInvoiceData, setTaxInvoiceData] = useState({
    company_name: '',
    address: '',
    tax_id: '',
    items_note: '',
  })

  const [cashBillData, setCashBillData] = useState({
    company_name: '',
    address: '',
    items_note: '',
  })

  useEffect(() => {
    loadInitialData()
    if (order) {
      setFormData({
        channel_code: order.channel_code,
        customer_name: order.customer_name,
        customer_address: order.customer_address,
        price: order.price,
        shipping_cost: order.shipping_cost,
        discount: order.discount,
        total_amount: order.total_amount,
        payment_method: order.payment_method || 'โอน',
        promotion: order.promotion || '',
        payment_date: order.payment_date || '',
        payment_time: order.payment_time || '',
      })
      if (order.order_items && order.order_items.length > 0) {
        const loadedItems = order.order_items.map(item => ({ ...item }))
        setItems(loadedItems)
        // ตั้งค่า productSearchTerm สำหรับแต่ละรายการ
        const searchTerms: { [key: number]: string } = {}
        loadedItems.forEach((item, idx) => {
          if (item.product_name) {
            searchTerms[idx] = item.product_name
          }
        })
        setProductSearchTerm(searchTerms)
      } else {
        // เพิ่มรายการแรกอัตโนมัติ
        setItems([{ product_type: 'ชั้น1' }])
      }
    } else {
      // เพิ่มรายการแรกอัตโนมัติสำหรับออเดอร์ใหม่
      setItems([{ product_type: 'ชั้น1' }])
    }
  }, [order])

  async function loadInitialData() {
    try {
      const [productsRes, patternsRes, channelsRes, inkTypesRes, fontsRes] = await Promise.all([
        supabase.from('pr_products').select('*').eq('is_active', true),
        supabase.from('cp_cartoon_patterns').select('*').eq('is_active', true),
        supabase.from('channels').select('channel_code, channel_name'),
        supabase.from('ink_types').select('id, ink_name').order('ink_name'),
        supabase.from('fonts').select('font_code, font_name').eq('is_active', true),
      ])

      if (productsRes.data) setProducts(productsRes.data)
      if (patternsRes.data) setCartoonPatterns(patternsRes.data)
      if (channelsRes.data) setChannels(channelsRes.data)
      if (inkTypesRes.data) setInkTypes(inkTypesRes.data)
      if (fontsRes.data) setFonts(fontsRes.data)
    } catch (error) {
      console.error('Error loading data:', error)
    }
  }

  // คำนวณราคารวมจากรายการสินค้า
  function calculateItemsTotal() {
    const total = items.reduce((sum, item) => {
      const quantity = item.quantity || 1
      const unitPrice = item.unit_price || 0
      return sum + (quantity * unitPrice)
    }, 0)
    return total
  }

  // คำนวณยอดสุทธิ
  function calculateTotal() {
    const itemsTotal = calculateItemsTotal()
    const subtotal = itemsTotal + formData.shipping_cost - formData.discount
    setFormData(prev => ({ ...prev, price: itemsTotal, total_amount: subtotal }))
  }

  useEffect(() => {
    calculateTotal()
  }, [items, formData.shipping_cost, formData.discount])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!user) return

    setLoading(true)
    try {
      // คำนวณราคารวมจากรายการสินค้า
      const calculatedPrice = calculateItemsTotal()
      const calculatedTotal = calculatedPrice + formData.shipping_cost - formData.discount
      
      const orderData = {
        ...formData,
        price: calculatedPrice,
        total_amount: calculatedTotal,
        status: 'รอลงข้อมูล' as const,
        admin_user: user.username || user.email,
        entry_date: new Date().toISOString().slice(0, 10),
      }

      let orderId: string
      if (order) {
        const { error } = await supabase
          .from('or_orders')
          .update(orderData)
          .eq('id', order.id)
        if (error) throw error
        orderId = order.id
      } else {
        // Generate bill number
        const billNo = await generateBillNo(formData.channel_code)
        const { data, error } = await supabase
          .from('or_orders')
          .insert({ ...orderData, bill_no: billNo })
          .select()
          .single()
        if (error) throw error
        orderId = data.id
      }

      // Save order items
      if (items.length > 0) {
        await supabase.from('or_order_items').delete().eq('order_id', orderId)
        const itemsToInsert = items
          .filter(item => item.product_id)
          .map(item => ({
            order_id: orderId,
            item_uid: `${formData.channel_code}-${Date.now()}-${Math.random().toString(36).substring(7)}`,
            product_id: item.product_id!,
            product_name: item.product_name || '',
            quantity: item.quantity || 1,
            unit_price: item.unit_price || 0,
            ink_color: item.ink_color || null,
            product_type: item.product_type || 'ชั้น1',
            cartoon_pattern: item.cartoon_pattern || null,
            line_pattern: item.line_pattern || null,
            font: item.font || null,
            line_1: item.line_1 || null,
            line_2: item.line_2 || null,
            line_3: item.line_3 || null,
            notes: item.notes || null,
            file_attachment: item.file_attachment || null,
          }))
        
        if (itemsToInsert.length > 0) {
          const { error: itemsError } = await supabase
            .from('or_order_items')
            .insert(itemsToInsert)
          if (itemsError) throw itemsError
        }
      }

      alert(order ? 'อัปเดตข้อมูลสำเร็จ' : 'บันทึกสำเร็จ!')
      onSave()
    } catch (error: any) {
      console.error('Error saving order:', error)
      alert('เกิดข้อผิดพลาด: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  async function generateBillNo(channelCode: string): Promise<string> {
    const today = new Date()
    const year = today.getFullYear().toString().slice(-2)
    const month = (today.getMonth() + 1).toString().padStart(2, '0')
    
    const { data } = await supabase
      .from('or_orders')
      .select('bill_no')
      .like('bill_no', `${channelCode}${year}${month}%`)
      .order('bill_no', { ascending: false })
      .limit(1)

    let sequence = 1
    if (data && data.length > 0) {
      const lastBillNo = data[0].bill_no
      const lastSeq = parseInt(lastBillNo.slice(-4)) || 0
      sequence = lastSeq + 1
    }

    return `${channelCode}${year}${month}${sequence.toString().padStart(4, '0')}`
  }

  function addItem() {
    setItems([...items, { product_type: 'ชั้น1' }])
  }

  function removeItem(index: number) {
    setItems(items.filter((_, i) => i !== index))
  }

  function updateItem(index: number, field: keyof OrderItem, value: any) {
    const newItems = [...items]
    newItems[index] = { ...newItems[index], [field]: value }
    setItems(newItems)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="bg-white p-6 rounded-lg shadow">
        <h3 className="text-xl font-bold mb-4">ข้อมูลหลัก</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">ช่องทาง</label>
            <select
              value={formData.channel_code}
              onChange={(e) => setFormData({ ...formData, channel_code: e.target.value })}
              required
              className="w-full px-3 py-2 border rounded-lg"
            >
              <option value="">-- เลือกช่องทาง --</option>
              {channels.map((ch) => (
                <option key={ch.channel_code} value={ch.channel_code}>
                  {ch.channel_name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">ชื่อลูกค้า</label>
            <input
              type="text"
              value={formData.customer_name}
              onChange={(e) => setFormData({ ...formData, customer_name: e.target.value })}
              required
              className="w-full px-3 py-2 border rounded-lg"
            />
          </div>
        </div>
        <div className="mt-4">
          <label className="block text-sm font-medium mb-1">ที่อยู่ลูกค้า</label>
          <textarea
            value={formData.customer_address}
            onChange={(e) => setFormData({ ...formData, customer_address: e.target.value })}
            required
            rows={4}
            className="w-full px-3 py-2 border rounded-lg"
          />
        </div>
      </div>

      <div className="bg-white p-6 rounded-lg shadow">
        <h3 className="text-xl font-bold mb-4">รายการสินค้า</h3>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-gray-100">
                <th className="border p-2">ชื่อสินค้า</th>
                <th className="border p-2">สีหมึก</th>
                <th className="border p-2">ชั้นที่</th>
                <th className="border p-2">ลายการ์ตูน</th>
                <th className="border p-2">ลายเส้น</th>
                <th className="border p-2">ฟอนต์</th>
                <th className="border p-2">บรรทัด 1</th>
                <th className="border p-2">บรรทัด 2</th>
                <th className="border p-2">บรรทัด 3</th>
                <th className="border p-2">จำนวน</th>
                <th className="border p-2">ราคา/หน่วย</th>
                <th className="border p-2">หมายเหตุ</th>
                <th className="border p-2">ไฟล์แนบ</th>
                <th className="border p-2"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => (
                <tr key={index}>
                  <td className="border p-2">
                    <div className="relative">
                      <input
                        type="text"
                        list={`product-list-${index}`}
                        value={productSearchTerm[index] !== undefined ? productSearchTerm[index] : (item.product_name || '')}
                        onChange={(e) => {
                          const searchTerm = e.target.value
                          setProductSearchTerm({ ...productSearchTerm, [index]: searchTerm })
                        }}
                        onInput={(e) => {
                          const input = e.target as HTMLInputElement
                          const selectedOption = document.querySelector(
                            `#product-list-${index} option[value="${input.value}"]`
                          ) as HTMLOptionElement
                          if (selectedOption) {
                            const productId = selectedOption.getAttribute('data-id')
                            if (productId) {
                              const product = products.find(p => p.id === productId)
                              if (product) {
                                updateItem(index, 'product_id', product.id)
                                updateItem(index, 'product_name', product.product_name)
                                setProductSearchTerm({ ...productSearchTerm, [index]: product.product_name })
                              }
                            }
                          }
                        }}
                        onBlur={(e) => {
                          // ถ้าไม่ตรงกับสินค้าใดๆ ให้ใช้ชื่อสินค้าที่เลือกไว้
                          const matchedProduct = products.find(
                            p => p.product_name.toLowerCase() === e.target.value.toLowerCase()
                          )
                          if (!matchedProduct) {
                            setProductSearchTerm({ ...productSearchTerm, [index]: item.product_name || '' })
                          } else {
                            // อัพเดตให้ตรงกับสินค้าที่เลือก
                            updateItem(index, 'product_id', matchedProduct.id)
                            updateItem(index, 'product_name', matchedProduct.product_name)
                            setProductSearchTerm({ ...productSearchTerm, [index]: matchedProduct.product_name })
                          }
                        }}
                        placeholder="พิมพ์ค้นหาหรือเลือกสินค้า"
                        className="w-full px-2 py-1 border rounded min-w-[120px]"
                      />
                      <datalist id={`product-list-${index}`}>
                        {products
                          .filter(p => 
                            !productSearchTerm[index] || 
                            p.product_name.toLowerCase().includes(productSearchTerm[index].toLowerCase())
                          )
                          .map((p) => (
                            <option key={p.id} value={p.product_name} data-id={p.id} />
                          ))}
                      </datalist>
                    </div>
                  </td>
                  <td className="border p-2">
                    <select
                      value={item.ink_color || ''}
                      onChange={(e) => updateItem(index, 'ink_color', e.target.value)}
                      className="w-full px-2 py-1 border rounded min-w-[100px]"
                    >
                      <option value="">-- เลือกสี --</option>
                      {inkTypes.map((ink) => (
                        <option key={ink.id} value={ink.ink_name}>
                          {ink.ink_name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="border p-2">
                    <select
                      value={item.product_type || 'ชั้น1'}
                      onChange={(e) => updateItem(index, 'product_type', e.target.value)}
                      className="w-full px-2 py-1 border rounded min-w-[80px]"
                    >
                      <option value="ชั้น1">ชั้น1</option>
                      <option value="ชั้น2">ชั้น2</option>
                      <option value="ชั้น3">ชั้น3</option>
                      <option value="ชั้น4">ชั้น4</option>
                      <option value="ชั้น5">ชั้น5</option>
                    </select>
                  </td>
                  <td className="border p-2">
                    <input
                      type="text"
                      value={item.cartoon_pattern || ''}
                      onChange={(e) => updateItem(index, 'cartoon_pattern', e.target.value)}
                      className="w-full px-2 py-1 border rounded min-w-[100px]"
                      placeholder="ลายการ์ตูน"
                    />
                  </td>
                  <td className="border p-2">
                    <input
                      type="text"
                      value={item.line_pattern || ''}
                      onChange={(e) => updateItem(index, 'line_pattern', e.target.value)}
                      className="w-full px-2 py-1 border rounded min-w-[100px]"
                      placeholder="ลายเส้น"
                    />
                  </td>
                  <td className="border p-2">
                    <select
                      value={item.font || ''}
                      onChange={(e) => updateItem(index, 'font', e.target.value)}
                      className="w-full px-2 py-1 border rounded min-w-[120px]"
                    >
                      <option value="">-- เลือกฟอนต์ --</option>
                      {fonts.map((font) => (
                        <option key={font.font_code} value={font.font_name}>
                          {font.font_name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="border p-2">
                    <input
                      type="text"
                      value={item.line_1 || ''}
                      onChange={(e) => updateItem(index, 'line_1', e.target.value)}
                      className="w-full px-2 py-1 border rounded min-w-[100px]"
                    />
                  </td>
                  <td className="border p-2">
                    <input
                      type="text"
                      value={item.line_2 || ''}
                      onChange={(e) => updateItem(index, 'line_2', e.target.value)}
                      className="w-full px-2 py-1 border rounded min-w-[100px]"
                    />
                  </td>
                  <td className="border p-2">
                    <input
                      type="text"
                      value={item.line_3 || ''}
                      onChange={(e) => updateItem(index, 'line_3', e.target.value)}
                      className="w-full px-2 py-1 border rounded min-w-[100px]"
                    />
                  </td>
                  <td className="border p-2">
                    <input
                      type="number"
                      value={item.quantity || 1}
                      onChange={(e) => updateItem(index, 'quantity', parseInt(e.target.value) || 1)}
                      min="1"
                      className="w-full px-2 py-1 border rounded min-w-[60px]"
                    />
                  </td>
                  <td className="border p-2">
                    <input
                      type="number"
                      value={item.unit_price || ''}
                      onChange={(e) => updateItem(index, 'unit_price', parseFloat(e.target.value) || 0)}
                      onFocus={(e) => {
                        if (e.target.value === '0') {
                          e.target.value = ''
                        }
                      }}
                      onBlur={(e) => {
                        if (e.target.value === '') {
                          updateItem(index, 'unit_price', 0)
                        }
                      }}
                      step="0.01"
                      placeholder="0.00"
                      className="w-full px-2 py-1 border rounded min-w-[80px]"
                    />
                  </td>
                  <td className="border p-2">
                    <input
                      type="text"
                      value={item.notes || ''}
                      onChange={(e) => updateItem(index, 'notes', e.target.value)}
                      placeholder="หมายเหตุเพิ่มเติม"
                      className="w-full px-2 py-1 border rounded min-w-[120px]"
                    />
                  </td>
                  <td className="border p-2">
                    <input
                      type="text"
                      value={item.file_attachment || ''}
                      onChange={(e) => updateItem(index, 'file_attachment', e.target.value)}
                      placeholder="URL ไฟล์แนบ"
                      className="w-full px-2 py-1 border rounded min-w-[120px]"
                    />
                  </td>
                  <td className="border p-2">
                    <button
                      type="button"
                      onClick={() => removeItem(index)}
                      className="px-3 py-1 bg-red-500 text-white rounded hover:bg-red-600 text-xl"
                      title="ลบ"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          onClick={addItem}
          className="mt-4 px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600"
        >
          + เพิ่มแถว
        </button>
      </div>

      <div className="bg-white p-6 rounded-lg shadow">
        <h3 className="text-xl font-bold mb-4">ข้อมูลการชำระเงิน</h3>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium mb-1">ราคา</label>
            <input
              type="number"
              value={calculateItemsTotal()}
              readOnly
              step="0.01"
              className="w-full px-3 py-2 border rounded-lg bg-gray-100 font-semibold"
            />
            <p className="text-xs text-gray-500 mt-1">คำนวณจากรายการสินค้า</p>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">ค่าส่ง</label>
            <input
              type="number"
              value={formData.shipping_cost}
              onChange={(e) => setFormData({ ...formData, shipping_cost: parseFloat(e.target.value) || 0 })}
              step="0.01"
              className="w-full px-3 py-2 border rounded-lg"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">ส่วนลด</label>
            <input
              type="number"
              value={formData.discount}
              onChange={(e) => setFormData({ ...formData, discount: parseFloat(e.target.value) || 0 })}
              step="0.01"
              className="w-full px-3 py-2 border rounded-lg"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">ยอดสุทธิ</label>
            <input
              type="number"
              value={formData.total_amount}
              readOnly
              className="w-full px-3 py-2 border rounded-lg bg-gray-100 font-bold"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">วิธีการชำระ</label>
            <select
              value={formData.payment_method}
              onChange={(e) => setFormData({ ...formData, payment_method: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg"
            >
              <option value="โอน">โอน</option>
              <option value="COD">COD</option>
            </select>
          </div>
        </div>

        {formData.payment_method === 'โอน' && (
          <>
            <div className="border-t pt-4">
              <h4 className="font-semibold mb-3">อัพโหลดสลิปโอนเงิน</h4>
              {order && order.id ? (
                <SlipUpload
                  orderId={order.id}
                  orderAmount={formData.total_amount}
                  onVerificationComplete={(success, totalAmount) => {
                    if (success) {
                      alert('ตรวจสอบสลิปสำเร็จ! ออเดอร์จะถูกส่งไปให้ Admin QC ตรวจสอบ')
                    }
                  }}
                />
              ) : (
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                  <p className="text-yellow-800 text-sm mb-2">กรุณาบันทึกออเดอร์ก่อนเพื่ออัพโหลดสลิป</p>
                  <button
                    type="button"
                    onClick={handleSubmit}
                    className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
                  >
                    บันทึกออเดอร์เพื่ออัพโหลดสลิป
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <div className="bg-white p-6 rounded-lg shadow">
        <h3 className="text-xl font-bold mb-4">ขอเอกสาร</h3>
        <div className="flex gap-4 mb-4">
          <button
            type="button"
            onClick={() => {
              setShowTaxInvoice(!showTaxInvoice)
              setShowCashBill(false)
            }}
            className={`px-6 py-2 rounded-lg font-medium transition-colors ${
              showTaxInvoice
                ? 'bg-blue-600 text-white'
                : 'bg-blue-100 text-blue-600 hover:bg-blue-200'
            }`}
          >
            ขอใบกำกับภาษี
          </button>
          <button
            type="button"
            onClick={() => {
              setShowCashBill(!showCashBill)
              setShowTaxInvoice(false)
            }}
            className={`px-6 py-2 rounded-lg font-medium transition-colors ${
              showCashBill
                ? 'bg-green-600 text-white'
                : 'bg-green-100 text-green-600 hover:bg-green-200'
            }`}
          >
            ขอบิลเงินสด
          </button>
        </div>

        {showTaxInvoice && (
          <div className="border-2 border-blue-200 rounded-lg p-4 bg-blue-50">
            <h4 className="font-semibold text-blue-800 mb-3">ข้อมูลสำหรับใบกำกับภาษี / บิลเงินสด</h4>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium mb-1">ชื่อลูกค้า/บริษัท</label>
                <input
                  type="text"
                  value={taxInvoiceData.company_name}
                  onChange={(e) => setTaxInvoiceData({ ...taxInvoiceData, company_name: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">ที่อยู่</label>
                <textarea
                  value={taxInvoiceData.address}
                  onChange={(e) => setTaxInvoiceData({ ...taxInvoiceData, address: e.target.value })}
                  rows={3}
                  className="w-full px-3 py-2 border rounded-lg"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">เลขประจำตัวผู้เสียภาษี (TAX ID)</label>
                <input
                  type="text"
                  value={taxInvoiceData.tax_id}
                  onChange={(e) => setTaxInvoiceData({ ...taxInvoiceData, tax_id: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                  placeholder="เช่น 0-0000-00000-00-0"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">รายการสินค้าในใบกำกับ</label>
                <div className="border rounded-lg p-3 bg-gray-50 max-h-48 overflow-y-auto">
                  {items.filter(item => item.product_id).length > 0 ? (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left p-2">ชื่อสินค้า</th>
                          <th className="text-left p-2">จำนวน</th>
                          <th className="text-right p-2">ราคา/หน่วย</th>
                          <th className="text-right p-2">รวม</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items
                          .filter(item => item.product_id)
                          .map((item, idx) => {
                            const quantity = item.quantity || 1
                            const unitPrice = item.unit_price || 0
                            const total = quantity * unitPrice
                            return (
                              <tr key={idx} className="border-b">
                                <td className="p-2">{item.product_name || '-'}</td>
                                <td className="p-2">{quantity}</td>
                                <td className="p-2 text-right">{unitPrice.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
                                <td className="p-2 text-right font-semibold">{total.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
                              </tr>
                            )
                          })}
                      </tbody>
                      <tfoot>
                        <tr className="border-t font-bold">
                          <td colSpan={3} className="p-2 text-right">รวมทั้งสิ้น:</td>
                          <td className="p-2 text-right">
                            {items
                              .filter(item => item.product_id)
                              .reduce((sum, item) => {
                                const quantity = item.quantity || 1
                                const unitPrice = item.unit_price || 0
                                return sum + (quantity * unitPrice)
                              }, 0)
                              .toLocaleString('th-TH', { minimumFractionDigits: 2 })}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  ) : (
                    <p className="text-gray-500 text-sm">ยังไม่มีรายการสินค้า กรุณาเพิ่มรายการสินค้าก่อน</p>
                  )}
                </div>
                <textarea
                  value={taxInvoiceData.items_note}
                  onChange={(e) => setTaxInvoiceData({ ...taxInvoiceData, items_note: e.target.value })}
                  rows={2}
                  className="w-full px-3 py-2 border rounded-lg mt-2"
                  placeholder="หมายเหตุเพิ่มเติม (ถ้ามี)"
                />
              </div>
            </div>
          </div>
        )}

        {showCashBill && (
          <div className="border-2 border-green-200 rounded-lg p-4 bg-green-50">
            <h4 className="font-semibold text-green-800 mb-3">ข้อมูลสำหรับบิลเงินสด</h4>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium mb-1">ชื่อลูกค้า/บริษัท</label>
                <input
                  type="text"
                  value={cashBillData.company_name}
                  onChange={(e) => setCashBillData({ ...cashBillData, company_name: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">ที่อยู่</label>
                <textarea
                  value={cashBillData.address}
                  onChange={(e) => setCashBillData({ ...cashBillData, address: e.target.value })}
                  rows={3}
                  className="w-full px-3 py-2 border rounded-lg"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">รายการสินค้าในบิล</label>
                <div className="border rounded-lg p-3 bg-gray-50 max-h-48 overflow-y-auto">
                  {items.filter(item => item.product_id).length > 0 ? (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left p-2">ชื่อสินค้า</th>
                          <th className="text-left p-2">จำนวน</th>
                          <th className="text-right p-2">ราคา/หน่วย</th>
                          <th className="text-right p-2">รวม</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items
                          .filter(item => item.product_id)
                          .map((item, idx) => {
                            const quantity = item.quantity || 1
                            const unitPrice = item.unit_price || 0
                            const total = quantity * unitPrice
                            return (
                              <tr key={idx} className="border-b">
                                <td className="p-2">{item.product_name || '-'}</td>
                                <td className="p-2">{quantity}</td>
                                <td className="p-2 text-right">{unitPrice.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
                                <td className="p-2 text-right font-semibold">{total.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
                              </tr>
                            )
                          })}
                      </tbody>
                      <tfoot>
                        <tr className="border-t font-bold">
                          <td colSpan={3} className="p-2 text-right">รวมทั้งสิ้น:</td>
                          <td className="p-2 text-right">
                            {items
                              .filter(item => item.product_id)
                              .reduce((sum, item) => {
                                const quantity = item.quantity || 1
                                const unitPrice = item.unit_price || 0
                                return sum + (quantity * unitPrice)
                              }, 0)
                              .toLocaleString('th-TH', { minimumFractionDigits: 2 })}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  ) : (
                    <p className="text-gray-500 text-sm">ยังไม่มีรายการสินค้า กรุณาเพิ่มรายการสินค้าก่อน</p>
                  )}
                </div>
                <textarea
                  value={cashBillData.items_note}
                  onChange={(e) => setCashBillData({ ...cashBillData, items_note: e.target.value })}
                  rows={2}
                  className="w-full px-3 py-2 border rounded-lg mt-2"
                  placeholder="หมายเหตุเพิ่มเติม (ถ้ามี)"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex gap-4">
        <button
          type="submit"
          disabled={loading}
          className="px-6 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
        >
          {loading ? 'กำลังบันทึก...' : order ? 'อัปเดต' : 'บันทึก'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-6 py-2 bg-gray-500 text-white rounded hover:bg-gray-600"
        >
          ยกเลิก
        </button>
      </div>
    </form>
  )
}
