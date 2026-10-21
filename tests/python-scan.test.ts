import { describe, expect, test } from 'claude-code/testing'
import { PYTHON } from '../flow/data/stacks/python'
import { parseDiff, scan, type ScanCtx } from '../hooks/flow-scan'
import { PYTHON_STACK } from '../hooks/stacks/python'
import { redShape } from '../hooks/stacks/python-red'
import { readPytestReport } from '../hooks/stacks/python-report'
import { importsOf, securityForced } from '../hooks/stacks/python-tests'
import { OUT_X1 } from './fixtures/junit-pytest'

/** One file's unified diff; lines start with '+', '-' or ' ' (context). */
function diff(path: string, lines: string[], kind: 'modified' | 'added' | 'deleted' = 'modified', start = 10): string {
  const a = kind === 'added' ? '/dev/null' : `a/${path}`, b = kind === 'deleted' ? '/dev/null' : `b/${path}`
  const minus = lines.filter(l => !l.startsWith('+')).length, plus = lines.filter(l => !l.startsWith('-')).length
  return [`diff --git a/${path} b/${path}`, ...(kind === 'added' ? ['new file mode 100644'] : kind === 'deleted' ? ['deleted file mode 100644'] : []), `--- ${a}`, `+++ ${b}`, `@@ -${start},${minus} +${kind === 'added' ? 1 : start},${plus} @@`, ...lines].join('\n')
}
const ctx = (over: Partial<ScanCtx> = {}): ScanCtx => ({ stack: PYTHON_STACK, frozen: ['docs/spec.md'], ...over })
const rules = (text: string, c = ctx()): string[] => scan(text, [], c).findings.map(f => `${f.kind}:${f.rule}:${f.sev}`).sort()
const added = (path: string, lines: string[]) => diff(path, lines.map(l => `+${l}`), 'added', 0)
const inTest = (lines: string[]) => rules(added('tests/test_a.py', lines))

