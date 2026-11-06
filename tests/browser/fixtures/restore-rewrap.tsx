/// <reference lib="dom" />
/// <reference types="vite/client" />

import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MessageList } from '../../../src/components/MessageList'
import { DevTraceButton } from '../../../src/components/DevTraceButton'
import { shouldHideByDefault } from '../../../src/session-store/normalize'
import type { SdkMessage } from '../../../src/types'
import type { TranscriptItem } from '../../../src/session-store/types'
import '../../../src/styles.css'

function message(seq: number): TranscriptItem {
  const type = seq % 2 === 0 ? 'user' : 'assistant'
  const msg = {
    type,
    uuid: `row-${seq}`,
    message: {
      role: type,
      content: [{
        type: 'text',
        text: `Restore anchor ${seq}. ${'Rewrap geometry line. '.repeat(8)}`,
      }],
    },
  } as SdkMessage
  return { id: `row-${seq}`, msg, plainText: null, isCompactSummary: false, hiddenByDefault: shouldHideByDefault(msg) }
}

function RestoreRewrapFixture() {
  const [items, setItems] = useState<TranscriptItem[]>(() => Array.from({ length: 100 }, (_, index) => message(index + 10)))
  const [oldestSeq, setOldestSeq] = useState(10)
  const [width, setWidth] = useState(900)
  return (
    <div>
      <DevTraceButton />
      <button type="button" onClick={() => {
        setItems((current) => [...Array.from({ length: 5 }, (_, index) => message(index + 5)), ...current])
        setOldestSeq(5)
      }}>
        Prepend older rows
      </button>
      <button type="button" onClick={() => setWidth((current) => current === 900 ? 600 : 900)}>
        Narrow fixture
      </button>
      <div className="chat-messages-wrap" style={{ width, height: 700, transition: 'width 160ms' }} data-testid="restore-fixture" data-oldest-seq={oldestSeq} data-item-count={items.length}>
        <MessageList items={items} oldestSeq={oldestSeq} transcriptRevealKey="restore-rewrap" />
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<RestoreRewrapFixture />)
