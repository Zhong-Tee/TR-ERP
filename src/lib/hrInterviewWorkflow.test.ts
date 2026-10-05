import { describe, expect, it } from 'vitest'
import { isScoringInterview, possiblePreviousCandidates, scoringStage } from './hrInterviewWorkflow'
import type { HRCandidate, HRInterview, HRInterviewScore } from '../types'
const interview = { status: 'attended' } as HRInterview
describe('HR interview workflow', () => {
  it('only admits attended and completed appointments to scoring', () => {
    for (const status of ['scheduled', 'no_show', 'cancelled', 'rescheduled', 'waiting_contact'] as HRInterview['status'][]) {
      expect(isScoringInterview({ ...interview, status })).toBe(false)
    }
    expect(isScoringInterview(interview)).toBe(true)
    expect(isScoringInterview({ ...interview, status: 'completed' })).toBe(true)
  })
  it('separates assessment, decisions and onboarding per appointment', () => {
    expect(scoringStage(interview)).toBe('pending')
    for (const [recommendation, stage] of [['hire', 'passed'], ['reject', 'failed'], ['maybe', 'review']] as const) {
      expect(scoringStage(interview, { recommendation } as HRInterviewScore)).toBe(stage)
    }
    expect(scoringStage({ ...interview, followup_status: 'confirmed' })).toBe('confirmed')
    expect(scoringStage({ ...interview, followup_status: 'started' })).toBe('started')
    expect(scoringStage({ ...interview, followup_status: 'declined' })).toBe('declined')
    expect(scoringStage({ ...interview, followup_status: 'confirmed' }, { recommendation: 'reject' } as HRInterviewScore)).toBe('failed')
  })
  it('finds previous candidates by complete name or normalized phone, not partial input', () => {
    const candidates = [{ first_name: 'สมชาย', last_name: 'ใจดี', phone: '081-234-5678' }] as HRCandidate[]
    expect(possiblePreviousCandidates(candidates, '', '', '0812345678')).toHaveLength(1)
    expect(possiblePreviousCandidates(candidates, 'สมชาย', 'ใจดี', '')).toHaveLength(1)
    expect(possiblePreviousCandidates(candidates, 'สมชาย', '', '081')).toHaveLength(0)
  })
})