describe('the Python scan: floor rules (R2 AC-PY-5, AC-STK-6)', () => {
  test('skips: pytest marks and calls, unittest decorators and skipTest; the word in a string or a comment is none', () => {
    for (const line of ['@pytest.mark.skip(reason="later")', '@pytest.mark.skipif(sys.platform == "win32", reason="x")', '@pytest.mark.xfail', 'pytest.skip("not now", allow_module_level=True)', 'np = pytest.importorskip("numpy")', '@unittest.skip("x")', '@unittest.expectedFailure', '@skipIf(True, "x")'])
      expect([line, inTest(['import pytest', line, 'def test_a():', '    assert f() == 1'])]).toEqual([line, ['FL:skip-or-only:HIGH']])
    expect(inTest(['class T(unittest.TestCase):', '    def test_a(self):', '        self.skipTest("x")'])).toEqual(['FL:skip-or-only:HIGH'])
    expect(inTest(['def test_a():', '    msg = "pytest.skip( is only text"  # and skip( in a comment', '    assert msg == f()'])).toEqual([])
  })

  test('a return that ends a test early or under a condition; a return in a helper or a fixture is fine', () => {
    expect(inTest(['def test_a():', '    return', '    assert f() == 1'])).toEqual(['FL:early-return:HIGH'])
    expect(inTest(['def test_a():', '    if os.name == "nt":', '        return', '    assert f() == 1'])).toEqual(['FL:conditional-return:HIGH'])
    expect(inTest(['def test_a():', '    if os.name == "nt": return', '    assert f() == 1'])).toEqual(['FL:conditional-return:HIGH'])
    expect(inTest(['def helper():', '    return 1', '@pytest.fixture', 'def thing():', '    return make()', 'def test_a(thing):', '    assert helper() == thing'])).toEqual([])
    expect(rules(added('tests/helpers.py', ['def test_like():', '    return']))).toEqual(['FL:early-return:MEDIUM'])
  })

  test('exits, trivial asserts; suppressions in comments only, not in a string', () => {
    expect(inTest(['def test_a():', '    sys.exit(0)'])).toEqual(['FL:exit-in-test:HIGH'])
    expect(inTest(['def test_a():', '    raise SystemExit'])).toEqual(['FL:exit-in-test:HIGH'])
    for (const line of ['    assert True', '    assert x == x', '    assert "always"', '    self.assertTrue(True)', '    self.assertEqual(y, y)'])
      expect([line, inTest(['def test_a():', '    x = f()', '    y = g()', line])]).toEqual([line, ['FL:trivial-assert:HIGH']])
    expect(inTest(['def test_a():', '    assert f() == 1', '    assert not f() == 2'])).toEqual([])
    expect(rules(added('src/a.py', ['import os  # noqa: F401', 'x: int = "s"  # type: ignore[assignment]', 'def g():  # pragma: no cover', '    pass']))).toEqual(['FL:suppression:HIGH', 'FL:suppression:HIGH', 'FL:suppression:HIGH'])
    expect(rules(added('src/a.py', ['MSG = "add # noqa to silence it"']))).toEqual([])
  })

  test('pytest hooks that can rewrite results or the report, in any Python file (S-5); the name in a docstring is none', () => {
    expect(rules(added('src/plugin.py', ['def pytest_runtest_makereport(item, call):', '    pass']))).toEqual(['FL:report-forcing:HIGH'])
    expect(rules(added('tests/conftest.py', ['@pytest.hookimpl(wrapper=True)', 'def pytest_runtest_call(item):', '    yield']))).toEqual(['FL:report-forcing:HIGH'])
    expect(inTest(['def test_a(record_xml_attribute):', '    assert f() == 1'])).toEqual(['FL:report-forcing:HIGH'])
    expect(inTest(['def test_a(capsys):', '    with capsys.disabled():', '        assert f() == 1'])).toEqual(['FL:report-forcing:HIGH'])
    expect(rules(added('src/a.py', ['"""pytest_terminal_summary is a hook name in a docstring"""']))).toEqual([])
  })

  test('selection filters added to pytest\'s options, and a lowered coverage threshold', () => {
    expect(rules(diff('pyproject.toml', ['-addopts = ["-ra"]', '+addopts = ["-ra", "-x"]']))).toEqual(['FL:test-filter:HIGH'])
    expect(rules(diff('setup.cfg', ['+addopts = -k "not slow" -p no:randomly']))).toEqual(['FL:test-filter:HIGH'])
    expect(rules(diff('pyproject.toml', ['+addopts = ["-ra", "--strict-markers"]']))).toEqual([])
    expect(rules(diff('pyproject.toml', ['-fail_under = 90', '+fail_under = 80']))).toEqual(['FL:coverage-lowered:HIGH'])
    expect(rules(diff('pyproject.toml', ['-fail_under = 80', '+fail_under = 90']))).toEqual([])
  })

  test('INJ in comments and strings: a protocol token is HIGH; prose that mentions skip is not (the TypeScript sample)', () => {
    expect(rules(added('src/a.py', ['# REVIEW-END abc']))).toEqual(['FL:injection:HIGH'])
    expect(rules(added('src/a.py', ['msg = "the email step will skip validation"', 'reviewers = [r for r in people if r.skip]']))).toEqual([])
  })

  test('a deleted test file; fewer test functions or assertions than the diff removes', () => {
    expect(rules(diff('tests/test_a.py', ['-def test_a():', '-    assert f() == 1'], 'deleted'))).toEqual(['FL:test-file-deleted:HIGH'])
    expect(rules(diff('tests/test_a.py', ['-def test_b():', '-    assert g() == 2', ' def test_a():', '     assert f() == 1']))).toEqual(['FL:test-removed:HIGH'])
    expect(rules(diff('tests/test_a.py', [' def test_a():', '-    assert f() == 1', '+    f()']))).toEqual(['FL:assertion-removed:HIGH'])
  })
})

describe('the Python scan: junk rules (R2 AC-STK-7)', () => {
  test('print outside tests and entrypoints; debugger calls anywhere; TODO in comments only', () => {
    expect(rules(added('src/pkg/a.py', ['def f():', '    print("debug")', '    return 1']))).toEqual(['J:debug-leftover:HIGH'])
    expect(inTest(['def test_a():', '    print("fine in a test")', '    assert f() == 1'])).toEqual([])
    expect(rules(added('src/pkg/__main__.py', ['print("usage")']))).toEqual([])
    expect(rules(added('scripts/run.py', ['print("usage")']))).toEqual([])
    expect(inTest(['def test_a():', '    breakpoint()', '    assert f() == 1'])).toEqual(['J:debug-leftover:HIGH'])
    expect(rules(added('src/a.py', ['import pdb', 'x = 1  # TODO remove', 'MASK = "(XXX) XXX-XXXX"']))).toEqual(['J:debug-leftover:HIGH', 'J:todo-marker:HIGH'])
    expect(rules(added('src/a.py', ['log("print( is text here")']))).toEqual([])
  })

  test('old junk is never reported: only added lines count; three commented-out lines are no rule for Python (not in the plan)', () => {
    expect(rules(diff('src/a.py', [' print("old")', '+x = 1']))).toEqual([])
    expect(rules(added('src/a.py', ['# x = f()', '# y = g(x)', '# return y']))).toEqual([])
  })
})

