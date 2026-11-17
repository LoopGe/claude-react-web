import { describe, expect, it, vi } from 'vitest'
import { PortFrameSink } from './frame-sink-ipc.js'
import type { MessagePortMain } from 'electron'

function port() {
  return {
    sent: [] as string[],
    postMessage(data: string) { this.sent.push(data) },
    close: vi.fn(),
  }
}

describe('PortFrameSink queue ceiling', () => {
  it('delivers the observed 18M incident frame', () => {
    const p = port()
    const fatal = vi.fn()
    const sink = new PortFrameSink(p as unknown as MessagePortMain, fatal)
    const frame = 'x'.repeat(18_241_480)
    sink.sendRaw(frame, 'tasks-snapshot')
    expect(fatal).not.toHaveBeenCalled()
  })

  it('reports fatal only above 64M', () => {
    const p = port()
    const fatal = vi.fn()
    const sink = new PortFrameSink(p as unknown as MessagePortMain, fatal)
    sink.sendRaw('x'.repeat(64_000_001), 'message')
    expect(fatal).toHaveBeenCalledWith('overflow')
  })
})
