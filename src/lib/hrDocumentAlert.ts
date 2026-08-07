import type { HRCertificate, HRWarning } from '../types'

/** เตือนครั้งเดียวต่อรอบ login และล้างใน clearSessionScopedStorage ตอนออกจากระบบ */
export const HR_DOCUMENT_ALERT_SHOWN_KEY = 'tr-erp:hr-document-alert-shown'

export type PendingHRDocument =
  | { kind: 'warning'; item: HRWarning }
  | { kind: 'certificate'; item: HRCertificate }

export function pickPendingHRDocuments(
  warnings: HRWarning[],
  certificates: HRCertificate[],
): PendingHRDocument[] {
  return [
    ...warnings
      .filter((item) => item.status === 'issued' && !item.acknowledged_at)
      .map((item): PendingHRDocument => ({ kind: 'warning', item })),
    ...certificates
      .filter((item) => item.status === 'issued' && !item.acknowledged_at)
      .map((item): PendingHRDocument => ({ kind: 'certificate', item })),
  ].sort((a, b) => new Date(a.item.created_at).getTime() - new Date(b.item.created_at).getTime())
}
