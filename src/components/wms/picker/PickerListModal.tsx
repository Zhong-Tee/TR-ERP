import Modal from '../../ui/Modal'

interface PickerListModalProps {
  items: any[]
  currentItemId: string
  currentIndex: number
  onClose: () => void
  onJumpTo: (itemId: string) => void
}

export default function PickerListModal({ items, currentItemId, onClose, onJumpTo }: PickerListModalProps) {
  return (
    <Modal open={true} onClose={onClose} closeOnBackdropClick={true} contentClassName="max-w-md">
      <div className="bg-white w-full rounded-[2.5rem] overflow-hidden flex flex-col shadow-2xl h-[80vh]">
        <div className="p-6 border-b flex justify-between items-center bg-slate-50">
          <h3 className="font-black text-xl text-slate-800">รายการในใบงาน</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-red-500 text-2xl">
            <i className="fas fa-times-circle"></i>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {items.length === 0 ? (
            <div className="text-center p-10 text-gray-400 italic">ไม่มีข้อมูลรายการ</div>
          ) : (
            items.map((item, idx) => {
              const isFinished = ['picked', 'correct', 'out_of_stock'].includes(item.status)
              const isCurrent = item.id === currentItemId

              let statusIcon = <div className="w-6 h-6 rounded-full border-2 border-gray-200"></div>
              let bgClass = 'bg-white'

              if (item.status === 'picked' || item.status === 'correct') {
                statusIcon = <i className="fas fa-check-circle text-green-500 text-2xl"></i>
                bgClass = 'bg-green-50/50'
              } else if (item.status === 'out_of_stock') {
                statusIcon = <i className="fas fa-times-circle text-red-500 text-2xl"></i>
                bgClass = 'bg-red-50/50'
              }

              if (isCurrent) {
                bgClass = 'border-blue-500 bg-blue-50 ring-2 ring-blue-100'
              }

              return (
                <div
                  key={item.id}
                  onClick={() => onJumpTo(item.id)}
                  className={`flex items-center justify-between p-3 border rounded-2xl transition-all cursor-pointer active:scale-95 ${bgClass}`}
                >
                  <div className="flex items-center gap-3 overflow-hidden">
                    <span className={`font-black text-sm w-4 ${isCurrent ? 'text-blue-600' : 'text-gray-300'}`}>
                      {idx + 1}
                    </span>
                    <div className="overflow-hidden">
                      <div className={`font-bold text-sm truncate ${isFinished ? 'text-gray-400 line-through' : 'text-slate-800'}`}>
                        {item.product_name}
                      </div>
                      <div className="text-[10px] font-bold text-gray-400 uppercase">
                        จุดเก็บ: <span className="text-red-500">{item.location}</span> | จำนวน: {item.qty}
                      </div>
                    </div>
                  </div>
                  <div className="shrink-0 ml-2">{statusIcon}</div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </Modal>
  )
}
