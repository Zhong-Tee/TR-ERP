import Papa from 'papaparse'

export type BankStatementTransaction = {
  sourceRowNumber: number
  transactionAt: string
  effectiveDate: string
  transactionType: string
  debitAmount: number
  creditAmount: number
  balance: number | null
  channel: string
  description: string
  sourceFingerprint: string
  rawData: string[]
}

export type ParsedBankStatement = {
  parserCode: 'kbank_savings_csv_v1'
  bankCode: '004'
  bankName: string
  accountNumber: string
  accountName: string
  statementReference: string
  periodStart: string
  periodEnd: string
  openingBalance: number | null
  closingBalance: number | null
  declaredCreditTotal: number | null
  declaredDebitTotal: number | null
  transactions: BankStatementTransaction[]
  warnings: string[]
}

function cell(row: string[] | undefined, index: number): string {
  return String(row?.[index] ?? '').trim()
}

export function normalizeBankAccount(value: string): string {
  return value.replace(/\D/g, '')
}

function parseMoney(value: string): number | null {
  const normalized = value.replace(/,/g, '').trim()
  if (!normalized) return null
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function toIsoDate(value: string): string | null {
  const match = value.trim().match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/)
  if (!match) return null
  const day = Number(match[1])
  const month = Number(match[2])
  let year = Number(match[3])
  if (year < 100) year += 2000
  if (year > 2400) year -= 543
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function findLabelValue(rows: string[][], label: string): string {
  for (const row of rows) {
    const index = row.findIndex((value) => String(value).trim() === label)
    if (index >= 0) {
      for (let cursor = index + 1; cursor < row.length; cursor += 1) {
        const value = cell(row, cursor)
        if (value) return value
      }
    }
  }
  return ''
}

function findLabelLastMoney(rows: string[][], label: string): number | null {
  for (const row of rows) {
    const index = row.findIndex((value) => String(value).trim() === label)
    if (index < 0) continue
    for (let cursor = row.length - 1; cursor > index; cursor -= 1) {
      const value = parseMoney(cell(row, cursor))
      if (value != null) return value
    }
  }
  return null
}

function statementPeriod(rows: string[][]): { start: string; end: string } | null {
  const raw = findLabelValue(rows, 'รอบระหว่างวันที่')
  const match = raw.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/)
  if (!match) return null
  const start = toIsoDate(match[1])
  const end = toIsoDate(match[2])
  return start && end ? { start, end } : null
}

function makeTransactionFingerprint(input: {
  accountNumber: string
  effectiveDate: string
  time: string
  transactionType: string
  debitAmount: number
  creditAmount: number
  balance: number | null
  channel: string
  description: string
  occurrence: number
}): string {
  return [
    normalizeBankAccount(input.accountNumber),
    input.effectiveDate,
    input.time,
    input.transactionType.trim(),
    input.debitAmount.toFixed(2),
    input.creditAmount.toFixed(2),
    input.balance == null ? '' : input.balance.toFixed(2),
    input.channel.trim(),
    input.description.trim(),
    String(input.occurrence),
  ].join('|')
}

