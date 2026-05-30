import { describe, expect, it } from 'vitest'
import { extractIccTextTag } from './iccTagScanner'

function fakeIccWithTextTag(signature: string, text: string): ArrayBuffer {
  const tagOffset = 144
  const payload = new TextEncoder().encode(text)
  const size = 8 + payload.length
  const bytes = new Uint8Array(tagOffset + size)
  const view = new DataView(bytes.buffer)
  view.setUint32(128, 1, false)
  bytes.set(
    [...signature].map((c) => c.charCodeAt(0)),
    132,
  )
  view.setUint32(136, tagOffset, false)
  view.setUint32(140, size, false)
  bytes.set(
    [...'text'].map((c) => c.charCodeAt(0)),
    tagOffset,
  )
  bytes.set(payload, tagOffset + 8)
  return bytes.buffer
}

describe('extractIccTextTag', () => {
  it('extracts ICC text tag payload by signature', () => {
    const buffer = fakeIccWithTextTag('targ', 'CGATS.17\nBEGIN_DATA')

    expect(extractIccTextTag(buffer, 'targ')).toContain('CGATS.17')
  })

  it('returns null when the tag is absent', () => {
    const buffer = fakeIccWithTextTag('desc', 'hello')

    expect(extractIccTextTag(buffer, 'targ')).toBeNull()
  })
})
