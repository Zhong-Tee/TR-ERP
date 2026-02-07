import { useState } from 'react'
import { useAuthContext } from '../../../contexts/AuthContext'
import { supabase } from '../../../lib/supabase'
import { getProductImageUrl } from '../wmsUtils'
import PickerListModal from './PickerListModal'
import AlertModal from './AlertModal'
import { useWmsModal } from '../useWmsModal'

interface PickerJobCardProps {
  item: any
  allItems: any[]
  currentIndex: number
  totalItems: number
  onFinish: () => void
  onNoProduct: () => void
  onNavigate: (dir: number) => void
}

export default function PickerJobCard({ item, allItems, currentIndex, onFinish, onNoProduct, onNavigate }: PickerJobCardProps) {
  const [showListModal, setShowListModal] = useState(false)
  const [showAlertModal, setShowAlertModal] = useState(false)
  const { user } = useAuthContext()
  const { showMessage, MessageModal } = useWmsModal()

  const finished = ['picked', 'correct', 'out_of_stock'].includes(item.status)
  const imgUrl =
    item.product_code === 'SPARE_PART' ? 'https://placehold.co/500x500?text=SPARE' : getProductImageUrl(item.product_code)

  return (
    <>
      <div className="bg-white text-slate-900 w-full rounded-[2.5rem] overflow-hidden shadow-2xl flex flex-col" style={{ height: '72vh' }}>
        <div className="p-4 bg-white flex justify-between items-center border-b">
          <div className="bg-red-600 text-white px-5 py-2 rounded-2xl font-black text-2xl shadow-lg">{item.location || '---'}</div>
          <button
            onClick={() => setShowListModal(true)}
            className="bg-slate-100 text-slate-600 w-12 h-12 rounded-2xl flex items-center justify-center shadow-inner active:bg-blue-500 active:text-white transition-all"
          >
            <i className="fas fa-list-ul text-xl"></i>
          </button>
        </div>

        <div className="flex-1 bg-gray-100 overflow-hidden">
          <img
            src={imgUrl}
            className="w-full h-full object-contain"
            onError={(e) => {
              const target = e.target as HTMLImageElement
              target.src = 'https://placehold.co/500x500?text=NO+IMAGE'
            }}
            alt={item.product_name}
          />
        </div>

        <div className="p-4 bg-white">
          <div className="mb-3">
            <h2 className="text-[18px] font-bold text-slate-800 truncate">{item.product_name}</h2>
          </div>

          <div className="grid grid-cols-2 gap-2 mb-3">
            <button
              onClick={() => setShowAlertModal(true)}
              className="bg-yellow-500 text-white py-3 rounded-2xl font-black text-lg shadow-md active:scale-95 flex items-center justify-center gap-2"
            >
              <span>!!</span>
              <span className="text-sm font-bold">แจ้งเตือน</span>
            </button>
            <button
              onClick={(e) => {
                e.preventDefault()
                onNoProduct()
              }}
              className="bg-slate-700 text-white py-3 rounded-2xl font-black text-lg shadow-md active:scale-95 flex items-center justify-center gap-2 hover:bg-slate-800 transition-all cursor-pointer"
              type="button"
            >
              <span>X</span>
              <span className="text-sm font-bold">สินค้าหมด</span>
            </button>
          </div>

          <div className="bg-slate-50 px-6 py-2 rounded-2xl border flex items-center justify-between">
            <span className="text-[18.66px] text-gray-400 font-bold uppercase">จำนวนเบิก</span>
            <span className="text-4xl font-black text-slate-900">{item.qty}</span>
          </div>
        </div>
      </div>

      <div className="flex gap-2 p-2">
        <button
          onClick={() => onNavigate(-1)}
          className="w-20 bg-slate-800 text-white py-6 rounded-3xl text-3xl shadow-lg hover:bg-slate-700 active:scale-95 transition-all cursor-pointer"
          type="button"
        >
          <i className="fas fa-chevron-left"></i>
        </button>
        <button
          onClick={(e) => {
            e.preventDefault()
            if (!finished) onFinish()
          }}
          disabled={finished}
          className={`flex-1 py-6 rounded-3xl text-2xl font-black shadow-lg ${
            finished ? 'bg-slate-500 opacity-60 cursor-not-allowed' : 'bg-green-500 hover:bg-green-600 active:scale-95 transition-all cursor-pointer'
          }`}
          type="button"
        >
          {finished ? (item.status === 'out_of_stock' ? 'สินค้าหมดแล้ว' : 'หยิบเรียบร้อยแล้ว') : 'หยิบเสร็จแล้ว'}
        </button>
        <button
          onClick={() => onNavigate(1)}
          className="w-20 bg-slate-800 text-white py-6 rounded-3xl text-3xl shadow-lg hover:bg-slate-700 active:scale-95 transition-all cursor-pointer"
          type="button"
        >
          <i className="fas fa-chevron-right"></i>
        </button>
      </div>

      {showListModal && (
        <PickerListModal
          items={allItems}
          currentItemId={item.id}
          currentIndex={currentIndex}
          onClose={() => setShowListModal(false)}
          onJumpTo={(idx) => {
            onNavigate(idx - currentIndex)
            setShowListModal(false)
          }}
        />
      )}

      {showAlertModal && (
        <AlertModal
          onClose={() => setShowAlertModal(false)}
          onSubmit={async (topic) => {
            if (!user || !item) return
            await supabase.from('wms_notifications').insert([
              {
                type: topic,
                order_id: item.order_id,
                picker_id: user.id,
                status: 'unread',
                is_read: false,
              },
            ])
            showMessage({ message: `ส่งแล้ว: ${topic}` })
            setShowAlertModal(false)
          }}
        />
      )}
      {MessageModal}
    </>
  )
}
