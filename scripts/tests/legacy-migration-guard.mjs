import assert from 'node:assert/strict'
import {assertLegacyMigrationReplayAllowed} from '../lib/legacy-migration-guard.mjs'
for(const mode of ['apply','rehearse','--repair-history','unknown'])assert.throws(()=>assertLegacyMigrationReplayAllowed(mode,true),/replay is disabled/)
for(const mode of ['audit','inspect','verify'])assert.doesNotThrow(()=>assertLegacyMigrationReplayAllowed(mode,true))
assert.doesNotThrow(()=>assertLegacyMigrationReplayAllowed('apply',false))
console.log('PASS: legacy apply/rehearse/repair blocked after baseline; read-only inspection remains available')
