type ExpressReceiptNumberInlineProps = {
  value?: string | null
}

export default function ExpressReceiptNumberInline({ value }: ExpressReceiptNumberInlineProps) {
  const receiptNumber = value?.trim()
  if (!receiptNumber) return null

  return <span className="ml-1 text-green-700">- {receiptNumber}</span>
}
