import { describe, expect, test } from 'claude-code/testing'
import { readJunit } from '../flow/junit'
import type { Report } from '../flow/parse'
import { CHARS, COLLECTION, INHERITED, MODULE_SKIP, RED, STRICT, SUBTESTS, UNIT, X1 } from './fixtures/junit-pytest'

const statusOf = (r: Report | null, id: string) => r?.tests.find(t => t.id === id)?.status
const COUNTS0 = 'errors="0" failures="0" skipped="0" tests="1"'
const doc = (body: string, attrs = COUNTS0) => `<?xml version="1.0" encoding="utf-8"?><testsuites name="pytest tests"><testsuite name="pytest" ${attrs} time="0.010">${body}</testsuite></testsuites>`
const PASS = '<testcase classname="tests.test_a" name="test_x" file="tests/test_a.py" line="1" time="0.000" />'

describe('readJunit on real pytest 9 reports (R2 AC-PY-2, spike P1)', () => {
  test('every status: setup and teardown errors fail, a failure with a teardown error is one failed test, skips, xfail, xpass, parametrize', () => {
    const r = readJunit(X1)
    expect(r?.counts).toEqual({ passed: 8, failed: 11, skipped: 5 })
    expect(r?.tests).toHaveLength(24)
    const want: Array<[string, string]> = [
      ['test_pass', 'passed'], ['test_error_setup', 'failed'], ['test_error_teardown', 'failed'], ['test_fail_and_teardown_error', 'failed'],
      ['test_skipped', 'skipped'], ['test_xfail', 'skipped'], ['test_xpass', 'passed'], ['test_xpass_strict', 'failed'],
      ['test_param[1-2]', 'passed'], ['test_param[3-5]', 'failed'], ['test_param_ids[AC-001 first]', 'passed'], ['TestGroup > test_method_fail', 'failed'],
    ]
    for (const [id, status] of want) expect([id, statusOf(r, id)]).toEqual([id, status])
    expect(r?.tests.filter(t => t.id === 'test_fail_and_teardown_error')).toHaveLength(1)
    expect(r?.tests.find(t => t.id === 'test_fail_assert')).toEqual({ file: 'tests/test_status.py', id: 'test_fail_assert', title: 'test_fail_assert', status: 'failed', message: 'assert 3 == 4' })
    expect(r?.tests.find(t => t.id === 'test_error_setup')?.message).toBe('failed on setup with "RuntimeError: setup broke"')
    expect(r?.collection).toEqual([])
  })

  test('a unittest class: the id carries the class, expectedFailure is skipped, a failed subTest fails the test', () => {
    const r = readJunit(UNIT)
    expect(r?.tests.map(t => [t.id, t.status])).toEqual([['TestU > test_bad', 'failed'], ['TestU > test_expected_failure', 'skipped'], ['TestU > test_ok', 'passed'], ['TestU > test_skip', 'skipped'], ['TestU > test_subtests', 'failed']])
    expect(r?.tests[0]).toMatchObject({ file: 'tests/test_unit.py', title: 'test_bad', message: 'AssertionError: 1 != 2' })
  })

  test('subtests: one failure element per failed subtest is one failed test; `tests` counts every subtest report', () => {
    const r = readJunit(SUBTESTS)
    expect(r?.tests.map(t => [t.file, t.id, t.status])).toEqual([['sub/test_sub.py', 'TestTwo > test_two_fail', 'failed'], ['sub/test_sub.py', 'test_fixture_subtests', 'failed'], ['sub/test_sub.py', 'test_fixture_all_pass', 'passed']])
  })

  test('collection errors: the file and the cause from the last E line, no test', () => {
    const r = readJunit(COLLECTION)
    expect(r?.tests).toEqual([])
    expect(r?.collection).toEqual([
      { file: 'red/test_red_module.py', message: "ModuleNotFoundError: No module named 'spikefix.newmod'" },
      { file: 'red/test_red_symbol.py', message: "ImportError: cannot import name 'missing_symbol' from 'spikefix.core' (/p/proj/src/spikefix/core.py)" },
      { file: 'red/test_red_syntax.py', message: 'SyntaxError: invalid syntax' },
    ])
  })

  test('the RED forms: collection errors beside failures in the call, each with its message', () => {
    const r = readJunit(RED)
    expect(r?.collection).toHaveLength(3)
    expect(r?.tests.map(t => [t.id, t.message])).toEqual([
      ['test_attr', "AttributeError: module 'spikefix.core' has no attribute 'missing_fn'"], ['test_inner_import', "ModuleNotFoundError: No module named 'spikefix.other'"], ['test_name', "NameError: name 'undefined_name' is not defined"],
    ])
  })

  test('escaped ids decode: the five entities, pytest\'s own escapes stay as written', () => {
    expect(readJunit(CHARS)?.tests.map(t => [t.id, t.status])).toEqual([
      ['test_ids[a<b&c"d]', 'passed'], ['test_ids[\\x1b[31mred\\x00z]', 'failed'], ['test_ids[\\xfcn\\xefcode\\u2713]', 'failed'], ['test_ids[x]]>y]', 'failed'],
    ])
  })

  test('xfail_strict: an xpass fails', () => {
    expect(statusOf(readJunit(STRICT), 'test_xpass')).toBe('failed')
    expect(readJunit(STRICT)?.counts).toEqual({ passed: 7, failed: 12, skipped: 5 })
  })

  test('a module skipped whole (importorskip, skip at module level) is one skipped test named after the module (GAP-R2-0.6-37)', () => {
    const r = readJunit(MODULE_SKIP)
    expect(r?.tests.map(t => [t.file, t.id, t.status])).toEqual([['tests/test_modskip.py', 'tests.test_modskip', 'skipped'], ['tests/test_modskip2.py', 'tests.test_modskip2', 'skipped'], ['tests/test_child.py', 'TestChild > test_own', 'passed']])
    expect(r?.counts).toEqual({ passed: 1, failed: 0, skipped: 2 }) // pytest's line: 1 passed, 2 skipped
    expect(r?.collection).toEqual([])
  })

  test('tests a class inherits from a class in another file give null until classnames map to the tree (GAP-R2-0.6-38)', () => {
    expect(readJunit(INHERITED)).toBeNull()
  })

  test('a long run of spaces in a collection error is read in linear time (step-2 security review)', () => {
    const line = `a${' '.repeat(1 << 20)}b`
    const text = doc(`<testcase classname="" name="tests.test_a" file="tests/test_a.py"><error message="collection failure">E   ${line}   </error></testcase>`, 'errors="1" failures="0" skipped="0" tests="1"')
    const start = Date.now()
    expect(readJunit(text)?.collection).toEqual([{ file: 'tests/test_a.py', message: line }])
    expect(Date.now() - start).toBeLessThan(1000)
  })
})

