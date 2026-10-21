import { describe, expect, test } from 'claude-code/testing'
import { lexParts, codeOf, placeOf, openerAt, deadCodeAfter, normCalls, TEST_START, depth } from '../hooks/stacks/typescript-lex'

const k = (texts: string[], start = 10) => texts.map((text, i) => ({ n: start + i, text }))

describe('flow js lexing', () => {
  test('comments, strings, templates and regex literals are told apart from code', () => {
    const l = lexParts("const q = /'/; const p = process; p.exit(0); const z = 'x' // done", 'code')
    expect(l.code).toContain('p.exit(0)')
    expect(l.parts.map(p => [p.text, p.comment])).toEqual([["'", false], ['x', false], [' done', true]])
    expect(codeOf('const t = `a ${process.exit(0)} b`')).toContain('process.exit(0)')
    expect(codeOf("it('should process a refund', () => {}) /* process */")).not.toContain('process')
    expect(lexParts('/* start', 'code').state).toBe('block')
    expect(lexParts('still inside */ x()', 'block')).toMatchObject({ code: ' x()', state: 'code' })
    expect(lexParts('const x = a / b / c', 'code').code).toBe('const x = a / b / c')
    expect(lexParts('x => /a\\/b[/]/g.test(x)', 'code').code).not.toContain('a\\/b')
    expect(lexParts('const s = `open', 'code').state).toBe('tpl')
    expect(lexParts("if (ok) /'/.test(s); process.on('exit', f); const z = 'x'", 'code').code).toContain('process.on')
  })

  test('depth counts brackets outside strings, comments and regex literals', () => {
    expect([depth("it('x (', () => {"), depth('})'), depth('const re = /[(]/; f('), depth('a = b // (')]).toEqual([2, -2, 1, 0])
  })

  test('where a line sits: a test, a suite, another function, inside control flow, or unknown', () => {
    expect(placeOf(k(["it('x', () => {", '  expect(a).toBe(1)', '  return']), 2)).toEqual({ fn: 'test', nested: false })
    expect(placeOf(k(["it('x', () => {", '  if (!ready) {', '    return']), 2)).toEqual({ fn: 'test', nested: true })
    expect(placeOf(k(["it('x', () => {", '  try {', '    x()', '  } catch {', '    return']), 4)).toEqual({ fn: 'test', nested: true })
    expect(placeOf(k(["it('x', () => {", '  const o = {', '    a: 1,', '  }', '  return']), 4)).toEqual({ fn: 'test', nested: false })
    expect(placeOf(k(["describe('s', () => {", '  if (!db) return']), 1)).toEqual({ fn: 'suite', nested: false })
    expect(placeOf(k(["it('x', () => {", '  if (x) items.forEach(i => {', '    return']), 2)).toEqual({ fn: 'other', nested: false })
    expect(placeOf(k(['test.each`', '  a | b', '  ${1} | ${2}', "`('AC-001 $a', ({ a, b }) => {", '  return']), 4)).toEqual({ fn: 'test', nested: false })
    expect(placeOf(k(['describe.each`', '  a', '  ${1}', "`('s $a', ({ a }) => {", '  return']), 4)).toEqual({ fn: 'suite', nested: false })
    expect(placeOf(k(['test.afterEach(async ({ page }, info) => {', '  if (x) return']), 1)).toEqual({ fn: 'other', nested: false })
    expect(placeOf(k(["test.step('open', async () => {", '  return']), 1)).toEqual({ fn: 'other', nested: false })
    expect(placeOf(k(["test.describe('s', () => {", '  if (x) return']), 1)).toEqual({ fn: 'suite', nested: false })
    expect(placeOf(k(['get.mockImplementation((id) => {', '  if (!id) return']), 1)).toEqual({ fn: 'other', nested: false })
    expect(placeOf(k(["it('x', async ({", '  page,', '}) => {', '  return']), 3)).toEqual({ fn: 'test', nested: false })
    expect(placeOf(k(["it .failing('x', () => {", '  return']), 1)).toEqual({ fn: 'test', nested: false })
    expect(placeOf(k(['  expect(a).toBe(1)', '  return']), 1)).toEqual({ fn: 'unknown', nested: false })
    expect(placeOf([{ n: 1, text: 'x()' }, { n: 2, text: 'return' }], 1)).toEqual({ fn: 'other', nested: false })
    expect(placeOf([{ n: 10, text: "it('x', () => {" }, { n: 12, text: '  return' }], 1)).toEqual({ fn: 'unknown', nested: false })
  })

  test('the line that opens the block holding a line: its index, -1 at the top of the file, undefined out of view', () => {
    expect(openerAt(k(["it('x', () => {", '  if (a) {', '    expect(x).toBe(1)']), 2)).toBe(1)
    expect(openerAt(k(["it('x', () => {", '  const o = { a: 1 }', '  expect(x).toBe(1)']), 2)).toBe(0)
    expect(openerAt([{ n: 1, text: 'x()' }, { n: 2, text: 'expect(a).toBe(1)' }], 1)).toBe(-1)
    expect(openerAt(k(['  y()', '  expect(a).toBe(1)']), 1)).toBeUndefined()
  })

  test('code after a return in the same block is dead; a promise chain, a comment or the block end is not', () => {
    expect(deadCodeAfter(k(['  return compute()', '  expect(a).toBe(1)', '})']), 0)).toBe(true)
    expect(deadCodeAfter(k(['  return fetchData().then(data => {', "    expect(data).toBe('pb')", '  })', '})']), 0)).toBe(false)
    expect(deadCodeAfter(k(['  return request(app)', "    .get('/users')", '    .expect(200)', '})']), 0)).toBe(false)
    expect(deadCodeAfter(k(['  return x', '  // done', '})']), 0)).toBe(false)
    expect(deadCodeAfter(k(['  return x', '  // done', '  y()']), 0)).toBe(true)
    expect(deadCodeAfter(k(['  return x']), 0)).toBe(false)
  })

  test('the test API is read through spaces, optional chaining and comments', () => {
    expect(['it .failing(', 'it?.failing(', 'it/**/.failing(', 'test . only ('].map(normCalls)).toEqual(['it.failing(', 'it.failing(', 'it.failing(', 'test.only ('])
    expect([TEST_START.test("it .failing('a', () => {"), TEST_START.test("it?.only('a', () => {"), TEST_START.test("const r = /^a/.test('abc')")]).toEqual([true, true, false])
  })
})
