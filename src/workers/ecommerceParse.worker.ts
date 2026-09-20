/// <reference lib="webworker" />

import { readEcommerceWorkbook } from '../lib/ecommerceReconciliation'

type ParseRequest = {
  buffer: ArrayBuffer
  platform: string
}

self.onmessage = (event: MessageEvent<ParseRequest>) => {
  try {
    self.postMessage({ type: 'stage', stage: 'parsing' })
    const parsed = readEcommerceWorkbook(event.data.buffer, event.data.platform)
    self.postMessage({ type: 'result', parsed })
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

export {}
