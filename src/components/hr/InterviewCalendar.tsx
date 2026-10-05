import { useState } from 'react'
import type { HRInterview } from '../../types'

export default function InterviewCalendar({ interviews, name, open }: {
  interviews: HRInterview[]; name: (iv: HRInterview) => string; open: (iv: HRInterview) => void
}) {
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1))
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const start = new Date(first); start.setDate(1 - first.getDay())
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start); date.setDate(start.getDate() + index); return date
  })
  return <div className="p-4 overflow-x-auto">
    <div className="flex justify-between items-center mb-4">
      <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>← เดือนก่อน</button>
      <strong>{month.toLocaleDateString('th-TH', { month: 'long', year: 'numeric' })}</strong>
      <div className="flex gap-3"><button onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>วันนี้</button><button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>เดือนถัดไป →</button></div>
    </div>
    <div className="grid grid-cols-7 min-w-[700px]">
      {['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'].map(day => <div key={day} className="text-center bg-surface-50 py-2">{day}</div>)}
      {days.map(date => <div key={date.toISOString()} className={`border border-surface-100 min-h-28 p-2 ${date.getMonth() !== month.getMonth() ? 'bg-surface-50 text-gray-400' : ''}`}>
        <div className="text-sm mb-1">{date.getDate()}</div>
        {interviews.filter(iv => new Date(iv.interview_date).toDateString() === date.toDateString())
          .sort((a,b) => a.interview_date.localeCompare(b.interview_date)).map(iv => <button key={iv.id} onClick={() => open(iv)} className={`block w-full text-left text-xs rounded p-2 mb-1 ${iv.status === 'no_show' || iv.status === 'cancelled' ? 'bg-red-50 text-red-700' : iv.status === 'attended' || iv.status === 'completed' ? 'bg-emerald-50 text-emerald-800' : 'bg-blue-50 text-blue-800'}`}>
            {new Date(iv.interview_date).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })} {name(iv)}
          </button>)}
      </div>)}
    </div>
  </div>
}
