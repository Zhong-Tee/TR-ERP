import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import type { Session } from '@supabase/supabase-js'
import type { User } from '../types'
import { clearMobileModeStorage } from '../lib/mobileMode'
import { clearSessionDay, ensureSessionDay, isSessionExpired, markSessionDay, readSessionDay } from '../lib/dailySession'
import { MISSED_CLOCK_IN_SHOWN_KEY } from '../lib/missedClockIn'
import { ANNOUNCEMENT_ALERT_SHOWN_KEY } from '../lib/announcementAlert'

/** ล้างสถานะที่ควรอยู่แค่ช่วง session เดียว (ปลดล็อกหน้าแผน, popup เตือนลงเวลา/ประกาศ, โหมดมือถือ) */
function clearSessionScopedStorage() {
  try {
    sessionStorage.removeItem('plan_unlocked')
    sessionStorage.removeItem(MISSED_CLOCK_IN_SHOWN_KEY)
    sessionStorage.removeItem(ANNOUNCEMENT_ALERT_SHOWN_KEY)
  } catch {
    /* storage ไม่พร้อมใช้งาน — ข้าม */
  }
  // ล้างโหมดมือถือ/PC Desktop ที่จำไว้ — ให้ login ครั้งถัดไปเริ่มจากหน้าเลือกโหมด
  clearMobileModeStorage()
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [supabaseUser, setSupabaseUser] = useState<Session['user'] | null>(null)
  const [mfaPending, setMfaPending] = useState(false)
  const [mfaFactorId, setMfaFactorId] = useState<string | null>(null)

  useEffect(() => {
    // ใช้ non-async callback เพื่อไม่ return Promise (ซึ่ง Supabase internals อาจตีความผิด)
    supabase.auth.getSession().then(({ data: { session } }) => {
      // session ค้างจากเมื่อวาน → บังคับ login ใหม่ (ทุกเช้า)
      if (session?.user && isSessionExpired(readSessionDay())) {
        forceDailySignOut()
        setSupabaseUser(null)
        setLoading(false)
        return
      }
      setSupabaseUser(session?.user ?? null)
      if (session?.user) {
        ensureSessionDay()
        handleSessionWithMfaCheck(session.user.id)
      } else {
        setLoading(false)
      }
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSupabaseUser(session?.user ?? null)
      if (session?.user) {
        // session ที่มาจากทางอื่น (เช่นลิงก์ reset password) ก็ต้องนับวันเริ่มไว้ด้วย
        ensureSessionDay()
        // Recovery flow: ไม่ต้องเช็ค MFA — ให้ ResetPassword page จัดการเอง
        if (_event === 'PASSWORD_RECOVERY') {
          setLoading(false)
          return
        }
        handleSessionWithMfaCheck(session.user.id)
      } else {
        setUser(null)
        setMfaPending(false)
        setMfaFactorId(null)
        setLoading(false)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  // เปิดเว็บค้างข้ามคืน → พอถึงเช้าวันใหม่ให้เตะออกไป login ใหม่
  useEffect(() => {
    if (!supabaseUser) return
    const check = () => {
      if (isSessionExpired(readSessionDay())) forceDailySignOut()
    }
    check()
    const timer = setInterval(check, 60_000)
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('focus', check)
    }
  }, [supabaseUser])

  /** ออกจากระบบเพราะข้ามวัน — ล้างสถานะที่ผูกกับ session แล้วให้ Supabase เคลียร์ token */
  function forceDailySignOut() {
    clearSessionScopedStorage()
    // ล้างวันของ session เมื่อออกสำเร็จเท่านั้น — ถ้าเน็ตหลุด จะได้ลองใหม่ในรอบถัดไป
    supabase.auth
      .signOut()
      .then(({ error }) => {
        if (!error) clearSessionDay()
      })
      .catch(() => {})
  }

  async function handleSessionWithMfaCheck(userId: string) {
    let mfaRequired = false
    try {
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      if (aal?.nextLevel === 'aal2' && aal?.currentLevel !== 'aal2') {
        const { data: factors } = await supabase.auth.mfa.listFactors()
        const verifiedTotp = factors?.totp?.find((f) => f.status === 'verified')
        if (verifiedTotp) {
          setMfaPending(true)
          setMfaFactorId(verifiedTotp.id)
          mfaRequired = true
        }
      }
    } catch {
      // MFA check ล้มเหลว → ข้ามไปโหลด user ปกติ
    } finally {
      if (mfaRequired) {
        setLoading(false)
        return
      }
    }
    setMfaPending(false)
    setMfaFactorId(null)
    loadUserData(userId)
  }

  async function loadUserData(userId: string) {
    try {
      console.log('Loading user data for userId:', userId)

      const { data, error } = await supabase
        .from('us_users')
        .select('*')
        .eq('id', userId)
        .single()

      if (error) {
        console.error('Error loading user data:', error)

        if (error.code === 'PGRST116') {
          console.warn('User not found in us_users table. User ID:', userId)
          alert('ไม่พบข้อมูลผู้ใช้ในระบบ กรุณาติดต่อผู้ดูแลระบบเพื่อเพิ่มข้อมูลผู้ใช้')
        }

        setUser(null)
        setLoading(false)
        return
      }

      // ตรวจสอบว่า user ถูกระงับการใช้งานหรือไม่
      if (data.is_active === false) {
        console.warn('User account is deactivated:', data.email)
        setUser(null)
        setLoading(false)
        await supabase.auth.signOut().catch(() => {})
        alert('บัญชีของคุณถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ')
        return
      }

      console.log('User data loaded:', data)
      setUser(data as User)
    } catch (error: any) {
      console.error('Error loading user data:', error)
      setUser(null)
    } finally {
      setLoading(false)
    }
  }

  async function signIn(email: string, password: string) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (error) throw error
    // จำวันที่เริ่ม session ไว้ เพื่อบังคับ login ใหม่เมื่อข้ามไปเช้าวันถัดไป
    markSessionDay()
    return data
  }

  async function signOut() {
    clearSessionDay()
    clearSessionScopedStorage()
    const { error } = await supabase.auth.signOut()
    if (error) {
      if (error.message?.includes('session missing') || error.message?.includes('Session')) {
        setUser(null)
        setSupabaseUser(null)
        setMfaPending(false)
        setMfaFactorId(null)
        return
      }
      throw error
    }
  }

  async function verifyMfa(code: string) {
    if (!mfaFactorId) throw new Error('ไม่พบข้อมูล MFA กรุณา login ใหม่')
    const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
      factorId: mfaFactorId,
    })
    if (challengeError) throw challengeError
    const { error } = await supabase.auth.mfa.verify({
      factorId: mfaFactorId,
      challengeId: challenge.id,
      code,
    })
    if (error) throw error
    // onAuthStateChange จะ fire ด้วย AAL2 session แล้วเรียก loadUserData อัตโนมัติ
  }

  async function sendPasswordResetEmail(email: string) {
    const redirectTo = `${window.location.origin}/reset-password`
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })
    if (error) throw error
  }

  return {
    user,
    supabaseUser,
    loading,
    mfaPending,
    signIn,
    signOut,
    verifyMfa,
    sendPasswordResetEmail,
  }
}
