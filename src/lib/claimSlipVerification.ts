import { supabase } from './supabase'
import { uploadMultipleToStorage, verifyMultipleSlipsFromStorage } from './slipVerification'
import type { AmountStatus } from '../components/order/VerificationResultModal'

/** ผลตรวจสลิปของบิลเคลม (REQ) — ใช้แสดง VerificationResultModal เหมือนตรวจปกติ */
export type ClaimSlipVerifyResult = {
  passed: boolean
  totalFromSlips: number
  accountMatch: boolean | null
  bankCodeMatch: boolean | null
  amountStatus: AmountStatus
  errors: string[]
}

/** บัญชีรับโอนของช่องทาง (ตรรกะเดียวกับตรวจสลิปปกติใน OrderForm) */
async function loadBankSettingForChannel(
  channelCode: string | null,
): Promise<{ bankAccount?: string; bankCode?: string }> {
  try {
    if (channelCode) {
      const { data: bankChannels } = await supabase
        .from('bank_settings_channels')
        .select('bank_setting_id')
        .eq('channel_code', channelCode)
      const ids = (bankChannels || []).map((r: { bank_setting_id: string }) => r.bank_setting_id)
      if (ids.length > 0) {
        const { data: settings } = await supabase
          .from('bank_settings')
          .select('account_number, bank_code, is_active')
          .in('id', ids)
          .eq('is_active', true)
          .limit(1)
        if (settings && settings.length > 0) {
          return { bankAccount: settings[0].account_number, bankCode: settings[0].bank_code }
        }
      }
    }
    // Fallback: บัญชี active ใดก็ได้
    const { data: anyActive } = await supabase
      .from('bank_settings')
      .select('account_number, bank_code')
      .eq('is_active', true)
      .limit(1)
    if (anyActive && anyActive.length > 0) {
      return { bankAccount: anyActive[0].account_number, bankCode: anyActive[0].bank_code }
    }
  } catch (e) {
    console.warn('claimSlipVerification: load bank settings', e)
  }
  return {}
}

/**
 * แนบสลิปให้บิลเคลม (REQ): อัปโหลด → ตรวจผ่าน EasySlip API → กันสลิปซ้ำ →
 * บันทึกผลลง ac_verified_slips + ac_slip_verification_logs (โครงเดียวกับตรวจสลิปปกติ)
 * ไม่เปลี่ยนสถานะบิล — ผู้เรียกตัดสินใจจากผล passed
 */
