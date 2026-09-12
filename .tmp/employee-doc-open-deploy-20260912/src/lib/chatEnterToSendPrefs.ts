/** จดจำ checkbox "Enter เพื่อส่งข้อความ" แยกตาม user (localStorage) */

const PREFIX = 'tr-erp:chat-enter-to-send:'

export type ChatEnterToSendScope = 'issue' | 'order-confirm'

function key(userId: string, scope: ChatEnterToSendScope) {
  return `${PREFIX}${scope}:${userId}`
}

export function getChatEnterToSendPref(userId: string | undefined, scope: ChatEnterToSendScope): boolean {
  if (!userId || typeof localStorage === 'undefined') return false
  try {
    const v = localStorage.getItem(key(userId, scope))
    if (v === null) return false
    return v === '1'
  } catch {
    return false
  }
}

export function setChatEnterToSendPref(userId: string, scope: ChatEnterToSendScope, value: boolean): void {
  try {
    localStorage.setItem(key(userId, scope), value ? '1' : '0')
  } catch {
    /* ignore quota / private mode */
  }
}