describe('the Python RED freeze (R2 AC-STK-5)', () => {
  const RED_TEST = ['from spikefix.core import total', 'import spikefix.core as core', 'def test_total():', '    assert total([1, 2]) == 3']
  const red = redShape(parseDiff(added('tests/test_total.py', RED_TEST)), ['tests/test_total.py'])
  const after = (lines: string[]) => rules(added('tests/test_total.py', lines), ctx({ red }))

  test('the RED lines kept as they were, with a new test after them: clean', () => {
    expect(red['tests/test_total.py']?.blocks).toHaveLength(1)
    expect(after([...RED_TEST, 'def test_more():', '    assert total([]) == 0'])).toEqual([])
  })

  test('a RED line changed, or a line inserted into a RED test: red-test-changed', () => {
    expect(after(RED_TEST.map(l => l.replace('== 3', '== 4')))).toEqual(['FL:red-test-changed:HIGH'])
    expect(after([...RED_TEST.slice(0, 3), '    total = lambda xs: 3', ...RED_TEST.slice(3)])).toEqual(['FL:red-test-changed:HIGH'])
  })

  test('a patch of what the RED file imports is HIGH wherever it is written; a mock of anything else inside a new test is MEDIUM', () => {
    expect(after([...RED_TEST, 'def test_more(monkeypatch):', '    monkeypatch.setattr(core, "total", lambda xs: 3)', '    assert total([]) == 3'])).toEqual(['FL:mock-after-red:HIGH'])
    expect(after([...RED_TEST, 'def test_more(monkeypatch):', '    monkeypatch.setattr("spikefix.core.total", lambda xs: 3)', '    assert total([]) == 3'])).toEqual(['FL:mock-after-red:HIGH'])
    expect(after([...RED_TEST, 'core.total = lambda xs: 3'])).toEqual(['FL:mock-after-red:HIGH'])
    expect(after([...RED_TEST, 'sys.modules["spikefix.core"] = fake'])).toEqual(['FL:mock-after-red:HIGH'])
    expect(after([...RED_TEST, 'def test_more():', '    clock = MagicMock()', '    assert total([clock.value]) is not None'])).toEqual(['FL:mock-after-red:MEDIUM'])
    expect(after([...RED_TEST, 'resp = client.patch("/items/1")'])).toEqual([]) // an HTTP client's patch is not a mock
  })

  test('a project module the RED file imports that gains a patch is reported at that module', () => {
    const lines = ['from tests.helpers import make', 'def test_total():', '    assert make() == 3']
    const helperRed = redShape(parseDiff(added('tests/test_total.py', lines)), ['tests/test_total.py'])
    const text = [added('tests/test_total.py', lines), added('tests/helpers.py', ['import spikefix.core', 'spikefix.core.total = lambda xs: 3', 'def make():', '    return 3'])].join('\n')
    expect(scan(text, [], ctx({ red: helperRed })).findings.filter(f => f.rule === 'mock-after-red').map(f => f.loc)).toEqual(['tests/helpers.py:2'])
  })
})

describe('the Python stack: the reach that forces a security review, and report forgery (R2 AC-STK-13)', () => {
  const forced = (line: string): boolean => securityForced(parseDiff(added('src/a.py', [line])), PYTHON)
  test('a changed Python file reaching processes, files, the network or the runner\'s inside forces Security: yes', () => {
    for (const line of ['import subprocess', 'os.system("ls")', 'open(path, "w").write(x)', 'Path(p).write_text("x")', 'import _pytest.junitxml', 'def pytest_configure(config):', 'atexit.register(f)', 'sys.modules["x"] = y', 'request.config.option.x = 1', 'importlib.import_module(name)', 'threading.Thread(target=f).start()', 'gc.get_objects()', 'frame = inspect.currentframe()', 'def __del__(self):'])
      expect([line, forced(line)]).toEqual([line, true])
    for (const line of ['total = sum(xs)', 'open(path).read()', 'logger.info("subprocess finished")']) expect([line, forced(line)]).toEqual([line, false])
  })

  test('a report rewritten to an empty suite while pytest\'s own summary stands is null, never a pass', () => {
    expect(readPytestReport('<testsuites><testsuite name="pytest" errors="0" failures="0" skipped="0" tests="0" /></testsuites>', { output: OUT_X1, stdout: OUT_X1 })).toBeNull()
  })
})

