import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../lib/supabase'

interface MfaFactor {
  id: string
  friendly_name?: string
  factor_type: string
  status: string
  created_at: string
}

export default function MfaEnrollPanel() {
  const [factors, setFactors] = useState<MfaFactor[]>([])
  const [loadingFactors, setLoadingFactors] = useState(true)

  // Enroll flow
  const [enrolling, setEnrolling] = useState(false)
  const [qrCodeUrl, setQrCodeUrl] = useState('')
  const [enrollFactorId, setEnrollFactorId] = useState('')
  const [verifyCode, setVerifyCode] = useState('')

  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const loadFactors = useCallback(async () => {
    setLoadingFactors(true)
    try {
      const { data, error } = await supabase.auth.mfa.listFactors()
      if (error) throw error
      const all: MfaFactor[] = [...(data?.totp ?? []), ...(data?.phone ?? [])]
      setFactors(all)
    } catch (err: any) {
      setMessage({ type: 'error', text: 'โหลดข้อมูล MFA ไม่สำเร็จ: ' + err.message })
    } finally {
      setLoadingFactors(false)
    }
  }, [])

  useEffect(() => {
    loadFactors()
  }, [loadFactors])

  async function handleStartEnroll() {
    setLoading(true)
    setMessage(null)
    try {
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'TR-ERP Authenticator',
      })
      if (error) throw error
      setQrCodeUrl(data.totp.qr_code)
      setEnrollFactorId(data.id)
      setEnrolling(true)
      setVerifyCode('')
    } catch (err: any) {
      setMessage({ type: 'error', text: 'เกิดข้อผิดพลาด: ' + err.message })
    } finally {
      setLoading(false)
    }
  }

  async function handleConfirmEnroll() {
    if (verifyCode.length !== 6) return
    setLoading(true)
    setMessage(null)
    try {
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId: enrollFactorId,
      })
      if (challengeError) throw challengeError

      const { error } = await supabase.auth.mfa.verify({
        factorId: enrollFactorId,
        challengeId: challenge.id,
        code: verifyCode,
      })
      if (error) throw error

      setMessage({ type: 'success', text: '✅ เปิดใช้งาน 2FA สำเร็จ! บัญชีของคุณได้รับการปกป้องแล้ว' })
      setEnrolling(false)
      setQrCodeUrl('')
      setEnrollFactorId('')
      setVerifyCode('')
      await loadFactors()
    } catch (err: any) {
      setMessage({ type: 'error', text: 'รหัส OTP ไม่ถูกต้อง: ' + err.message })
    } finally {
      setLoading(false)
    }
  }

  async function handleCancelEnroll() {
    if (enrollFactorId) {
      await supabase.auth.mfa.unenroll({ factorId: enrollFactorId }).catch(() => {})
    }
    setEnrolling(false)
    setQrCodeUrl('')
    setEnrollFactorId('')
    setVerifyCode('')
  }

  async function handleUnenroll(factorId: string) {
    if (!window.confirm('ต้องการปิดใช้งาน 2FA หรือไม่?\n\nการกระทำนี้จะลบการยืนยันตัวตน 2 ชั้นออกจากบัญชีนี้')) return
    setLoading(true)
    setMessage(null)
    try {
      const { error } = await supabase.auth.mfa.unenroll({ factorId })
      if (error) throw error
      setMessage({ type: 'success', text: 'ปิดใช้งาน 2FA สำเร็จ' })
      await loadFactors()
    } catch (err: any) {
      setMessage({ type: 'error', text: 'เกิดข้อผิดพลาด: ' + err.message })
    } finally {
      setLoading(false)
    }
  }

  const verifiedFactors = factors.filter((f) => f.status === 'verified')
  const hasVerifiedMfa = verifiedFactors.length > 0

  return (
    <div className="bg-white rounded-xl shadow p-6 max-w-xl space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-gray-800">การยืนยันตัวตน 2 ชั้น (2FA / TOTP)</h3>
        <p className="text-sm text-gray-500 mt-1">
          ใช้ App เช่น <span className="font-medium">Google Authenticator</span> หรือ <span className="font-medium">Authy</span> เพื่อสร้างรหัส OTP ทุกครั้งที่ login
        </p>
      </div>

      {message && (
        <div
          className={`px-4 py-3 rounded-lg text-sm ${
            message.type === 'success'
              ? 'bg-green-50 text-green-700 border border-green-200'
              : 'bg-red-50 text-red-700 border border-red-200'
          }`}
        >
          {message.text}
        </div>
      )}

      {loadingFactors ? (
        <div className="flex items-center gap-2 text-gray-500 text-sm">
          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-500" />
          กำลังโหลด...
        </div>
      ) : (
        <>
          {/* สถานะปัจจุบัน */}
          {hasVerifiedMfa ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3 px-4 py-3 bg-green-50 border border-green-200 rounded-lg">
                <span className="text-2xl">🛡️</span>
                <div>
                  <p className="font-semibold text-green-800">2FA เปิดใช้งานอยู่</p>
                  <p className="text-xs text-green-600">บัญชีของคุณได้รับการปกป้องแล้ว</p>
                </div>
              </div>
              {verifiedFactors.map((factor) => (
                <div
                  key={factor.id}
                  className="flex items-center justify-between px-4 py-3 border border-gray-200 rounded-lg"
                >
                  <div>
                    <p className="font-medium text-gray-800 text-sm">
                      {factor.friendly_name || 'Authenticator App'}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      เพิ่มเมื่อ{' '}
                      {new Date(factor.created_at).toLocaleDateString('th-TH', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                      })}
                    </p>
                  </div>
                  <button
                    onClick={() => handleUnenroll(factor.id)}
                    disabled={loading}
                    className="px-3 py-1.5 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50 transition"
                  >
                    ลบออก
                  </button>
                </div>
              ))}
            </div>
          ) : (
            !enrolling && (
              <div className="space-y-4">
                <div className="flex items-start gap-3 px-4 py-3 bg-amber-50 border border-amber-200 rounded-lg">
                  <span className="text-xl mt-0.5">⚠️</span>
                  <div>
                    <p className="font-semibold text-amber-800 text-sm">ยังไม่ได้เปิดใช้งาน 2FA</p>
                    <p className="text-xs text-amber-700 mt-0.5">
                      บัญชี superadmin มีความเสี่ยง — แนะนำให้เปิดใช้งาน 2FA เพื่อความปลอดภัย
                    </p>
                  </div>
                </div>
                <button
                  onClick={handleStartEnroll}
                  disabled={loading}
                  className="px-5 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium text-sm disabled:opacity-50 transition"
                >
                  {loading ? 'กำลังสร้าง QR Code...' : 'เปิดใช้งาน 2FA'}
                </button>
              </div>
            )
          )}

          {/* ขั้นตอน Enroll */}
          {enrolling && (
            <div className="border border-blue-200 rounded-xl p-5 bg-blue-50 space-y-4">
              <h4 className="font-semibold text-blue-800">ขั้นตอนการตั้งค่า 2FA</h4>
              <ol className="space-y-1.5 text-sm text-blue-700 list-none">
                <li><span className="font-bold">1.</span> เปิด app <span className="font-medium">Google Authenticator</span> หรือ <span className="font-medium">Authy</span></li>
                <li><span className="font-bold">2.</span> กดปุ่ม <span className="font-medium">"+"</span> แล้วเลือก <span className="font-medium">"Scan QR Code"</span></li>
                <li><span className="font-bold">3.</span> สแกน QR Code ด้านล่าง</li>
                <li><span className="font-bold">4.</span> กรอกรหัส 6 หลักจาก app เพื่อยืนยัน</li>
              </ol>

              {qrCodeUrl && (
                <div className="flex justify-center">
                  <div className="bg-white p-3 rounded-xl shadow-sm border border-blue-100">
                    <img src={qrCodeUrl} alt="QR Code สำหรับ 2FA" className="w-48 h-48" />
                  </div>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-blue-800 mb-1">
                  รหัส OTP จาก app (6 หลัก)
                </label>
                <input
                  type="text"
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="000000"
                  autoFocus
                  className="w-full px-4 py-3 rounded-lg border border-blue-300 text-center text-2xl tracking-[0.5em] font-mono focus:ring-2 focus:ring-blue-500 outline-none bg-white"
                />
              </div>

              <div className="flex gap-3">
                <button
                  onClick={handleConfirmEnroll}
                  disabled={loading || verifyCode.length < 6}
                  className="flex-1 py-2.5 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 transition text-sm"
                >
                  {loading ? 'กำลังยืนยัน...' : 'ยืนยันเปิดใช้งาน'}
                </button>
                <button
                  onClick={handleCancelEnroll}
                  disabled={loading}
                  className="px-4 py-2.5 bg-white text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 text-sm transition"
                >
                  ยกเลิก
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
