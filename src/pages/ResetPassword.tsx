import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

type PageState = 'waiting' | 'mfa' | 'form' | 'success' | 'invalid'

export default function ResetPassword() {
  const navigate = useNavigate()
  const [pageState, setPageState] = useState<PageState>('waiting')

  // MFA state
  const [mfaFactorId, setMfaFactorId] = useState('')
  const [mfaChallengeId, setMfaChallengeId] = useState('')
  const [otpCode, setOtpCode] = useState('')
  const [mfaLoading, setMfaLoading] = useState(false)
  const [mfaError, setMfaError] = useState('')

  // Password form state
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let handled = false

    async function handleSession() {
      if (handled) return
      const { data: { session } } = await supabase.auth.getSession()
      if (!session || handled) return
      handled = true
      await checkMfaRequired()
    }

    async function checkMfaRequired() {
      try {
        const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
        if (aal?.nextLevel === 'aal2' && aal?.currentLevel !== 'aal2') {
          // ต้องการ MFA — สร้าง challenge ทันที
          const { data: factors } = await supabase.auth.mfa.listFactors()
          const totp = factors?.totp?.find((f) => f.status === 'verified')
          if (totp) {
            const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({
              factorId: totp.id,
            })
            if (challengeErr) throw challengeErr
            setMfaFactorId(totp.id)
            setMfaChallengeId(challenge.id)
            setPageState('mfa')
            return
          }
        }
      } catch {
        // MFA check ล้มเหลว → ข้ามไปหน้า form ปกติ
      }
      setPageState('form')
    }

    handleSession()

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if ((event === 'PASSWORD_RECOVERY' || (event === 'SIGNED_IN' && session)) && !handled) {
        handled = true
        checkMfaRequired()
      }
    })

    const timer = setTimeout(() => {
      if (!handled) setPageState('invalid')
    }, 4000)

    return () => {
      subscription.unsubscribe()
      clearTimeout(timer)
    }
  }, [])

  const handleMfaVerify = async (e: React.FormEvent) => {
    e.preventDefault()
    setMfaError('')
    setMfaLoading(true)
    try {
      const { error } = await supabase.auth.mfa.verify({
        factorId: mfaFactorId,
        challengeId: mfaChallengeId,
        code: otpCode,
      })
      if (error) throw error
      setPageState('form')
    } catch (err: any) {
      setMfaError(err.message || 'รหัส OTP ไม่ถูกต้อง กรุณาลองใหม่')
    } finally {
      setMfaLoading(false)
    }
  }

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

  // ── Loading ──
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

  // ── Invalid ──
  if (pageState === 'invalid') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="bg-white p-10 rounded-2xl shadow-2xl w-full max-w-md text-center">
          <div className="text-5xl mb-4">⚠️</div>
          <h2 className="text-xl font-bold text-gray-800 mb-2">Link ไม่ถูกต้องหรือหมดอายุ</h2>
          <p className="text-gray-500 text-sm mb-6">กรุณาขอ link รีเซ็ตรหัสผ่านใหม่จากหน้า Login</p>
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

  // ── MFA Verify ──
  if (pageState === 'mfa') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="bg-white p-10 rounded-2xl shadow-2xl w-full max-w-md border-t-4 border-blue-500">
          <div className="text-center mb-6">
            <div className="text-5xl mb-3">🔐</div>
            <h1 className="text-2xl font-bold text-gray-800 mb-1">ยืนยันตัวตน 2 ชั้น</h1>
            <p className="text-gray-500 text-sm">
              กรุณากรอกรหัส OTP จาก <span className="font-medium text-gray-700">Google Authenticator</span>
            </p>
            <p className="text-xs text-gray-400 mt-1">จำเป็นต้องยืนยันก่อนเปลี่ยนรหัสผ่าน</p>
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
          <p className="text-center text-xs text-gray-400 mt-4">รหัสจะหมดอายุใน 30 วินาที</p>
        </div>
      </div>
    )
  }

  // ── Success ──
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

  // ── Password Form ──
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
            <label className="block text-sm font-medium text-gray-700 mb-1">รหัสผ่านใหม่</label>
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
            <label className="block text-sm font-medium text-gray-700 mb-1">ยืนยันรหัสผ่านใหม่</label>
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
