export type VerificationChannelCarrier = {
  channel_code: string
  default_carrier?: string | null
  is_self_pickup?: boolean
}

function normalizeCarrier(value: string | null | undefined): string {
  return String(value || 'OTHER').trim().toUpperCase() || 'OTHER'
}

/**
 * The verification counter follows the carrier configured for the sales
 * channel.  The separate delivery-check carrier master is only for importing
 * physical-carrier files and must not replace this mapping.
 */
export function resolveVerificationCarrier(
  channelCode: string | null | undefined,
  channels: VerificationChannelCarrier[]
): string {
  const normalizedChannel = String(channelCode || '').trim().toUpperCase()
  const channel = channels.find(
    (item) => String(item.channel_code || '').trim().toUpperCase() === normalizedChannel
  )
  return normalizeCarrier(channel?.default_carrier)
}

export function listVerificationCarriers(channels: VerificationChannelCarrier[]): string[] {
  return Array.from(
    new Set(
      channels
        .filter((channel) => channel.is_self_pickup !== true)
        .map((channel) => normalizeCarrier(channel.default_carrier))
        .filter((carrier) => carrier !== 'SELF' && carrier !== 'SEFL')
    )
  ).sort((left, right) => left.localeCompare(right))
}
