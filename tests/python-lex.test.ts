import { describe, expect, test } from 'claude-code/testing'
import { codeOf, lexLine, lexLines, lexText } from '../hooks/stacks/python-lex'

const str = (text: string) => ({ text, comment: false })
const note = (text: string) => ({ text, comment: true })

describe('the Python lexer (R2 plan §4.2, step 3)', () => {
  test('comments and strings leave the code, which keeps a blank for each literal', () => {
    expect(lexLine(`x = 'a' + "b"  # note`, [])).toEqual({ parts: [str('a'), str('b'), note(' note')], code: 'x = "" + ""  ', state: [] })
    expect(codeOf("s = '#x'  # real")).toBe('s = ""  ')
    expect(codeOf("return'x'")).toBe('return""')
  })

  test('prefixes: raw, bytes, unicode, f and t, and the pairs Python allows; a word ending in one of their letters is code', () => {
    expect(codeOf(`a = r'\\d' + b'x' + Rb"y" + u'z' + br'\\w' + fR'{q}'`)).toBe('a = r"" + b"" + Rb"" + u"" + br"" + fR"" q ')
    expect(codeOf("bar = 'x'")).toBe('bar = ""')
    expect(lexLine(`x = 'it\\'s' + r"a\\"b"`, []).parts).toEqual([str("it\\'s"), str('a\\"b')])
    expect(codeOf('b"{x}"')).toBe('b""') // bytes have no fields
  })

  test('a triple-quoted string spans lines: its text is a literal, the code around it stays code', () => {
    const lexed = lexText(['x = """first', 'second " quote', 'end"""  # c', 'y = 1'])
    expect(lexed.map(l => l.code)).toEqual(['x = ""', '', '  ', 'y = 1'])
    expect(lexed.map(l => l.parts)).toEqual([[str('first')], [str('second " quote')], [str('end'), note(' c')], []])
  })

  test('f-strings (PEP 701): fields are code, with nested quotes, conversions, format specs and fields inside specs; doubled braces are text', () => {
    const l = lexLine(`f"{a!r:>{width}} {{x}} {d["k"]}"`, [])
    expect(l.code).toBe('f"" a width  d[""] ')
    expect(l.parts).toEqual([str('>'), str(' {{x}} '), str('k')])
    expect(l.state).toEqual([])
    expect(lexLine('f"{n:#x} {a != b}"', []).code).toBe('f"" n  a != b ')
    expect(codeOf('t"{x}"')).toBe('t"" x ') // template strings (3.14)
  })

  test('a field may span lines and hold a comment (PEP 701)', () => {
    const lexed = lexText(['x = f"""{', '  a  # inside', '}"""', 'z'])
    expect(lexed.map(l => l.code)).toEqual(['x = f"" ', '  a  ', ' ', 'z'])
    expect(lexed[1]?.parts).toEqual([note(' inside')])
  })

  test('a single-quoted string ends with its line unless a backslash carries it on; a new hunk starts in code', () => {
    expect(lexText(["x = 'abc", 'y = 1']).map(l => l.code)).toEqual(['x = ""', 'y = 1'])
    expect(lexText(["x = 'abc\\", "def'", 'z']).map(l => l.code)).toEqual(['x = ""', '', 'z'])
    expect(lexLines([{ n: 1, text: 'x = """open' }, { n: 5, text: 'y = 2' }]).map(l => l.code)).toEqual(['x = ""', 'y = 2'])
  })

  test('a CRLF line\'s backslash still carries a string on; `\\N{…}` in an f-string is text, not a field (code review, step 3)', () => {
    expect(lexText(["x = 'abc\\\r", "def'\r", 'z\r']).map(l => l.code)).toEqual(['x = ""', '', 'z'])
    expect(lexLine('f"a\\N{EM DASH}b{c}"', [])).toEqual({ parts: [str('a\\N{EM DASH}b')], code: 'f"" c ', state: [] })
  })

  test('a docstring is a literal, not a comment, and a def inside it is not code', () => {
    const lexed = lexText(['def f():', '    """def test_hidden(): x"""', '    return 1'])
    expect(lexed[1]).toEqual({ parts: [str('def test_hidden(): x')], code: '    ""' })
  })
})

describe('Python lexing after the step-4 reviews', () => {
  test('`\\N{` is no escape in a raw or a bytes string; in a raw f-string the brace opens a field', () => {
    expect(lexLine('_ = r"\\N{"; pytest.skip(); _ = "}"', []).code).toBe('_ = r""; pytest.skip(); _ = ""')
    expect(lexLine('_ = b"\\N{"; x()', []).code).toBe('_ = b""; x()')
    expect(lexLine('rf"\\N{x}"', []).code).toBe('rf"" x ')
  })

  test('a line full of `\\N{` lexes in linear time', () => {
    const t0 = Date.now()
    lexLine(`"${'\\N{'.repeat(100_000)}"`, [])
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})
