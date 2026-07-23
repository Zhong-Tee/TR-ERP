import { useNavigate } from 'react-router-dom'
import { useAuthContext } from '../contexts/AuthContext'
import { getSelectableMobileModes } from '../lib/mobileMode'

/**
 * ปุ่ม "เปลี่ยนโหมด" (icon อย่างเดียว) — กลับหน้าเลือกโหมด (/mode)
 * แสดงเฉพาะ user ที่มีสิทธิ์โหมดมือถือ (us_users.mobile_access) เท่านั้น
 * role มือถือแท้ๆ (picker ฯลฯ) จะไม่เห็นปุ่มนี้ — ใช้งานเหมือนเดิมทุกอย่าง
 * ค่าเริ่มต้นออกแบบให้เข้ากับ header สีเขียว (Employee Portal theme)
 */
export default function ModeSwitchButton({ className }: { className?: string }) {
  const { user } = useAuthContext()
  const navigate = useNavigate()

  const choiceCount = getSelectableMobileModes(user).length + (user?.employee_access === true ? 1 : 0)
  if (choiceCount < 2) return null

  return (
    <button
      type="button"
      onClick={() => navigate('/mode')}
      className={className ?? 'p-2 rounded-full bg-white/15 hover:bg-white/30 text-white'}
      title="เปลี่ยนโหมดการใช้งาน"
      aria-label="เปลี่ยนโหมดการใช้งาน"
    >
      <i className="fas fa-exchange-alt" />
    </button>
  )
}