export async function verifyAndSaveClaimSlips(params: {
  orderId: string
  billNo: string
  channelCode: string | null
  expectedAmount: number
  files: File[]
  verifiedBy: string | null
}): Promise<ClaimSlipVerifyResult> {
  const { orderId, billNo, channelCode, expectedAmount, files, verifiedBy } = params

  const storagePaths = await uploadMultipleToStorage(files, 'slip-images', `slip${billNo}`)

  const { bankAccount, bankCode } = await loadBankSettingForChannel(channelCode)

  const results = await verifyMultipleSlipsFromStorage(storagePaths, expectedAmount, bankAccount, bankCode)

  const slipUrls = storagePaths.map((storagePath) => {
    const [bucket, ...pathParts] = storagePath.split('/')
    const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(pathParts.join('/'))
    return urlData.publicUrl
  })

  const getSlipAmount = (r: {
    amount?: unknown
    easyslipResponse?: { data?: { amount?: { amount?: unknown } } } | null
  }): number => {
    const raw = r?.amount ?? r?.easyslipResponse?.data?.amount?.amount
    if (raw == null || raw === '') return 0
    const n = Number(raw)
    return Number.isFinite(n) ? n : 0
  }

  // กันสลิปซ้ำด้วย transRef — ซ้ำเมื่อพบในบิลอื่นที่ใช้งานสลิปไปแล้ว
  const SLIP_NOT_USED_STATUSES = ['รอลงข้อมูล', 'ลงข้อมูลผิด', 'ตรวจสอบไม่ผ่าน', 'ยกเลิก']
  const duplicateChecks = await Promise.all(
    results.map(async (r) => {
      const transRef = (r as { easyslipResponse?: { data?: { transRef?: string } } }).easyslipResponse?.data
        ?.transRef
      if (!transRef) return false
      const { data: dup } = await supabase
        .from('ac_verified_slips')
        .select('order_id, or_orders(status)')
        .eq('easyslip_trans_ref', transRef)
        .eq('is_deleted', false)
        .neq('order_id', orderId)
      return (dup || []).some((row) => {
        const st = (row as { or_orders?: { status?: string | null } | null }).or_orders?.status
        return st != null && !SLIP_NOT_USED_STATUSES.includes(st)
      })
    }),
  )

  const totalFromSlips = results.reduce((s, r) => s + getSlipAmount(r), 0)
  const isMultiSlip = storagePaths.length > 1
  const totalMatches = Math.abs(totalFromSlips - expectedAmount) <= 0.01

  const errors: string[] = []
  let accountMatch: boolean | null = null
  let bankCodeMatch: boolean | null = null

  const rows = results.map((r, idx) => {
    const res = r as {
      success?: boolean
      error?: string
      message?: string
      validationErrors?: string[]
      accountNameMatch?: boolean
      bankCodeMatch?: boolean
      amountMatch?: boolean
      easyslipResponse?: {
        data?: {
          transRef?: string
          date?: string
          receiver?: { bank?: { id?: string }; account?: { bank?: { account?: string } } }
        }
      } | null
    }
    const isDuplicate = duplicateChecks[idx]
    const slipErrors: string[] = []
    let validationStatus: 'pending' | 'passed' | 'failed' = 'pending'

    if (isDuplicate) {
      slipErrors.push('สลิปซ้ำ (พบในออเดอร์อื่น)')
      validationStatus = 'failed'
    } else if (res.success === true) {
      if (isMultiSlip) {
        const nonAmountErrors = (res.validationErrors || []).filter((e) => !/ยอดเงิน|amount/i.test(e))
        if (nonAmountErrors.length > 0) {
          slipErrors.push(...nonAmountErrors)
          validationStatus = 'failed'
        } else {
          validationStatus = totalMatches ? 'passed' : 'failed'
          if (!totalMatches) slipErrors.push('ยอดรวมสลิปไม่ตรงกับยอดบิลเคลม')
        }
      } else {
        validationStatus = 'passed'
      }
    } else {
      validationStatus = 'failed'
      const errs = isMultiSlip
        ? (res.validationErrors || []).filter((e) => !/ยอดเงิน|amount/i.test(e))
        : res.validationErrors || []
      slipErrors.push(...errs)
      if (slipErrors.length === 0 && res.error) slipErrors.push(res.error)
      else if (slipErrors.length === 0 && res.message) slipErrors.push(res.message)
    }

    if (res.accountNameMatch === false) accountMatch = false
    else if (res.accountNameMatch === true && accountMatch === null) accountMatch = true
    if (res.bankCodeMatch === false) bankCodeMatch = false
    else if (res.bankCodeMatch === true && bankCodeMatch === null) bankCodeMatch = true

    errors.push(...slipErrors)

    return {
      order_id: orderId,
      slip_image_url: slipUrls[idx],
      slip_storage_path: storagePaths[idx] || null,
      verified_amount: getSlipAmount(r),
      verified_by: verifiedBy,
      easyslip_response: res.easyslipResponse || null,
      easyslip_trans_ref: res.easyslipResponse?.data?.transRef || null,
      easyslip_date: res.easyslipResponse?.data?.date || null,
      easyslip_receiver_bank_id: res.easyslipResponse?.data?.receiver?.bank?.id || null,
      easyslip_receiver_account: res.easyslipResponse?.data?.receiver?.account?.bank?.account || null,
      is_validated: res.success !== undefined || isDuplicate,
      validation_status: validationStatus,
      validation_errors: slipErrors.length > 0 ? slipErrors : null,
      expected_amount: expectedAmount || null,
      expected_bank_account: bankAccount || null,
      expected_bank_code: bankCode || null,
      account_name_match: res.accountNameMatch ?? null,
      bank_code_match: res.bankCodeMatch ?? null,
      amount_match: isMultiSlip ? totalMatches : res.amountMatch ?? null,
    }
  })

  // Log ทุกครั้งที่ตรวจ (ทั้งผ่าน/ไม่ผ่าน) เหมือน flow ปกติ
  const logs = rows.map((row) => ({
    order_id: orderId,
    slip_image_url: row.slip_image_url,
    slip_storage_path: row.slip_storage_path,
    verified_by: verifiedBy,
    status: row.validation_status === 'passed' ? 'passed' : 'failed',
    verified_amount: row.verified_amount,
    error: row.validation_errors ? row.validation_errors.join(', ') : null,
    easyslip_response: row.easyslip_response,
  }))
  if (logs.length > 0) {
    const { error: logErr } = await supabase.from('ac_slip_verification_logs').insert(logs)
    if (logErr) console.warn('claimSlipVerification: insert logs', logErr)
  }

  const { error: insErr } = await supabase.from('ac_verified_slips').insert(rows)
  if (insErr) {
    console.error('claimSlipVerification: insert ac_verified_slips', insErr)
    throw new Error('บันทึกผลตรวจสลิปไม่สำเร็จ: ' + insErr.message)
  }

  const passed = rows.length > 0 && rows.every((r) => r.validation_status === 'passed')
  const amountStatus: AmountStatus = totalMatches
    ? 'match'
    : totalFromSlips > expectedAmount
      ? 'over'
      : totalFromSlips > 0
        ? 'under'
        : 'mismatch'

  return { passed, totalFromSlips, accountMatch, bankCodeMatch, amountStatus, errors: [...new Set(errors)] }
}
