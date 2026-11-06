import { describe, expect, it } from 'vitest'
import { fileHandleText, parseFileHandle, stripFileHandles } from './upload-handle'

const ref = {
  id: '8f1c2d34-0000-4000-8000-000000000001',
  name: 'report.pdf',
  size: 523001,
  digest: '4a7d1234abcdef',
}

describe('fileHandleText', () => {
  it('names the file, size, digest prefix, upload id, and read-only path', () => {
    const text = fileHandleText(ref, '/tmp/uploads/report.pdf')
    expect(text).toContain('File "report.pdf" (523001 bytes, sha256:4a7d1234, upload:8f1c2d34-0000-4000-8000-000000000001)')
    expect(text).toContain('"/tmp/uploads/report.pdf"')
    expect(text).toContain('Read that path with your file tools')
  })

  it('omits the digest segment when the uploader did not compute one', () => {
    const text = fileHandleText({ id: 'u1', name: 'a.bin', size: 3 }, '/tmp/a.bin')
    expect(text).toContain('File "a.bin" (3 bytes, upload:u1)')
    expect(text).not.toContain('sha256:')
  })

  it('escapes quotes in names and paths', () => {
    const id = '8f1c2d34-0000-4000-8000-000000000002'
    const text = fileHandleText({ id, name: 'a"b.txt', size: 1 }, '/tmp/a"b.txt')
    expect(parseFileHandle(text)).toMatchObject({
      attachment: { id, name: 'a"b.txt', size: 1 },
      path: '/tmp/a"b.txt',
    })
  })
})

describe('parseFileHandle', () => {
  it('round-trips the generated handle', () => {
    const text = fileHandleText(ref, '/tmp/uploads/report.pdf')
    expect(parseFileHandle(text)).toEqual({
      attachment: { id: ref.id, name: ref.name, size: ref.size },
      path: '/tmp/uploads/report.pdf',
    })
  })

  it('rejects ordinary user text', () => {
    expect(parseFileHandle('read the attached file')).toBeNull()
    expect(parseFileHandle('[File "x" not a handle]')).toBeNull()
  })
})

describe('stripFileHandles', () => {
  it('removes a handle appended after the user text', () => {
    const text = `look ${fileHandleText(ref, '/tmp/a.pdf')}`
    expect(stripFileHandles(text)).toBe('look')
  })

  it('removes every handle in one string', () => {
    const text = `${fileHandleText(ref, '/tmp/a.pdf')} ${fileHandleText({ ...ref, id: '8f1c2d34-0000-4000-8000-000000000006', name: 'b.pdf' }, '/tmp/b.pdf')} after`
    expect(stripFileHandles(text)).toBe('after')
  })

  it('leaves ordinary text untouched', () => {
    expect(stripFileHandles('  just text  ')).toBe('just text')
  })
})