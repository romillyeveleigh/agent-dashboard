import { describe, it, expect } from 'vitest'
import { parseEnvFile, serializeEnvFile } from '../env-file'

const SAMPLE = `# Header
# More header

# ─── Section ──
KEY_A=value-a
KEY_B="quoted value"
# trailing comment

KEY_C=
`

describe('parseEnvFile', () => {
  it('extracts keys with positions', () => {
    const map = parseEnvFile(SAMPLE)
    expect(map.get('KEY_A')?.value).toBe('value-a')
    expect(map.get('KEY_B')?.value).toBe('quoted value')
    expect(map.get('KEY_C')?.value).toBe('')
  })

  it('ignores comments and blank lines', () => {
    const map = parseEnvFile('# foo\n\nBAR=baz')
    expect(map.size).toBe(1)
    expect(map.get('BAR')?.value).toBe('baz')
  })

  it('handles inline comments on unquoted values', () => {
    const map = parseEnvFile('KEY=value # inline')
    expect(map.get('KEY')?.value).toBe('value')
  })

  it('preserves whitespace in quoted values', () => {
    const map = parseEnvFile('KEY=" hello world "')
    expect(map.get('KEY')?.value).toBe(' hello world ')
  })

  it('skips invalid key syntax', () => {
    const map = parseEnvFile('123BAD=x\nGOOD_1=y')
    expect(map.has('123BAD')).toBe(false)
    expect(map.get('GOOD_1')?.value).toBe('y')
  })
})

describe('serializeEnvFile', () => {
  it('replaces values in place, preserving comments', () => {
    const out = serializeEnvFile(SAMPLE, { KEY_A: 'new-a' }, [])
    expect(out).toContain('# Header')
    expect(out).toContain('KEY_A=new-a')
    expect(out).toContain('KEY_B="quoted value"')
  })

  it('appends new keys at end', () => {
    const out = serializeEnvFile('A=1\n', { B: '2' }, [])
    expect(out).toContain('A=1')
    expect(out).toContain('B=2')
  })

  it('removes unset keys', () => {
    const out = serializeEnvFile(SAMPLE, {}, ['KEY_B'])
    expect(out).not.toContain('KEY_B')
    expect(out).toContain('KEY_A=value-a')
  })

  it('quotes values with spaces', () => {
    const out = serializeEnvFile('K=', { K: 'two words' }, [])
    expect(out).toContain('K="two words"')
  })

  it('quotes values with hash', () => {
    const out = serializeEnvFile('K=', { K: 'foo#bar' }, [])
    expect(out).toContain('K="foo#bar"')
  })

  it('quotes values with leading/trailing whitespace', () => {
    const out = serializeEnvFile('K=', { K: ' x' }, [])
    expect(out).toContain('K=" x"')
  })

  it('escapes embedded quotes and backslashes', () => {
    const out = serializeEnvFile('K=', { K: 'a"b\\c' }, [])
    expect(out).toContain('K="a\\"b\\\\c"')
  })

  it('writes empty value without quotes', () => {
    const out = serializeEnvFile('K=existing', { K: '' }, [])
    expect(out).toContain('K=')
    expect(out).not.toContain('K=existing')
  })

  it('rejects newline in value', () => {
    expect(() => serializeEnvFile('', { K: 'a\nb' }, [])).toThrow(/newline/i)
  })

  it('rejects carriage return in value', () => {
    expect(() => serializeEnvFile('', { K: 'a\rb' }, [])).toThrow(/newline/i)
  })

  it('handles set + unset together', () => {
    const out = serializeEnvFile('A=1\nB=2\nC=3', { A: '10' }, ['B'])
    const map = parseEnvFile(out)
    expect(map.get('A')?.value).toBe('10')
    expect(map.has('B')).toBe(false)
    expect(map.get('C')?.value).toBe('3')
  })

  it('round-trips: value with simple chars stays unquoted', () => {
    const value = 'sk-ant-api03-abc123'
    const out = serializeEnvFile('K=', { K: value }, [])
    const map = parseEnvFile(out)
    expect(map.get('K')?.value).toBe(value)
  })

  it('round-trips: value with spaces survives quote-then-parse', () => {
    const value = 'a value with spaces'
    const out = serializeEnvFile('K=', { K: value }, [])
    const map = parseEnvFile(out)
    expect(map.get('K')?.value).toBe(value)
  })

  it('round-trips: value with backslash and quote', () => {
    const value = 'a\\b"c'
    const out = serializeEnvFile('K=', { K: value }, [])
    const map = parseEnvFile(out)
    expect(map.get('K')?.value).toBe(value)
  })
})
