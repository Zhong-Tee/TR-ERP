import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

type PageState = 'waiting' | 'form' | 'success' | 'invalid'

export default function ResetPassword() {
  const navigate = useNavigate()
  const [pageState, setPageState] = useState<PageState>('waiting')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let handled = false

    // เช็ค session ทันที กรณีที่ Supabase process token ก่อน listener ลงทะเบียน
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session && !handled) {
        const hash = window.location.hash
        if (hash.includes('type=recovery') || hash.includes('access_token')) {
          handled = true
          setPageState('form')
        }
      }
    })

    // ยัง listen event ไว้ด้วย กรณี Supabase process token หลัง component mount
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY' && !handled) {
        handled = true
        setPageState('form')
      }
    })

    // ตรวจสอบว่า URL มี recovery token หรือไม่
    const hash = window.location.hash
    const hasRecoveryToken = hash.includes('type=recovery') || hash.includes('access_token')

    const timer = setTimeout(() => {
      if (!handled) {
        setPageState(hasRecoveryToken ? 'invalid' : 'invalid')
      }
    }, 3000)

    if (!hasRecoveryToken) {
      setPageState('invalid')
    }

    return () => {
      subscription.unsubscribe()
      clearTimeout(timer)
    }
  }, [])

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (password.length < 8) {
      setError('รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร')
      return
    }
    if (password !== confirmPassword) {
      setError('รหัสผ่านทั้งสองช่องไม่ตรงกัน')
      return
    }

    setLoading(true)
    try {
      const { error } = await supabase.auth.updateUser({ password })
      if (error) throw error
      setPageState('success')
      setTimeout(() => navigate('/'), 3000)
    } catch (err: any) {
      setError(err.message || 'เกิดข้อผิดพลาด กรุณาลองใหม่')
    } finally {
      setLoading(false)
    }
  }

  if (pageState === 'waiting') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto" />
          <p className="mt-4 text-gray-600">กำลังตรวจสอบ link...</p>
        </div>
      </div>
    )
  }

  if (pageState === 'invalid') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="bg-white p-10 rounded-2xl shadow-2xl w-full max-w-md text-center">
          <div className="text-5xl mb-4">⚠️</div>
          <h2 className="text-xl font-bold text-gray-800 mb-2">Link ไม่ถูกต้องหรือหมดอายุ</h2>
          <p className="text-gray-500 text-sm mb-6">
            กรุณาขอ link รีเซ็ตรหัสผ่านใหม่จากหน้า Login
          </p>
          <button
            onClick={() => navigate('/')}
            className="px-6 py-2.5 bg-blue-500 text-white rounded-lg hover:bg-blue-600 font-medium"
          >
            กลับหน้า Login
          </button>
        </div>
      </div>
    )
  }

  if (pageState === 'success') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="bg-white p-10 rounded-2xl shadow-2xl w-full max-w-md text-center">
          <div className="text-5xl mb-4">✅</div>
          <h2 className="text-2xl font-bold text-gray-800 mb-2">เปลี่ยนรหัสผ่านสำเร็จ</h2>
          <p className="text-gray-500">กำลังพาไปหน้า Login...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="bg-white p-10 rounded-2xl shadow-2xl w-full max-w-md border-t-4 border-blue-500">
        <div className="text-center mb-6">
          <h1 className="text-3xl font-bold text-gray-800 mb-1">TR-ERP</h1>
          <p className="text-xl font-semibold text-gray-700 mt-3">ตั้งรหัสผ่านใหม่</p>
          <p className="text-gray-500 text-sm mt-1">กรุณากรอกรหัสผ่านใหม่ที่ต้องการ</p>
        </div>

        <form onSubmit={handleReset} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              รหัสผ่านใหม่
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoFocus
                className="w-full px-4 py-3 pr-12 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                placeholder="อย่างน้อย 8 ตัวอักษร"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                {showPassword ? '🙈' : '👁️'}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              ยืนยันรหัสผ่านใหม่
            </label>
            <input
              type={showPassword ? 'text' : 'password'}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
              placeholder="กรอกรหัสผ่านอีกครั้ง"
            />
          </div>

          {password && confirmPassword && password !== confirmPassword && (
            <p className="text-sm text-red-500">รหัสผ่านไม่ตรงกัน</p>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || password.length < 8 || password !== confirmPassword}
            className="w-full py-3 rounded-lg bg-blue-500 text-white font-bold hover:bg-blue-600 transition shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'กำลังบันทึก...' : 'ตั้งรหัสผ่านใหม่'}
          </button>
        </form>
      </div>
    </div>
  )
}
