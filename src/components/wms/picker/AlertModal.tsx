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

  const handleSubmit = (topicName: string) => {
    onSubmit(topicName)
  }

  return (
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
                onClick={() => handleSubmit(t.topic_name)}
                className="bg-gray-100 p-4 rounded-2xl text-lg font-bold text-left active:bg-blue-600 active:text-white"
              >
                {t.topic_name}
              </button>
            ))
          )}
        </div>
      </div>
    </Modal>
  )
}
