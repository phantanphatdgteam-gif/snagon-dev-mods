// The Python stack's data (R2 plan §4.2, spec §4.2): how S1 finds a project, the runners' output forms, what RED
// accepts, the package managers' domains and caches, publishing, and the patterns that force `Security: yes`. The forms
// come from real pytest 9.1, ruff 0.16 and mypy 2.4 output (spike P1, P2; tests/fixtures/junit-pytest.ts).
// Its code is hooks/stacks/python.ts; the credential files every stack hides are flow/data/common.ts.
import type { Stack } from '../types'

const PYPI = ['files.pythonhosted.org', 'pypi.org']

export const PYTHON: Stack = {
  id: 'python',
  detect: { files: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements*.txt', 'Pipfile'] },
  manifest: 'pyproject.toml',
  testRunners: ['pytest'],
  runnerPackages: {},
  // where pip, uv, poetry, pipenv and twine credentials sit in a project (`*`: any characters, security review step 3)
  authFiles: ['pip.conf', 'uv.toml', 'poetry.toml', 'pyproject.toml', 'requirements*.txt', 'constraints*.txt', 'Pipfile', '.pypirc'],
  ownsFile: '\\.pyi?$',
  // no build fixer of its own yet: the debugger until 0.7.0 composes one (GAP-R2-15)
  routing: { reviewer: 'python-reviewer', buildFixer: 'tdd-guide' },
  redTesting: { from: 'skill', name: 'python-testing', sections: ['pytest Fundamentals', 'Fixtures'] },
  exampleFiles: 'src/pkg/a.py, tests/test_a.py (new)',
  // RED reads a criterion id from a test's name (evalIdForms) and a Verification line fixes that name, so a planner that
  // names tests without the id leaves RED no way to pass (live run 2026-10-20: a RED round spent on it; owner decision)
  planRule: 'A test named in a Verification line carries its criterion id in its name as ac_001 (for example tests/test_a.py::test_ac_001_clamps_below), because the RED check reads the id from the test name, never from a docstring.',
  // pytest's per-test results come from its JUnit report; the summary line counts only a run the judge could not give
  // a report (P1: `=+ <items> in N.NNs =+`)
  counters: [{ runner: 'pytest', passed: '^=+ .*?\\b(\\d+) passed\\b', failed: '^=+ .*?\\b(\\d+) failed\\b', skipped: '^=+ .*?\\b(\\d+) skipped\\b' }],
  failures: [
    // ruff --output-format=concise: `path:line:col: CODE [*] message`, a syntax error `path:line:col: invalid-syntax: message`
    { runner: 'ruff', entry: '^(?<file>[^:\\s][^:]*):\\d+:\\d+: (?<rule>[A-Z]+[0-9]+|invalid-syntax):? (?:\\[\\*\\] )?(?<message>.+)$' },
    // mypy: `path:line[:col…]: error: message  [code]` (notes are not failures)
    { runner: 'mypy', entry: '^(?<file>[^:\\s][^:]*):\\d+(?::\\d+){0,3}: error: (?<message>.+?)(?:  \\[(?<rule>[a-z][\\w-]*)\\])?$' },
  ],
  red: {
    // pytest's rewritten assert (`assert 3 == 4`), unittest's AssertionError, and the pytest.raises and pytest.warns
    // expectations (GAP-R2-0.6-40)
    assertion: ['^\\s*assert\\b', '^\\s*AssertionError\\b', '^\\s*Failed: DID NOT (?:RAISE|WARN)\\b'],
    moduleNotFound: ["ModuleNotFoundError: No module named '(?<module>[\\w.]+)'"],
    // the error names the module, which RED reads (GAP-R2-0.6-43)
    missingExport: ["ImportError: cannot import name '(?<symbol>\\w+)' from '(?<module>[\\w.]+)'", "AttributeError: module '(?<module>[\\w.]+)' has no attribute '(?<symbol>\\w+)'"],
  },
  // AC-nnn in strings (parametrize ids), AC_nnn and ac_nnn in names (GAP-R2-0.6-1); group 1 is the number. A new
  // spelling also needs python-tests.ts's grep prefilter widened.
  evalIdForms: ['(?<![A-Za-z0-9])(?:AC[-_]|ac_)(\\d{3})(?!\\d)'],
  // pytest's id carries the parameter set after the name: `test_x[1-2]`
  paramIds: true,
  packageManagers: [
    { id: 'uv', lockfiles: ['uv.lock'], domains: PYPI, cacheDirs: ['~/.cache/uv'] },
    { id: 'poetry', lockfiles: ['poetry.lock'], domains: PYPI, cacheDirs: ['~/Library/Caches/pypoetry'] },
    { id: 'pip', lockfiles: ['requirements*.txt'], domains: PYPI, cacheDirs: ['~/Library/Caches/pip', '~/.cache/pip'] },
  ],
  publish: {
    tools: ['twine', 'uv', 'poetry', 'pdm', 'hatch', 'flit', 'python', 'python3'],
    subcommands: ['upload', 'publish'],
    prefixes: { python: ['-m', 'twine'], python3: ['-m', 'twine'] },
    // long forms only: the union applies them to every stack's tools, and npm's short flags take no value
    valueOptions: ['--repository', '--repository-url', '--index', '--publish-url', '--token', '--username', '--password', '--project', '--directory', '--config-file'],
    releaseTools: [],
  },
  registryAuthEnv: ['TWINE_PASSWORD', 'TWINE_USERNAME', 'UV_PUBLISH_TOKEN', 'UV_PUBLISH_PASSWORD', 'UV_PUBLISH_USERNAME', 'PDM_PUBLISH_PASSWORD', 'PDM_PUBLISH_USERNAME', 'FLIT_PASSWORD', 'FLIT_USERNAME', 'HATCH_INDEX_AUTH', 'HATCH_INDEX_USER'],
  // pip's, uv's and poetry's user config folders; ~/.pypirc and ~/.netrc are in COMMON_DENY_READ
  sandbox: { denyRead: ['~/.config/pip', '~/.pip', '~/Library/Application Support/pip', '~/.config/uv', '~/Library/Application Support/pypoetry', '~/.config/pypoetry'] },
  // read on every added or removed line of any Python file (plan §4.2 "runtime reach", AC-STK-13); each scan is bounded,
  // so a hostile line stays linear
  securityPatterns: [
    '\\b(?:import|from)\\s+(?:subprocess|socket|ctypes|pickle|marshal|shelve|requests|httpx|aiohttp|urllib3?|http\\.client|ftplib|smtplib|telnetlib|paramiko|hashlib|hmac|secrets|jwt|ssl|multiprocessing|threading|signal|atexit|weakref|gc|inspect|tempfile|importlib|builtins|_pytest)\\b',
    // a listed member taken by name from os, sys, shutil or yaml, and any parenthesised or renamed import of them
    '\\bfrom\\s+os\\s+import\\b[^#\\n]{0,300}\\b(?:system|popen|exec\\w*|spawn\\w*|fork|kill|_exit|environ|putenv|unsetenv|remove|unlink|rmdir|removedirs|rename|replace|chmod|chown|link|symlink|open|write|dup2?)\\b',
    '\\bfrom\\s+sys\\s+import\\b[^#\\n]{0,300}\\b(?:modules|exit|argv|__stdout__|__stderr__|settrace|setprofile)\\b',
    '\\bfrom\\s+shutil\\s+import\\b[^#\\n]{0,300}\\b(?:rmtree|move|copy\\w*|chown)\\b', '\\bfrom\\s+yaml\\s+import\\b[^#\\n]{0,300}\\b(?:load|unsafe_load|load_all)\\b',
    '\\bfrom\\s+(?:os|sys|shutil|yaml)\\s+import\\s*\\(', '\\bimport\\s+(?:os|sys|shutil)\\s+as\\b',
    '\\b(?:threading|multiprocessing|signal|atexit|weakref|gc|hashlib|hmac|secrets|jwt)\\s*\\.', '\\bdef\\s+__del__\\b', '\\binspect\\s*\\.\\s*currentframe\\b',
    '\\bdef\\s+pytest_\\w+', '\\b(?:capsys|capfd|pytestconfig|record_xml_attribute)\\b', '\\brequest\\s*\\.\\s*config\\b', '\\bpluginmanager\\b',
    '\\bsubprocess\\.', '\\bos\\.(?:system|popen|exec\\w*|spawn\\w*|fork|kill|_exit|environ|putenv|unsetenv|remove|unlink|rmdir|removedirs|rename|replace|chmod|chown|link|symlink|open|write|dup2?)\\b',
    '\\b(?:eval|exec|compile|__import__)\\s*\\(', '\\bpickle\\.', '\\byaml\\.(?:load|unsafe_load|load_all)\\s*\\((?![^)\\n]{0,300}SafeLoader)',
    '\\brequests\\.', '\\bhttpx\\.', '\\burllib\\.', '\\bsocket\\.', '\\bshutil\\.(?:rmtree|move|copy\\w*|chown)\\b',
    // open( with a write mode as a later argument or mode=, whatever the first argument holds; Path(…).open("w")
    "\\bopen\\s*\\([^\\n]{0,300}?,\\s*(?:mode\\s*=\\s*)?[rRbBuU]?['\"][rbt]*[wax+]", "\\.open\\s*\\(\\s*(?:mode\\s*=\\s*)?['\"][rbt]*[wax+]",
    '\\.(?:write_text|write_bytes|unlink|rmdir|rename|replace|chmod|symlink_to|hardlink_to|touch)\\s*\\(',
    '\\bsys\\.(?:modules|exit|argv|__stdout__|__stderr__|settrace|setprofile)\\b', '\\btempfile\\.', '\\bctypes\\b', '\\bimportlib\\b', '\\bbuiltins\\b', '__builtins__',
    // SQL built with an f-string, `%`, `+` or .format(: in the call, on the string's line, or a line of a multi-line one
    '\\bsqlite3\\b', '\\b(?:execute|executemany|raw)\\s*\\(\\s*f[\'"]', '\\b(?:execute|executemany)\\s*\\([^)\\n]{0,300}(?:%|\\+|\\.format\\()',
    "\\b(?:[rR]?[fF]|[fF][rR])['\"][^'\"\\n]{0,300}\\b(?:SELECT|INSERT|UPDATE|DELETE|select|insert|update|delete)\\b[^'\"\\n]{0,300}\\{",
    "['\"][^'\"\\n]{0,300}\\b(?:SELECT|INSERT|UPDATE|DELETE)\\b[^'\"\\n]{0,300}['\"]\\s*(?:%|\\+|\\.format\\s*\\()", '\\b(?:SELECT|INSERT|UPDATE|DELETE)\\b[^\'"\\n]{0,300}\\{[A-Za-z_]',
  ],
  testFiles: ['**/test_*.py', '**/*_test.py', '**/conftest.py', 'tests/**', 'test/**'],
  entrypoints: ['bin/', 'scripts/', '__main__.py', 'cli.py'],
  dependencyDirs: ['.venv', '.tox', '.nox'],
  // an entry is a folder (`name/`) or a name's ending (`*…`): a bare name matches nothing. `.coverage/` is pytest-cov's
  // data file `.coverage` (535 trial M-4: without it a run with coverage moved the ignored set, J ignored-set HIGH): the
  // folder form also matches a file of that name, and adds no folder to what the loadable scan leaves out, which skips
  // hidden folders already (`*.coverage` would have left out any ignored `x.coverage/conftest.py`: review of M-4).
  // `.hypothesis/` and `__pycache__/` are the test run's own caches at any depth (535 trial 2, M-6: the baseline's pytest
  // made them, J ignored-set HIGH); the loadable scan leaves both out already (a hidden folder; python-sources' SKIP)
  buildOutputs: ['build/', 'dist/', 'htmlcov/', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/', '*.egg-info', '.coverage/', '.hypothesis/', '__pycache__/'],
  // GAP-R2-0.6-11; `__pycache__` is left out too (the judge reads bytecode from its own PYTHONPYCACHEPREFIX)
  loadable: ['*.py', '*.pyc', '*.pyo', '*.so', '*.dylib', '*.pth', 'conftest.py', 'sitecustomize.py', 'usercustomize.py'],
  loopbackPorts: [],
  filterFlag: { pytest: '-k' },
}
