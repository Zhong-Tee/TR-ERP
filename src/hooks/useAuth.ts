import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import type { Session } from '@supabase/supabase-js'
import type { User } from '../types'

export function useAuth() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [supabaseUser, setSupabaseUser] = useState<Session['user'] | null>(null)

  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSupabaseUser(session?.user ?? null)
      if (session?.user) {
        loadUserData(session.user.id)
      } else {
        setLoading(false)
      }
    })

    // Listen for auth changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSupabaseUser(session?.user ?? null)
      if (session?.user) {
        loadUserData(session.user.id)
      } else {
        setUser(null)
        setLoading(false)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

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
        console.error('Error code:', error.code)
        console.error('Error message:', error.message)
        
        // ถ้าไม่พบ user ใน us_users
        if (error.code === 'PGRST116') {
          console.warn('User not found in us_users table. User ID:', userId)
          console.warn('Please add this user to us_users table in Supabase Dashboard')
          
          // ลองสร้าง user อัตโนมัติ (ถ้า RLS อนุญาต)
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
    const { error } = await supabase.auth.signOut()
    if (error) {
      // Session หมดอายุหรือหายไปแล้ว → ล้าง state แล้ว redirect ได้เลย
      if (error.message?.includes('session missing') || error.message?.includes('Session')) {
        setUser(null)
        setSupabaseUser(null)
        return
      }
      throw error
    }
  }

  return {
    user,
    supabaseUser,
    loading,
    signIn,
    signOut,
  }
}
