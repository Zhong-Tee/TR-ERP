import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import type { Session } from '@supabase/supabase-js'
import type { User } from '../types'
import { clearMobileModeStorage } from '../lib/mobileMode'

export function useAuth() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [supabaseUser, setSupabaseUser] = useState<Session['user'] | null>(null)
  const [mfaPending, setMfaPending] = useState(false)
  const [mfaFactorId, setMfaFactorId] = useState<string | null>(null)

  useEffect(() => {
    // ใช้ non-async callback เพื่อไม่ return Promise (ซึ่ง Supabase internals อาจตีความผิด)
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSupabaseUser(session?.user ?? null)
      if (session?.user) {
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

          try {
            const { data: authUser } = await supabase.auth.getUser()

            if (authUser?.user) {
              const { data: newUser, error: insertError } = await supabase
                .from('us_users')
                .insert({
                  id: userId,
                  username: authUser.user.email?.split('@')[0] || 'user',
                  role: 'store',
                })
                .select()
                .single()

              if (insertError) {
                console.error('Cannot auto-create user (RLS may be blocking):', insertError)
                alert('ไม่พบข้อมูลผู้ใช้ในระบบ กรุณาติดต่อผู้ดูแลระบบเพื่อเพิ่มข้อมูลผู้ใช้')
              } else {
                console.log('Auto-created user:', newUser)
                setUser(newUser as User)
                setLoading(false)
                return
              }
            }
          } catch (createError) {
            console.error('Error creating user:', createError)
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
    return data
  }

  async function signOut() {
    sessionStorage.removeItem('plan_unlocked')
    // ล้างโหมดมือถือ/PC Desktop ที่จำไว้ — ให้ login ครั้งถัดไปเริ่มจากหน้าเลือกโหมด
    clearMobileModeStorage()
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