describe('the Python scan after the step-4 reviews: whole files, removed lines read as code, the forms each rule missed', () => {
  test('a hunk that starts inside a module docstring is read with the whole file: the skip after it is code', () => {
    const file = ['"""Module doc.', 'Column zero text line', '"""', 'import pytest', 'pytestmark = pytest.mark.skip', 'def test_a():', '    assert f() == 1']
    const text = diff('tests/test_a.py', [' Column zero text line', ' """', ' import pytest', '+pytestmark = pytest.mark.skip', ' def test_a():'], 'modified', 2)
    expect(rules(text, ctx({ texts: { 'tests/test_a.py': file.join('\n') } }))).toEqual(['FL:skip-or-only:HIGH'])
  })

  test('a text that is not the diff\'s new side makes the scan an error, never a clean scan', () => {
    const text = added('tests/test_a.py', ['def test_a():', '    assert f() == 1'])
    expect(scan(text, [], ctx({ texts: { 'tests/test_a.py': 'def test_a():\n    pytest.skip()\n' } })).status).toBe('error')
  })

  test('an assertion commented out or put in a string is an assertion removed; a test name in a removed docstring is no test', () => {
    expect(rules(diff('tests/test_a.py', [' class T(unittest.TestCase):', '     def test_a(self):', '         r = f()', '-        self.assertEqual(r, 5)', '+        # was self.assertEqual(r, 5)']))).toEqual(['FL:assertion-removed:HIGH'])
    expect(rules(diff('tests/test_a.py', [' def test_a():', '-    assert f() == 1', '+    s = """', '+    assert f() == 1', '+    """']))).toEqual(['FL:assertion-removed:HIGH'])
    const was = ['def test_a():', '    """Docs:', 'def test_b(): an example', '    """', '    assert f() == 1']
    const docs = diff('tests/test_a.py', [' def test_a():', '-    """Docs:', '-def test_b(): an example', '-    """', '     assert f() == 1'], 'modified', 1)
    expect(rules(docs, ctx({ before: { 'tests/test_a.py': was.join('\n') } }))).toEqual([])
    expect(rules(docs)).toEqual([]) // hunk by hunk, with the context's old numbers
  })

  test('a print or a debugger call in a comment or a docstring is no junk', () => {
    expect(rules(added('src/pkg/a.py', ['def f():', '    """Use it so:', '    >>> print(total)', '    """', '    # breakpoint()', '    return 1']))).toEqual([])
  })

  test('suppressions in any case and coverage\'s own spelling; filters in a bundle of flags, not in a comment line; a threshold commented out', () => {
    expect(rules(added('src/a.py', ['x = 1  # NOQA: E501', 'def g():  # PRAGMA: NO COVER', '    pass  # pragma no cover']))).toEqual(['FL:suppression:HIGH', 'FL:suppression:HIGH', 'FL:suppression:HIGH'])
    for (const line of ['addopts = "-xvs"', 'addopts = ["-qx"]', 'addopts = "-kfast"', 'addopts = "-vk slow"'])
      expect([line, rules(diff('pyproject.toml', [`+${line}`]))]).toEqual([line, ['FL:test-filter:HIGH']])
    expect(rules(diff('pyproject.toml', ['+addopts = "-rx -ra"', '+# run with -k to select one test']))).toEqual([])
    expect(rules(diff('pyproject.toml', ['-fail_under = 90', '+# fail_under = 99']))).toEqual(['FL:coverage-lowered:HIGH'])
  })

  test('trivial asserts on literals and in parentheses; a literal against another is none', () => {
    for (const line of ['    assert 1 == 1', '    assert "a" == "a"', '    assert (True)', "    assert 'x' is 'x', 'msg'"])
      expect([line, inTest(['def test_a():', line])]).toEqual([line, ['FL:trivial-assert:HIGH']])
    expect(inTest(['def test_a():', '    assert "a" == "b"', '    assert 1 == 2'])).toEqual([])
  })

  test('a skip raised by hand; a report hook assigned or wrapped with any true value; a variable named wrapper is none', () => {
    expect(inTest(['def test_a():', '    raise unittest.SkipTest("later")'])).toEqual(['FL:skip-or-only:HIGH'])
    expect(inTest(['def test_a():', '    raise pytest.skip.Exception("later")'])).toEqual(['FL:skip-or-only:HIGH'])
    expect(rules(added('tests/conftest.py', ['@pytest.hookimpl(hookwrapper=1)', 'def pytest_runtest_call(item):', '    yield']))).toEqual(['FL:report-forcing:HIGH'])
    expect(rules(added('tests/conftest.py', ['pytest_runtest_makereport = _impl']))).toEqual(['FL:report-forcing:HIGH'])
    expect(rules(added('src/deco.py', ['def deco(f):', '    wrapper = functools.wraps(f)(lambda *a: f(*a))', '    return wrapper']))).toEqual([])
  })

  test('hostile lines stay linear: a threshold key before a run of spaces, an import of many dots after many blank lines', () => {
    const t0 = Date.now()
    rules(diff('pyproject.toml', [`+fail_under${' '.repeat(50_000)}x`]))
    importsOf([...Array<string>(100_000).fill(''), `from ${'.'.repeat(50_000)}`])
    expect(Date.now() - t0).toBeLessThan(2000)
    expect([...importsOf(['import os; import sys as s', 'from a import (', '    x,', '    y as z)', 'from b import c, \\', '    d']).keys()]).toEqual(['os', 's', 'x', 'z', 'c', 'd'])
  })
})

