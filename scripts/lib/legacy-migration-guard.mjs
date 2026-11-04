import {existsSync} from 'node:fs'

export function assertLegacyMigrationReplayAllowed(mode, baselineAdopted=existsSync(new URL('../../docs/production-baseline-2026-11-04.json',import.meta.url))) {
  if(baselineAdopted&&!['audit','inspect','verify'].includes(mode)) {
    throw new Error('Legacy migration replay is disabled after production baseline adoption. Create a new timestamped migration from the current schema; do not replay archived SQL.')
  }
}
