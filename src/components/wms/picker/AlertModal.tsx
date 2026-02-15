import { useState, useEffect } from 'react'
import Modal from '../../ui/Modal'
import { supabase } from '../../../lib/supabase'

interface AlertModalProps {
  onClose: () => void
  onSubmit: (topicName: string) => void
}

export default function AlertModal({ onClose, onSubmit }: AlertModalProps) {
  const [topics, setTopics] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [pendingTopic, setPendingTopic] = useState<string | null>(null)

  useEffect(() => {
    loadAlertOptions()
  }, [])

  const loadAlertOptions = async () => {
    const { data } = await supabase.from('wms_notification_topics').select('*').order('topic_name')
    if (data) {
      setTopics(data)
    }
    setLoading(false)
  }

  return (
    <>
      <Modal open={true} onClose={onClose} closeOnBackdropClick={true} contentClassName="max-w-sm">
        <div className="bg-white w-full rounded-[3rem] text-slate-900 shadow-2xl">
          <div className="p-8 bg-slate-50 border-b flex justify-between items-center">
            <h3 className="font-black text-2xl">เลือกปัญหา</h3>
            <button onClick={onClose} className="text-gray-300 hover:text-red-500 text-3xl">
              <i className="fas fa-times-circle"></i>
            </button>
          </div>
          <div className="p-6 grid grid-cols-1 gap-3 overflow-y-auto" style={{ maxHeight: '60vh' }}>
            {loading ? (
              <div className="text-center p-4">กำลังโหลด...</div>
            ) : (
              topics.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setPendingTopic(t.topic_name)}
                  className="bg-gray-100 p-4 rounded-2xl text-lg font-bold text-left active:bg-blue-600 active:text-white"
                >
                  {t.topic_name}
                </button>
              ))
            )}
          </div>
        </div>
      </Modal>

      {/* Confirm popup */}
      {pendingTopic && (
        <Modal open={true} onClose={() => setPendingTopic(null)} closeOnBackdropClick={true} contentClassName="max-w-xs">
          <div className="bg-white w-full rounded-3xl text-slate-900 shadow-2xl p-6 text-center">
            <div className="text-5xl mb-4">
              <i className="fas fa-exclamation-triangle text-yellow-500"></i>
            </div>
            <h3 className="font-black text-xl mb-2">ยืนยันส่งแจ้งเตือน</h3>
            <p className="text-gray-500 text-sm mb-6">
              ต้องการแจ้ง <span className="font-bold text-slate-800">"{pendingTopic}"</span> ใช่หรือไม่?
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setPendingTopic(null)}
                className="flex-1 py-3 rounded-2xl font-bold text-lg bg-gray-200 text-gray-600 active:scale-95 transition-all"
              >
                ยกเลิก
              </button>
              <button
                onClick={() => {
                  onSubmit(pendingTopic)
                  setPendingTopic(null)
                }}
                className="flex-1 py-3 rounded-2xl font-bold text-lg bg-yellow-500 text-white active:scale-95 transition-all"
              >
                ยืนยัน
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}
