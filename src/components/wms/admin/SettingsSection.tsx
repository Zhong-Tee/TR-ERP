import { useState, useEffect } from 'react'
import { supabase } from '../../../lib/supabase'
import { useWmsModal } from '../useWmsModal'

type TopicRow = { id: string; topic_name: string }

export default function SettingsSection() {
  const [topics, setTopics] = useState<TopicRow[]>([])
  const [requisitionTopics, setRequisitionTopics] = useState<TopicRow[]>([])
  const [newTopic, setNewTopic] = useState('')
  const [newRequisitionTopic, setNewRequisitionTopic] = useState('')
  const { MessageModal } = useWmsModal()

  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = async () => {
    const { data: topicsData } = await supabase
      .from('wms_notification_topics')
      .select('*')
      .order('topic_name')
    if (topicsData) setTopics(topicsData as TopicRow[])

    const { data: reqTopicsData } = await supabase
      .from('wms_requisition_topics')
      .select('*')
      .order('topic_name')
    if (reqTopicsData) setRequisitionTopics(reqTopicsData as TopicRow[])
  }

  const addTopic = async () => {
    if (!newTopic) return
    await supabase.from('wms_notification_topics').insert([{ topic_name: newTopic }])
    setNewTopic('')
    loadSettings()
  }

  const deleteTopic = async (id: string) => {
    await supabase.from('wms_notification_topics').delete().eq('id', id)
    loadSettings()
  }

  const addRequisitionTopic = async () => {
    if (!newRequisitionTopic) return
    await supabase.from('wms_requisition_topics').insert([{ topic_name: newRequisitionTopic }])
    setNewRequisitionTopic('')
    loadSettings()
  }

  const deleteRequisitionTopic = async (id: string) => {
    await supabase.from('wms_requisition_topics').delete().eq('id', id)
    loadSettings()
  }

  return (
    <section className="h-full flex flex-col">
      <h2 className="text-3xl font-black mb-6 text-slate-800">ตั้งค่าระบบ</h2>
      <div className="grid grid-cols-2 gap-8 flex-1 min-h-0">
        <div className="bg-white p-6 rounded-2xl border shadow-sm flex flex-col">
          <h3 className="font-bold text-gray-400 text-[16px] uppercase tracking-widest mb-4 border-b pb-2 text-slate-800">
            หัวข้อแจ้งเตือน
          </h3>
          <div className="flex gap-2 mb-4 shrink-0">
            <input
              type="text"
              value={newTopic}
              onChange={(e) => setNewTopic(e.target.value)}
              placeholder="เพิ่มหัวข้อใหม่..."
              className="flex-1 border p-2.5 rounded-lg text-sm"
              onKeyDown={(e) => e.key === 'Enter' && addTopic()}
            />
            <button onClick={addTopic} className="bg-slate-800 text-white px-5 rounded-lg font-bold hover:bg-black transition">
              +
            </button>
          </div>
          <div className="divide-y flex-1 overflow-y-auto min-h-0">
            {topics.map((t) => (
              <div key={t.id} className="flex justify-between items-center py-2 text-sm">
                <div>{t.topic_name}</div>
                <button onClick={() => deleteTopic(t.id)} className="text-red-400 hover:text-red-600">
                  <i className="fas fa-trash-alt"></i>
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="bg-white p-6 rounded-2xl border shadow-sm flex flex-col">
          <h3 className="font-bold text-gray-400 text-[16px] uppercase tracking-widest mb-4 border-b pb-2 text-slate-800">
            หัวข้อการเบิก
          </h3>
          <div className="flex gap-2 mb-4 shrink-0">
            <input
              type="text"
              value={newRequisitionTopic}
              onChange={(e) => setNewRequisitionTopic(e.target.value)}
              placeholder="เพิ่มหัวข้อใหม่..."
              className="flex-1 border p-2.5 rounded-lg text-sm"
              onKeyDown={(e) => e.key === 'Enter' && addRequisitionTopic()}
            />
            <button onClick={addRequisitionTopic} className="bg-slate-800 text-white px-5 rounded-lg font-bold hover:bg-black transition">
              +
            </button>
          </div>
          <div className="divide-y flex-1 overflow-y-auto min-h-0">
            {requisitionTopics.map((t) => (
              <div key={t.id} className="flex justify-between items-center py-2 text-sm">
                <div>{t.topic_name}</div>
                <button onClick={() => deleteRequisitionTopic(t.id)} className="text-red-400 hover:text-red-600">
                  <i className="fas fa-trash-alt"></i>
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
      {MessageModal}
    </section>
  )
}