export function parseBankStatementCsv(csvText: string): ParsedBankStatement {
  const parsed = Papa.parse<string[]>(csvText.replace(/^\uFEFF/, ''), { skipEmptyLines: false })
  if (parsed.errors.length > 0) {
    throw new Error(`อ่าน CSV ไม่สำเร็จ: ${parsed.errors[0].message}`)
  }

  const rows = parsed.data.map((row) => row.map((value) => String(value ?? '')))
  const signature = rows.slice(0, 4).flat().join(' ')
  if (!/K-DEPOSIT STATEMENT OF SAVING ACCOUNT/i.test(signature)) {
    throw new Error('ไฟล์นี้ยังไม่ใช่รูปแบบ Statement กสิกรที่ระบบรองรับ')
  }

  const accountNumber = findLabelValue(rows, 'เลขที่บัญชีเงินฝาก')
  const accountName = findLabelValue(rows, 'ชื่อบัญชี').split(/\r?\n/)[0]?.trim() || ''
  const statementReference = findLabelValue(rows, 'เลขที่อ้างอิง')
  const period = statementPeriod(rows)
  if (!accountNumber || !period) {
    throw new Error('ไม่พบเลขบัญชีหรือรอบวันที่ใน Statement')
  }

  const headerIndex = rows.findIndex((row) => cell(row, 1) === 'วันที่' && cell(row, 3) === 'รายการ')
  if (headerIndex < 0) throw new Error('ไม่พบหัวตารางรายการเดินบัญชี')

  let openingBalance: number | null = null
  let closingBalance: number | null = findLabelLastMoney(rows, 'ยอดยกไป')
  const declaredCreditTotal = findLabelLastMoney(rows, 'รวมฝากเงิน')
  const declaredDebitTotal = findLabelLastMoney(rows, 'รวมถอนเงิน')
  const occurrences = new Map<string, number>()
  const transactions: BankStatementTransaction[] = []

  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index]
    const date = toIsoDate(cell(row, 1))
    const time = cell(row, 2)
    const transactionType = cell(row, 3)
    const debitAmount = parseMoney(cell(row, 4)) ?? 0
    const creditAmount = parseMoney(cell(row, 6)) ?? 0
    const balance = parseMoney(cell(row, 8))
    const channel = cell(row, 10)
    const description = cell(row, 12)

    if (transactionType === 'ยอดยกมา') {
      openingBalance = balance
      continue
    }
    if (!date || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) continue
    if (debitAmount <= 0 && creditAmount <= 0) continue

    const occurrenceKey = [date, time, debitAmount.toFixed(2), creditAmount.toFixed(2), balance ?? '', channel, description].join('|')
    const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1
    occurrences.set(occurrenceKey, occurrence)
    const sourceFingerprint = makeTransactionFingerprint({
      accountNumber,
      effectiveDate: date,
      time,
      transactionType,
      debitAmount,
      creditAmount,
      balance,
      channel,
      description,
      occurrence,
    })

    transactions.push({
      sourceRowNumber: index + 1,
      transactionAt: `${date}T${time}:00+07:00`,
      effectiveDate: date,
      transactionType,
      debitAmount,
      creditAmount,
      balance,
      channel,
      description,
      sourceFingerprint,
      rawData: row,
    })
  }

  if (transactions.length === 0) throw new Error('ไม่พบรายการรับหรือจ่ายเงินใน Statement')
  if (closingBalance == null) closingBalance = transactions.at(-1)?.balance ?? null

  const warnings: string[] = []
  const calculatedCredit = transactions.reduce((sum, item) => sum + item.creditAmount, 0)
  const calculatedDebit = transactions.reduce((sum, item) => sum + item.debitAmount, 0)
  if (declaredCreditTotal != null && Math.abs(calculatedCredit - declaredCreditTotal) > 0.01) {
    warnings.push(`ยอดฝากรวมในหัวไฟล์ ${declaredCreditTotal.toFixed(2)} ไม่ตรงกับรายการ ${calculatedCredit.toFixed(2)}`)
  }
  if (declaredDebitTotal != null && Math.abs(calculatedDebit - declaredDebitTotal) > 0.01) {
    warnings.push(`ยอดถอนรวมในหัวไฟล์ ${declaredDebitTotal.toFixed(2)} ไม่ตรงกับรายการ ${calculatedDebit.toFixed(2)}`)
  }
  if (openingBalance != null && closingBalance != null) {
    const expectedClosing = openingBalance + calculatedCredit - calculatedDebit
    if (Math.abs(expectedClosing - closingBalance) > 0.01) {
      warnings.push(`ยอดคงเหลือควรเป็น ${expectedClosing.toFixed(2)} แต่หัวไฟล์ระบุ ${closingBalance.toFixed(2)}`)
    }
  }

  return {
    parserCode: 'kbank_savings_csv_v1',
    bankCode: '004',
    bankName: 'ธนาคารกสิกรไทย',
    accountNumber,
    accountName,
    statementReference,
    periodStart: period.start,
    periodEnd: period.end,
    openingBalance,
    closingBalance,
    declaredCreditTotal,
    declaredDebitTotal,
    transactions,
    warnings,
  }
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