describe('the Python RED freeze after the step-4 reviews', () => {
  const RED_TEST = ['from spikefix.core import total', 'import spikefix.core as core', 'def test_total():', '    assert total([1, 2]) == 3']
  const red = redShape(parseDiff(added('tests/test_total.py', RED_TEST)), ['tests/test_total.py'])
  const after = (lines: string[], c: Partial<ScanCtx> = {}) => rules(added('tests/test_total.py', lines), ctx({ red, ...c }))

  test('a RED test kept as a copy while a redefinition weakens it, moved under a class, or with a literal\'s spaces changed', () => {
    expect(after([...RED_TEST, 'def test_total():', '    assert total([1, 2]) is not None'])).toEqual(['FL:red-test-changed:HIGH'])
    expect(after([...RED_TEST.slice(0, 2), 'class _Hidden:', ...RED_TEST.slice(2).map(l => `    ${l}`)])).toEqual(['FL:red-test-changed:HIGH'])
    const fmt = ['from spikefix.core import fmt', 'def test_fmt():', '    assert fmt(1000) == "1  000"']
    const shape = redShape(parseDiff(added('tests/test_fmt.py', fmt)), ['tests/test_fmt.py'])
    expect(rules(added('tests/test_fmt.py', fmt.map(l => l.replace('1  000', '1 000'))), ctx({ red: shape }))).toEqual(['FL:red-test-changed:HIGH'])
  })

  test('an imported name bound again, a write to a namespace, the patch API under another name or over several lines: HIGH', () => {
    for (const lines of [
      ['total = lambda xs: 3'], ['from spikefix.fake import total'], ['globals()["total"] = lambda xs: 3'], ['core.__dict__["total"] = lambda xs: 3'],
      ['def test_more(monkeypatch):', '    mp = monkeypatch', '    mp.setattr(core, "total", lambda xs: 3)', '    assert total([]) == 3'],
      ['from unittest.mock import patch as p', 'def test_more():', '    with p.object(core, "total", return_value=3):', '        assert total([]) == 3'],
      ['def test_more(monkeypatch):', '    getattr(monkeypatch, "setattr")(core, "total", lambda xs: 3)', '    assert total([]) == 3'],
      ['def test_more(monkeypatch):', '    monkeypatch.setattr(', '        core,', '        "total", lambda xs: 3,', '    )', '    assert total([]) == 3'],
    ]) expect([lines[0], after([...RED_TEST, ...lines])]).toEqual([lines[0], ['FL:mock-after-red:HIGH']])
  })

  test('a new fixture\'s mock is MEDIUM; an HTTP client\'s patch and a new import of a new name are nothing', () => {
    expect(after([...RED_TEST, '@pytest.fixture', 'def repo():', '    return MagicMock()'])).toEqual(['FL:mock-after-red:MEDIUM'])
    expect(after([...RED_TEST, 'import json', 'import requests', 'def test_more(client):', '    resp = client.patch("/items/1", json={"a": 1})', '    requests.patch("https://x.test", json={})', '    assert resp.status_code == 200'])).toEqual([])
  })

  test('a test module the RED file imports by `from tests import helpers` is followed; a module under test that sets attributes is not', () => {
    const lines = ['from tests import helpers', 'import spikefix.core', 'def test_total():', '    assert helpers.make() == 3']
    const shape = redShape(parseDiff(added('tests/test_total.py', lines)), ['tests/test_total.py'])
    const helper = added('tests/helpers.py', ['import spikefix.core', 'spikefix.core.total = lambda xs: 3', 'def make():', '    return 3'])
    const src = added('src/spikefix/core.py', ['import config', 'config.debug = True', 'def total(xs):', '    setattr(config, "last", xs)', '    return sum(xs)'])
    const found = scan([added('tests/test_total.py', lines), helper, src].join('\n'), [], ctx({ red: shape })).findings.filter(f => f.rule === 'mock-after-red')
    expect(found.map(f => f.loc)).toEqual(['tests/helpers.py:2'])
  })
})

