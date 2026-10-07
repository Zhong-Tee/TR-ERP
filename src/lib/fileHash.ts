import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex } from '@noble/hashes/utils'

/** Keep duplicate-file fingerprints identical without requiring Web Crypto. */
export function sha256BytesHex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes))
}
