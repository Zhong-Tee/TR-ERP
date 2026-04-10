/** จำนวน Issue สถานะ On จาก TopBar (RPC เดียวกับแจ้งเตือน) — หน้าอื่นฟังได้โดยไม่ subscribe/query ซ้ำ */
export const ISSUE_ON_COUNT_EVENT = 'erp-issue-on-count'

export function dispatchIssueOnCount(count: number) {
  window.dispatchEvent(new CustomEvent(ISSUE_ON_COUNT_EVENT, { detail: { count } }))
}
