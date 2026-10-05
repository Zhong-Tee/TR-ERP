import type { HRCandidate, HRInterview, HRInterviewScore } from '../types'
export function scoringStage(iv: HRInterview, score?: HRInterviewScore): string {
  if (score?.recommendation === 'reject') return 'failed'
  if (score?.recommendation === 'maybe') return 'review'
  if (iv.followup_status === 'started') return 'started'
  if (iv.followup_status === 'declined') return 'declined'
  if (iv.followup_status === 'confirmed') return 'confirmed'
  if (!score) return 'pending'
  return 'passed'
}
export function isScoringInterview(iv: HRInterview): boolean {
  return iv.status === 'attended' || iv.status === 'completed'
}
export function possiblePreviousCandidates(candidates: HRCandidate[], first: string, last: string, phone: string): HRCandidate[] {
  const normalizedPhone = phone.replace(/\D/g, '')
  return candidates.filter(c => (normalizedPhone.length >= 9 && c.phone?.replace(/\D/g, '') === normalizedPhone)
    || (!!first.trim() && !!last.trim() && c.first_name.trim() === first.trim() && c.last_name.trim() === last.trim()))
}
