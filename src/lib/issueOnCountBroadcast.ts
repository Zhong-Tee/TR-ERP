/** จำนวน Issue สถานะ On จาก TopBar (RPC เดียวกับแจ้งเตือน) — หน้าอื่นฟังได้โดยไม่ subscribe/query ซ้ำ */
export const ISSUE_ON_COUNT_EVENT = 'erp-issue-on-count'

let latestIssueOnCount: number | null = null
const issueOnCountListeners = new Set<() => void>()

export function dispatchIssueOnCount(count: number) {
  latestIssueOnCount = count
  issueOnCountListeners.forEach((listener) => listener())
  window.dispatchEvent(new CustomEvent(ISSUE_ON_COUNT_EVENT, { detail: { count } }))
}

/** คืนค่าล่าสุดสำหรับหน้าที่เพิ่ง mount หลัง TopBar ส่ง event ไปแล้ว */
export function getLatestIssueOnCount() {
  return latestIssueOnCount
}

/** Store กลางสำหรับ React เพื่อให้ Sidebar และ Plan อ่าน snapshot เดียวกันเสมอ */
export function getIssueOnCountSnapshot() {
  return latestIssueOnCount ?? 0
}

export function subscribeIssueOnCount(listener: () => void) {
  issueOnCountListeners.add(listener)
  return () => issueOnCountListeners.delete(listener)
}
