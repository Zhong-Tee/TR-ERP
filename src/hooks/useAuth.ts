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
  // รวม auth events/getSession ที่เกิดพร้อมกันให้ใช้ flow เดียว ป้องกันโหลด profile ซ้ำ
  const authFlowRef = useRef<{ userId: string; promise: Promise<void> } | null>(null)
  // สร้าง MFA challenge ล่วงหน้าระหว่างผู้ใช้กำลังกรอก OTP
  const mfaChallengeRef = useRef<{ factorId: string; promise: Promise<string> } | null>(null)

  useEffect(() => {
    let cancelled = false
    // ใช้ non-async callback เพื่อไม่ return Promise (ซึ่ง Supabase internals อาจตีความผิด)
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (cancelled) return
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
        void handleSessionWithMfaCheck(session)
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
        void handleSessionWithMfaCheck(session)
      } else {
        setUser(null)
        setMfaPending(false)
        setMfaFactorId(null)
        setLoading(false)
      }
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
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

  /** อ่านระดับ MFA จาก access token ในเครื่อง ไม่ต้องรอ network */
  function readSessionAal(session: Session): 'aal1' | 'aal2' | null {
    try {
      const payload = session.access_token.split('.')[1]
      if (!payload) return null
      const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
      const decoded = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')))
      return decoded?.aal === 'aal1' || decoded?.aal === 'aal2' ? decoded.aal : null
    } catch {
      return null
    }
  }

  function prepareMfaChallenge(factorId: string): Promise<string> {
    const existing = mfaChallengeRef.current
    if (existing?.factorId === factorId) return existing.promise

    const promise = supabase.auth.mfa.challenge({ factorId }).then(({ data, error }) => {
      if (error) throw error
      return data.id
    })
    mfaChallengeRef.current = { factorId, promise }
    void promise.catch(() => {
      if (mfaChallengeRef.current?.promise === promise) mfaChallengeRef.current = null
    })
    return promise
  }

  function handleSessionWithMfaCheck(session: Session): Promise<void> {
    const authUser = session.user
    const existing = authFlowRef.current
    if (existing?.userId === authUser.id) return existing.promise

    const promise = (async () => {
      // Supabase ใส่ factors มากับ auth user อยู่แล้ว บัญชีที่ไม่มี TOTP ไม่ต้องยิง MFA API เพิ่ม
      const verifiedTotp = authUser.factors?.find(
        (factor) => factor.factor_type === 'totp' && factor.status === 'verified',
      )

      if (verifiedTotp) {
        let currentAal = readSessionAal(session)
        if (currentAal === null) {
          try {
            const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
            currentAal = aal?.currentLevel === 'aal2' ? 'aal2' : 'aal1'
          } catch {
            currentAal = 'aal1'
          }
        }
        if (currentAal !== 'aal2') {
          setMfaPending(true)
          setMfaFactorId(verifiedTotp.id)
          setLoading(false)
          // ไม่ await: แสดงหน้า OTP ทันทีและเตรียม challenge เบื้องหลัง
          void prepareMfaChallenge(verifiedTotp.id).catch(() => {})
          return
        }
      }

      setMfaPending(false)
      setMfaFactorId(null)
      await loadUserData(authUser.id)
    })()

    authFlowRef.current = { userId: authUser.id, promise }
    void promise.finally(() => {
      if (authFlowRef.current?.promise === promise) authFlowRef.current = null
    })
    return promise
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
    // เปลี่ยนหน้าเป็น Login ทันที ไม่ให้ UI รอ logout request จาก server
    authFlowRef.current = null
    mfaChallengeRef.current = null
    setUser(null)
    setSupabaseUser(null)
    setMfaPending(false)
    setMfaFactorId(null)
    setLoading(false)

    const { error } = await supabase.auth.signOut({ scope: 'local' })
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
    const challengeId = await prepareMfaChallenge(mfaFactorId)
    try {
      const { error } = await supabase.auth.mfa.verify({
        factorId: mfaFactorId,
        challengeId,
        code,
      })
      if (error) throw error
    } finally {
      // OTP ครั้งถัดไปต้องใช้ challenge ใหม่
      mfaChallengeRef.current = null
    }
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
