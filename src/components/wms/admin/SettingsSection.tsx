import { useState, useEffect } from 'react'
import { supabase } from '../../../lib/supabase'
import { useWmsModal } from '../useWmsModal'

type Category4M = 'Man' | 'Machine' | 'Material' | 'Method' | '-'
type TopicRow = { id: string; topic_name: string; category_4m?: Category4M }

const CATEGORY_4M_OPTIONS: Category4M[] = ['-', 'Man', 'Machine', 'Material', 'Method']
const CATEGORY_4M_LABELS: Record<Category4M, string> = {
  '-': '- (ไม่มี)',
  Man: 'Man',
  Machine: 'Machine',
  Material: 'Material',
  Method: 'Method',
}
const CATEGORY_4M_COLORS: Record<Category4M, string> = {
  '-': 'bg-gray-100 text-gray-500',
  Man: 'bg-blue-100 text-blue-700',
  Machine: 'bg-orange-100 text-orange-700',
  Material: 'bg-green-100 text-green-700',
  Method: 'bg-purple-100 text-purple-700',
}

type TopicSection = {
  table: string
  label: string
  has4m: boolean
}

const TOPIC_SECTIONS: TopicSection[] = [
  { table: 'wms_requisition_topics', label: 'หัวข้อการเบิก', has4m: true },
  { table: 'wms_return_topics', label: 'หัวข้อรายการคืน', has4m: true },
  { table: 'wms_borrow_topics', label: 'หัวข้อรายการยืม', has4m: true },
]

export default function SettingsSection() {
  const [topics, setTopics] = useState<TopicRow[]>([])
  const [sectionTopics, setSectionTopics] = useState<Record<string, TopicRow[]>>({})
  const [newTopic, setNewTopic] = useState('')
  const [newSectionInputs, setNewSectionInputs] = useState<Record<string, { name: string; category: Category4M }>>({})
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

    const results: Record<string, TopicRow[]> = {}
    for (const sec of TOPIC_SECTIONS) {
      const { data } = await supabase.from(sec.table).select('*').order('topic_name')
      results[sec.table] = (data || []) as TopicRow[]
    }
    setSectionTopics(results)
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

  const getSectionInput = (table: string) => newSectionInputs[table] || { name: '', category: '-' as Category4M }

  const updateSectionInput = (table: string, field: 'name' | 'category', value: string) => {
    setNewSectionInputs((prev) => ({
      ...prev,
      [table]: { ...getSectionInput(table), [field]: value },
    }))
  }

  const addSectionTopic = async (table: string) => {
    const input = getSectionInput(table)
    if (!input.name) return
    await supabase.from(table).insert([{ topic_name: input.name, category_4m: input.category === '-' ? null : input.category }])
    setNewSectionInputs((prev) => ({ ...prev, [table]: { name: '', category: '-' } }))
    loadSettings()
  }

  const deleteSectionTopic = async (table: string, id: string) => {
    await supabase.from(table).delete().eq('id', id)
    loadSettings()
  }

  const updateSectionCategory = async (table: string, id: string, category: Category4M) => {
    await supabase.from(table).update({ category_4m: category === '-' ? null : category }).eq('id', id)
    loadSettings()
  }

  return (
    <section className="h-full flex flex-col">
      <h2 className="text-3xl font-black mb-6 text-slate-800">ตั้งค่าระบบ</h2>
      <div className="grid grid-cols-2 gap-6 flex-1 min-h-0">
        {/* หัวข้อแจ้งเตือน */}
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

        {/* หัวข้อการเบิก / รายการคืน / รายการยืม */}
        {TOPIC_SECTIONS.map((sec) => {
          const items = sectionTopics[sec.table] || []
          const input = getSectionInput(sec.table)
          return (
            <div key={sec.table} className="bg-white p-6 rounded-2xl border shadow-sm flex flex-col">
              <h3 className="font-bold text-gray-400 text-[16px] uppercase tracking-widest mb-4 border-b pb-2 text-slate-800">
                {sec.label}
              </h3>
              <div className="flex gap-2 mb-4 shrink-0">
                <input
                  type="text"
                  value={input.name}
                  onChange={(e) => updateSectionInput(sec.table, 'name', e.target.value)}
                  placeholder="เพิ่มหัวข้อใหม่..."
                  className="flex-1 border p-2.5 rounded-lg text-sm"
                  onKeyDown={(e) => e.key === 'Enter' && addSectionTopic(sec.table)}
                />
                {sec.has4m && (
                  <select
                    value={input.category}
                    onChange={(e) => updateSectionInput(sec.table, 'category', e.target.value)}
                    className="border p-2.5 rounded-lg text-sm bg-white min-w-[110px]"
                  >
                    {CATEGORY_4M_OPTIONS.map((c) => (
                      <option key={c} value={c}>{CATEGORY_4M_LABELS[c]}</option>
                    ))}
                  </select>
                )}
                <button onClick={() => addSectionTopic(sec.table)} className="bg-slate-800 text-white px-5 rounded-lg font-bold hover:bg-black transition">
                  +
                </button>
              </div>
              <div className="divide-y flex-1 overflow-y-auto min-h-0">
                {items.map((t) => (
                  <div key={t.id} className="flex justify-between items-center py-2 text-sm gap-2">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <span className="truncate">{t.topic_name}</span>
                    </div>
                    {sec.has4m && (
                      <select
                        value={t.category_4m || '-'}
                        onChange={(e) => updateSectionCategory(sec.table, t.id, e.target.value as Category4M)}
                        className={`text-xs px-2 py-1 rounded-full font-semibold border-0 cursor-pointer ${CATEGORY_4M_COLORS[t.category_4m || '-']}`}
                      >
                        {CATEGORY_4M_OPTIONS.map((c) => (
                          <option key={c} value={c}>{CATEGORY_4M_LABELS[c]}</option>
                        ))}
                      </select>
                    )}
                    <button onClick={() => deleteSectionTopic(sec.table, t.id)} className="text-red-400 hover:text-red-600 shrink-0">
                      <i className="fas fa-trash-alt"></i>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
      {MessageModal}
    </section>
  )
}