describe('the Python reach that forces a security review, after the step-4 reviews', () => {
  const forced = (line: string): boolean => securityForced(parseDiff(added('src/a.py', [line])), PYTHON)
  test('members taken by name, use sites of hashing and tokens, the builtins table, writes behind a nested call, SQL in strings', () => {
    for (const line of ['from os import system as s', 'from sys import modules, argv', 'from shutil import rmtree', 'from os import (', 'import os as o', 'digest = hashlib.md5(pw)', 'jwt.decode(t, options={"verify_signature": False})', '__builtins__["open"] = fake', 'open(os.path.join(d, "f"), "w")', 'Path(p).open("w")', 'q = f"SELECT * FROM t WHERE id = {uid}"', 'q = "SELECT * FROM t WHERE id = %s" % uid', '    SELECT * FROM t WHERE id = {uid}'])
      expect([line, forced(line)]).toEqual([line, true])
    for (const line of ['from os import path', 'from pathlib import Path', 'open(p, encoding="utf-8")', 'cur.execute("SELECT 1 FROM t WHERE id = ?", (uid,))'])
      expect([line, forced(line)]).toEqual([line, false])
  })
})

describe('the Python RED freeze after the step-4 re-review (each file read whole)', () => {
  const P = 'tests/test_total.py', PRE = ['from spikefix.core import total', 'import spikefix.core as core', '']
  const RED = ['def test_total():', '    assert total([1, 2]) == 3']
  const fileDiff = (pre: string[], lines: string[]) => diff(P, [...pre.map(l => ` ${l}`), ...lines.map(l => `+${l}`)], 'modified', 1)
  const shapeOf = (red: string[], pre = PRE) => redShape(parseDiff(fileDiff(pre, red)), [P], { [P]: [...pre, ...red].join('\n') })
  const later = (lines: string[], red = RED, pre = PRE) => rules(fileDiff(pre, lines), ctx({ red: shapeOf(red, pre), texts: { [P]: [...pre, ...lines].join('\n') } }))

  test('a RED test bound again (a later def however spelled, an assignment, a decorator put on it, its class twice) is changed', () => {
    expect(later([...RED, 'def test_total() -> None:', '    pass'])).toEqual(['FL:red-test-changed:HIGH'])
    expect(later([...RED, 'test_total = lambda: None'])).toEqual(['FL:red-test-changed:HIGH'])
    expect(later(['@(lambda f: lambda: None)', ...RED])).toEqual(['FL:red-test-changed:HIGH'])
    const cls = ['class TestTotal:', '    def test_total(self):', '        assert total([1, 2]) == 3']
    expect(later([...cls, 'class TestTotal:', '    def test_total(self):', '        assert True'], cls)).toEqual(['FL:red-test-changed:HIGH', 'FL:trivial-assert:HIGH'])
    expect(later([...RED, 'def test_more():', '    assert total([]) == 0'])).toEqual([])
  })

  test('a name imported before the feature bound again at the top (def, a block, a tuple, global): HIGH; a new import of a new name is not', () => {
    for (const lines of [['def total(xs):', '    return 3'], ['if True:', '    total = lambda xs: 3'], ['total, _ = (lambda xs: 3), 0'], ['def helper():', '    global total', '    total = lambda xs: 3']])
      expect([lines[0], later([...RED, ...lines])]).toEqual([lines[0], ['FL:mock-after-red:HIGH']])
    expect(later([...RED, 'import json', 'RESULT = total([1, 2])'])).toEqual([])
  })

  test('the patch API under an alias of patch.object, and the dunder setter: HIGH', () => {
    expect(later([...RED, 'from unittest import mock', 'po = mock.patch.object', 'def test_more():', '    po(core, "total", lambda xs: 3).start()', '    assert total([]) == 3'])).toEqual(['FL:mock-after-red:HIGH'])
    expect(later([...RED, 'core.__setattr__("total", lambda xs: 3)'])).toEqual(['FL:mock-after-red:HIGH'])
  })

  test('an edit to the first line of a string above the RED tests leaves them as they were (no false change)', () => {
    const pre = [...PRE, 'HELP = """Usage:', '  run it', '"""']
    const shape = shapeOf(RED, pre), now = ['from spikefix.core import total', 'import spikefix.core as core', '', 'HELP = """Usage (v2):', '  run it', '"""', ...RED]
    const text = diff(P, [' from spikefix.core import total', ' import spikefix.core as core', ' ', '-HELP = """Usage:', '+HELP = """Usage (v2):', '   run it', ' """', ...RED.map(l => `+${l}`)], 'modified', 1)
    expect(rules(text, ctx({ red: shape, texts: { [P]: now.join('\n') } }))).toEqual([])
  })

  test('a parameter or an attribute named wrapper is no report hook', () => {
    expect(rules(added('src/view.py', ['def render(wrapper=True):', '    return wrapper', 'class V:', '    def __init__(self):', '        self.wrapper = True']))).toEqual([])
  })
})

