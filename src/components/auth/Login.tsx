import { useState } from 'react'
import { useAuthContext } from '../../contexts/AuthContext'

interface LoginProps {
  onLoginSuccess: () => void
}

export default function Login({ onLoginSuccess: _onLoginSuccess }: LoginProps) {
  const { signIn, mfaPending, verifyMfa, sendPasswordResetEmail } = useAuthContext()

  // Login form state
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // MFA verify state
  const [otpCode, setOtpCode] = useState('')
  const [mfaLoading, setMfaLoading] = useState(false)
  const [mfaError, setMfaError] = useState('')

  // Forgot password state
  const [showForgot, setShowForgot] = useState(false)
  const [forgotEmail, setForgotEmail] = useState('')
  const [forgotLoading, setForgotLoading] = useState(false)
  const [forgotMessage, setForgotMessage] = useState('')
  const [forgotIsError, setForgotIsError] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await signIn(email, password)
      console.log('Login successful, waiting for auth state...')
    } catch (err: any) {
      setError(err.message || 'เกิดข้อผิดพลาดในการเข้าสู่ระบบ')
      setLoading(false)
    }
  }

  const handleMfaVerify = async (e: React.FormEvent) => {
    e.preventDefault()
    setMfaError('')
    setMfaLoading(true)
    try {
      await verifyMfa(otpCode)
    } catch (err: any) {
      setMfaError(err.message || 'รหัส OTP ไม่ถูกต้อง กรุณาลองใหม่')
      setMfaLoading(false)
    }
  }

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setForgotMessage('')
    setForgotLoading(true)
    try {
      await sendPasswordResetEmail(forgotEmail)
      setForgotIsError(false)
      setForgotMessage('ส่ง link รีเซ็ตรหัสผ่านไปยัง email แล้ว กรุณาตรวจสอบ inbox (และ Spam folder)')
    } catch (err: any) {
      setForgotIsError(true)
      setForgotMessage('เกิดข้อผิดพลาด: ' + (err.message || 'ลองใหม่อีกครั้ง'))
    } finally {
      setForgotLoading(false)
    }
  }

  // ── หน้า MFA Verify ──
  if (mfaPending) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100" style={{ minHeight: '100vh' }}>
        <div className="bg-white p-10 rounded-2xl shadow-2xl w-full max-w-md border-t-4 border-blue-500">
          <div className="text-center mb-6">
            <div className="text-5xl mb-3">🔐</div>
            <h1 className="text-2xl font-bold text-gray-800 mb-2">ยืนยันตัวตน 2 ชั้น</h1>
            <p className="text-gray-500 text-sm">
              เปิด <span className="font-medium text-gray-700">Google Authenticator</span> แล้วกรอกรหัส 6 หลัก
            </p>
          </div>
          <form onSubmit={handleMfaVerify} className="space-y-4">
            <input
              type="text"
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoFocus
              placeholder="000000"
              maxLength={6}
              className="w-full px-4 py-4 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-center text-3xl tracking-[0.5em] font-mono"
            />
            {mfaError && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
                {mfaError}
              </div>
            )}
            <button
              type="submit"
              disabled={mfaLoading || otpCode.length < 6}
              className="w-full py-3 rounded-lg bg-blue-500 text-white font-bold hover:bg-blue-600 transition shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {mfaLoading ? 'กำลังตรวจสอบ...' : 'ยืนยัน OTP'}
            </button>
          </form>
          <div className="text-center mt-4">
            <button
              type="button"
              onClick={async () => {
                await signOut().catch(() => {})
                window.location.href = '/'
              }}
              className="text-sm text-gray-400 hover:text-gray-600 hover:underline"
            >
              ยกเลิก / กลับหน้า Login
            </button>
          </div>
          <p className="text-center text-xs text-gray-400 mt-3">รหัสจะหมดอายุใน 30 วินาที</p>
        </div>
      </div>
    )
  }

  // ── หน้า Forgot Password ──
  if (showForgot) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100" style={{ minHeight: '100vh' }}>
        <div className="bg-white p-10 rounded-2xl shadow-2xl w-full max-w-md border-t-4 border-blue-500">
          <div className="text-center mb-6">
            <h1 className="text-2xl font-bold text-gray-800 mb-2">รีเซ็ตรหัสผ่าน</h1>
            <p className="text-gray-500 text-sm">ระบบจะส่ง link ไปยัง email ของคุณ</p>
          </div>
          <form onSubmit={handleForgotPassword} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">อีเมล</label>
              <input
                type="email"
                value={forgotEmail}
                onChange={(e) => setForgotEmail(e.target.value)}
                required
                autoFocus
                className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                placeholder="กรุณากรอกอีเมล"
              />
            </div>
            {forgotMessage && (
              <div className={`px-4 py-3 rounded-lg text-sm ${forgotIsError ? 'bg-red-50 border border-red-200 text-red-700' : 'bg-green-50 border border-green-200 text-green-700'}`}>
                {forgotMessage}
              </div>
            )}
            <button
              type="submit"
              disabled={forgotLoading}
              className="w-full py-3 rounded-lg bg-blue-500 text-white font-bold hover:bg-blue-600 transition shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {forgotLoading ? 'กำลังส่ง...' : 'ส่ง Link รีเซ็ตรหัสผ่าน'}
            </button>
            <button
              type="button"
              onClick={() => { setShowForgot(false); setForgotMessage(''); setForgotEmail('') }}
              className="w-full py-2 text-sm text-gray-500 hover:text-gray-700"
            >
              กลับไปหน้า Login
            </button>
          </form>
        </div>
      </div>
    )
  }

  // ── หน้า Login ปกติ ──
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100" style={{ minHeight: '100vh' }}>
      <div className="bg-white p-10 rounded-2xl shadow-2xl w-full max-w-md border-t-4 border-blue-500">
        <div className="text-center mb-6">
          <h1 className="text-3xl font-bold text-gray-800 mb-2">TR-ERP</h1>
          <p className="text-gray-600">บริษัท ออนดีมานด์ แฟคตอรี่ จำกัด</p>
        </div>

        <form onSubmit={handleSubmit} autoComplete="on" className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
              อีเมล
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              autoFocus
              className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
              placeholder="กรุณากรอกอีเมล"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
              รหัสผ่าน
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !loading) {
                  e.preventDefault()
                  handleSubmit(e as unknown as React.FormEvent)
                }
              }}
              className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
              placeholder="กรุณากรอกรหัสผ่าน"
            />
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 rounded-lg bg-blue-500 text-white font-bold hover:bg-blue-600 transition shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ'}
          </button>
        </form>

        <div className="text-center mt-4">
          <button
            type="button"
            onClick={() => { setShowForgot(true); setForgotEmail(email) }}
            className="text-sm text-blue-500 hover:text-blue-700 hover:underline"
          >
            ลืมรหัสผ่าน?
          </button>
        </div>

        <p className="text-center text-xs text-gray-400 mt-4">Version {__APP_VERSION__}</p>
      </div>
    </div>
  )
}
