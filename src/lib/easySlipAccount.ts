export type EasySlipAccountDetails = {
  senderName: string | null
  senderAccount: string | null
  receiverName: string | null
  receiverAccount: string | null
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function accountName(owner: Record<string, unknown> | null): string | null {
  const account = record(owner?.account)
  const name = account?.name
  if (typeof name === 'string') return text(name)
  const names = record(name)
  return text(names?.th) || text(names?.en) || text(owner?.name)
}

function accountNumber(owner: Record<string, unknown> | null): string | null {
  const account = record(owner?.account)
  const bank = record(account?.bank)
  const proxy = record(account?.proxy)
  return text(bank?.account) || text(account?.account) || text(proxy?.account)
}

export function easySlipAccountDetails(
  response: unknown,
  fallbackReceiverAccount?: string | null,
): EasySlipAccountDetails {
  const data = record(record(response)?.data)
  const sender = record(data?.sender) || record(data?.from)
  const receiver = record(data?.receiver) || record(data?.to)
  return {
    senderName: accountName(sender),
    senderAccount: accountNumber(sender),
    receiverName: accountName(receiver),
    receiverAccount: accountNumber(receiver) || text(fallbackReceiverAccount),
  }
}

export function accountDisplay(name?: string | null, account?: string | null): string {
  return [name?.trim(), account?.trim()].filter(Boolean).join(' · ') || 'ไม่พบข้อมูลบัญชี'
}
