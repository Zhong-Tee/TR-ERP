import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import type { Session } from '@supabase/supabase-js'
import type { User } from '../types'
import { clearMobileModeStorage } from '../lib/mobileMode'
import { clearSessionDay, ensureSessionDay, isSessionExpired, markSessionDay, readSessionDay } from '../lib/dailySession'
import { MISSED_CLOCK_IN_SHOWN_KEY } from '../lib/missedClockIn'
import { ANNOUNCEMENT_ALERT_SHOWN_KEY } from '../lib/announcementAlert'
import { HR_DOCUMENT_ALERT_SHOWN_KEY } from '../lib/hrDocumentAlert'

/** ล้างสถานะที่ควรอยู่แค่ช่วง session เดียว (ปลดล็อกหน้าแผน, popup เตือนลงเวลา/ประกาศ, โหมดมือถือ) */
function clearSessionScopedStorage() {
  try {
    sessionStorage.removeItem('plan_unlocked')
    sessionStorage.removeItem(MISSED_CLOCK_IN_SHOWN_KEY)
    sessionStorage.removeItem(ANNOUNCEMENT_ALERT_SHOWN_KEY)
    sessionStorage.removeItem(HR_DOCUMENT_ALERT_SHOWN_KEY)
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
  // กำลังบังคับออกจากระบบเพราะข้ามวัน — ระหว่างนี้ห้ามโหลด profile
  // (token ถูกล้างไปแล้ว query จะกลายเป็น anon → RLS คืน 0 แถว → alert ผิดๆ)
  const dailySignOutRef = useRef(false)
  // กัน alert เด้งซ้ำจาก event หลายทาง (alert เป็น blocking จึงกองคิวกันได้)
  const profileAlertShownRef = useRef(false)

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
      // ระหว่างบังคับออกจากระบบข้ามวัน event ที่ยังพก session เก่ามาให้ข้ามไป
      if (dailySignOutRef.current && session?.user) return
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
    if (dailySignOutRef.current) return
    dailySignOutRef.current = true
    clearSessionScopedStorage()
    setUser(null)
    // ล้างวันของ session เมื่อออกสำเร็จเท่านั้น — ถ้าเน็ตหลุด จะได้ลองใหม่ในรอบถัดไป
    supabase.auth
      .signOut()
      .then(({ error }) => {
        if (!error) clearSessionDay()
      })
      .catch(() => {})
      .finally(() => {
        dailySignOutRef.current = false
        setSupabaseUser(null)
        setLoading(false)
      })
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

  /** true = token ของ user คนนี้ยังอยู่จริง (ไม่ได้ถูกล้างไประหว่างทาง) */
  async function hasLiveSession(userId: string) {
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      return session?.user?.id === userId
    } catch {
      return false
    }
  }

  /**
   * มี session แต่มองไม่เห็นแถวตัวเองใน us_users — แยกให้ชัดว่าถูกระงับหรือไม่มี profile จริงๆ
   * แล้วเคลียร์ session ทิ้ง เพื่อไม่ให้ค้างและเด้งซ้ำทุกครั้งที่เปิดเว็บ
   */
  async function reportMissingProfile(userId: string) {
    console.warn('User row not visible in us_users. User ID:', userId)

    // is_current_user_active() เป็น SECURITY DEFINER จึงอ่านได้แม้ RLS ซ่อนแถวอยู่
    let deactivated = false
    try {
      const { data, error } = await supabase.rpc('is_current_user_active')
      if (!error) deactivated = data === false
    } catch {
      /* เรียกไม่ได้ → ถือว่าไม่ทราบสถานะ ใช้ข้อความทั่วไป */
    }

    clearSessionDay()
    clearSessionScopedStorage()
    await supabase.auth.signOut().catch(() => {})

    if (profileAlertShownRef.current) return
    profileAlertShownRef.current = true
    alert(
      deactivated
        ? 'บัญชีของคุณถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ'
        : 'ไม่พบข้อมูลผู้ใช้ในระบบ กรุณาเข้าสู่ระบบใหม่ หากยังพบปัญหาให้ติดต่อผู้ดูแลระบบ'
    )
  }

  async function loadUserData(userId: string) {
    try {
      console.log('Loading user data for userId:', userId)

      // token อาจถูกล้างไปแล้ว (บังคับ logout ข้ามวัน / signOut จากแท็บอื่น)
      // ถ้ายิง query ต่อจะกลายเป็น anon แล้วได้ 0 แถวจาก RLS → เข้าใจผิดว่าไม่มีข้อมูลผู้ใช้
      if (dailySignOutRef.current || !(await hasLiveSession(userId))) {
        setUser(null)
        setLoading(false)
        return
      }

      const { data, error } = await supabase
        .from('us_users')
        .select('*')
        .eq('id', userId)
        .single()

      if (error) {
        console.error('Error loading user data:', error)

        // PGRST116 = 0 แถว ซึ่งเกิดได้ทั้งจาก "ไม่มี profile จริงๆ",
        // "ถูกระงับจนมองไม่เห็นแถวตัวเองตาม RLS" และ "token หลุดระหว่างทาง"
        if (error.code === 'PGRST116') {
          if (await hasLiveSession(userId)) {
            await reportMissingProfile(userId)
          }
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
    // login รอบใหม่ → เปิดให้แจ้งเตือน profile ได้อีกครั้งถ้ายังมีปัญหาจริง
    profileAlertShownRef.current = false
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