describe('the Python scan: the owner-approved rules of 2026-10-19', () => {
  test('pytest.exit in a test is an exit; the hooks that run the call or the protocol or see each report are report-forcing anywhere', () => {
    expect(inTest(['import pytest', 'def test_a():', '    pytest.exit("done", returncode=0)'])).toEqual(['FL:exit-in-test:HIGH'])
    for (const hook of ['def pytest_pyfunc_call(pyfuncitem):', 'def pytest_runtest_protocol(item, nextitem):', 'def pytest_runtest_logreport(report):'])
      expect([hook, rules(added('src/plugin.py', [hook, '    return True']))]).toEqual([hook, ['FL:report-forcing:HIGH']])
    expect(rules(added('src/plugin.py', ['s = "def pytest_pyfunc_call(x): in a string"']))).toEqual([])
    // the same hooks under another name (security review, step 6)
    expect(rules(added('tests/conftest.py', ['@pytest.hookimpl(specname="pytest_runtest_protocol")', 'def run_all(item, nextitem):', '    return True']))).toEqual(['FL:report-forcing:HIGH'])
    expect(rules(added('tests/conftest.py', ['def f(pyfuncitem):', '    return True', 'globals()["pytest_pyfunc_call"] = f']))).toEqual(['FL:report-forcing:HIGH'])
    expect(rules(added('src/a.py', ['# see pytest_pyfunc_call in the pytest docs', 'x = 1']))).toEqual([])
  })

  test('three comment lines in a row that read as code are commented-out code (MEDIUM); prose, directives and docstrings are not', () => {
    expect(rules(added('src/a.py', ['# x = compute(a)', '# if x:', '#     run(x)', 'y = 1']))).toEqual(['J:commented-code:MEDIUM'])
    expect(rules(added('src/a.py', ['# This module reads the draws.', '# Each draw has five numbers', '# and one special number', 'y = 1']))).toEqual([])
    expect(rules(added('src/a.py', ['#!/usr/bin/env python3', '# -*- coding: utf-8 -*-', '# type: ignore', 'y = 1']))).toEqual(['FL:suppression:HIGH'])
    expect(rules(added('src/a.py', ['"""Usage:', '# x = compute(a)', '# if x:', '#     run(x)', '"""']))).toEqual([])
    expect(rules(added('src/a.py', ['x = f(a)  # (a) = b', 'y = g(b)  # g(b)', 'z = h(c)  # [c]']))).toEqual([])
  })
})