describe('readJunit is strict (R2 §3.3, S-14): anything outside what pytest writes is null', () => {
  test('the forms a valid report may take: a declaration or none, one suite as root, CDATA, properties and output ignored', () => {
    expect(readJunit(doc(PASS))?.counts).toEqual({ passed: 1, failed: 0, skipped: 0 })
    expect(readJunit(`<testsuite name="pytest" ${COUNTS0}>${PASS}</testsuite>`)?.tests).toHaveLength(1)
    const cdata = '<testcase classname="tests.test_a" name="test_x" file="tests/test_a.py" line="1"><failure message="boom"><![CDATA[a < b & c]]></failure><system-out>x</system-out></testcase>'
    expect(statusOf(readJunit(doc(`<properties><property name="k" value="v"/></properties>${cdata}`, 'errors="0" failures="1" skipped="0" tests="1"')), 'test_x')).toBe('failed')
    // 64 elements deep is the most: the two suite elements and 62 properties
    expect(readJunit(doc(`${'<properties>'.repeat(62)}${'</properties>'.repeat(62)}${PASS}`))?.tests).toHaveLength(1)
  })

  const SAME_MODULE = '<testcase classname="tests.a.b" name="test_x" file="tests/a/b.py" line="1" /><testcase classname="tests.a.b" name="test_x" file="tests/a.b.py" line="1" />'
  const bad: Array<[string, string]> = [
    ['a byte-order mark', `﻿${doc(PASS)}`],
    ['U+FFFD, where decoding met bytes that were not UTF-8', doc(PASS.replace('test_x', 'test_�'))],
    ['a UTF-16 file read as UTF-8 (its BOM bytes undecodable, a NUL after every ASCII character)', `��${[...doc(PASS)].join('\u0000')}`],
    ['a DOCTYPE', doc(PASS).replace('<testsuites', '<!DOCTYPE t [<!ENTITY e "x">]><testsuites')],
    ['a processing instruction', doc(PASS).replace('<testsuites', '<?pi x?><testsuites')],
    ['a comment', doc(PASS).replace('<testcase', '<!-- x --><testcase')],
    ['an entity other than the five', doc(PASS.replace('test_x', 'test_&e;'))],
    ['a bare ampersand', doc(PASS.replace('test_x', 'test_a&b'))],
    ['a numeric entity XML does not allow', doc(PASS.replace('test_x', 'test_&#0;'))],
    ['a raw control character', doc(PASS.replace('test_x', 'test_\u0007'))],
    ['an element left open', doc(PASS).replace('</testsuite>', '')],
    ['a close tag of another element', doc(PASS).replace('</testsuite>', '</testsuitez>')],
    ['an attribute given twice (record_xml_attribute)', doc(PASS.replace('line="1"', 'line="1" file="src/x.py"'))],
    ['text after the root', `${doc(PASS)}x`],
    ['a second root', `${doc(PASS)}<testsuites/>`],
    ['nesting deeper than 64', doc(`${'<properties>'.repeat(70)}${'</properties>'.repeat(70)}${PASS}`)],
    ['a self-closing element deeper than 64', doc(`${'<properties>'.repeat(62)}<property/>${'</properties>'.repeat(62)}${PASS}`)],
    ['an uppercase XML declaration', doc(PASS).replace('<?xml', '<?XML')],
    ['quotes that differ in the declaration', doc(PASS).replace('version="1.0"', `version="1.0'`)],
    ['an XML 1.1 declaration', doc(PASS).replace('version="1.0"', 'version="1.1"')],
    ['a no-break space in a tag (XML white space is space, tab and line ends)', doc(PASS.replace('<testcase classname', '<testcase classname'))],
    ['a byte-order mark after the root', `${doc(PASS)}﻿`],
    ['more than 16 Mi characters', `${doc(PASS)}${' '.repeat(16 * 1024 * 1024)}`],
    ['more than 400k elements (code review, step 3)', doc(`<properties>${'<property name="a" value="b"/>'.repeat(400_001)}</properties>${PASS}`)],
    ['failures that disagree with the elements', doc(PASS, 'errors="0" failures="1" skipped="0" tests="1"')],
    ['fewer tests than testcases', doc(PASS + PASS.replace('test_x', 'test_y'))],
    ['a count missing', doc(PASS, 'errors="0" failures="0" tests="1"')],
    ['one classname and name in two files', doc(SAME_MODULE, 'errors="0" failures="0" skipped="0" tests="2"')],
    ['an absolute file', doc(PASS.replace('tests/test_a.py', '/etc/test_a.py'))],
    ['a file with ..', doc(PASS.replace('file="tests/test_a.py"', 'file="tests/../test_a.py"'))],
    ['a classname outside its file', doc(PASS.replace('classname="tests.test_a"', 'classname="other.mod"'))],
    ['an element pytest does not write', doc(PASS.replace(' time="0.000" />', '><rerun /></testcase>'))],
    ['a collection error of another shape', doc('<testcase classname="" name="tests.test_a" file="tests/test_a.py" line="1"><error message="collection failure" /></testcase>', 'errors="1" failures="0" skipped="0" tests="1"')],
    ['a root that is not a test report', '<?xml version="1.0"?><html />'],
    ['not XML', '{"testResults": []}'],
  ]
  for (const [why, text] of bad) test(`null: ${why}`, () => expect(readJunit(text)).toBeNull())
})
