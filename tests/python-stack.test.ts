import { describe, expect, test } from 'claude-code/testing'
import { PYTHON } from '../flow/data/stacks/python'
import { readJunit } from '../flow/junit'
import { classify } from '../flow/parse'
import { judgeRun, redCheck, reportSignatures } from '../hooks/flow-judge'
import { gitPaths, ignoredSet } from '../hooks/flow-git'
import { ignoredSkip } from '../hooks/flow-baseline'
import { forgetFlowCaches } from '../hooks/flow-host'
import { detectSetup, setupEcho, URL_AUTH_SCRIPT } from '../hooks/flow-setup'
import { parseDiff, type DiffFile } from '../hooks/flow-scan'
import { PYTHON_STACK } from '../hooks/stacks/python'
import { addoptsIn, authEnvNames, configFor, configOptions, hasAuth, judgedArgv, judgeEnv, proposeCommands, runnerOf, urlEnvNames, weakFlags } from '../hooks/stacks/python-commands'
import { pytestSummary, readPytestReport } from '../hooks/stacks/python-report'
import { addedTests, declChanges, evalIdsInTests, importsOf, moduleFiles, resolveImport } from '../hooks/stacks/python-tests'
import { cmdSourceVerdict, commandSources } from '../hooks/stacks/python-sources'
import { baseLibraries, pthImports, pthPaths, pytest11Of, venvRebaseBlock } from '../hooks/stacks/python-runner'
import { judgedBlock, judgedRun, sourcesDrift } from '../hooks/flow-run'
import { RUN_MARKER_VAR } from '../hooks/flow-reap'
import { activeRecord, fakeHost, ROOT, type FakeOpts } from './flow-fakes'
import { GIT } from './flow-drive'
import { MODULE_SKIP, OUT_MODULE_SKIP, OUT_RED, OUT_STRICT, OUT_SUBTESTS, OUT_X1, RED, STRICT, SUBTESTS_RUN, X1 } from './fixtures/junit-pytest'

/** Repo 535's pyproject.toml on loop/v1 (360897f). */
const PYPROJECT_535 = `[project]
name = "lotto535"
version = "0.1.0"
requires-python = ">=3.12"
license = "MIT"
dependencies = ["numpy>=2.5,<3", "pydantic>=2.13,<3", "scikit-learn>=1.9,<2",
                "scipy>=1.18,<2"]

[project.optional-dependencies]
lightgbm = ["lightgbm>=4.7,<5"]

[dependency-groups]
dev = ["hypothesis>=6.168", "mypy>=2.4", "pytest>=9.1", "pytest-cov>=7.1",
       "ruff>=0.16", "scipy-stubs>=1.18"]

[build-system]
requires = ["uv_build>=0.12.23,<0.13.0"]
build-backend = "uv_build"

[tool.ruff]
line-length = 100
[tool.ruff.lint]
extend-select = ["NPY"]

[tool.mypy]
files = ["src", "tests"]
strict = true
plugins = ["pydantic.mypy"]
[[tool.mypy.overrides]]
module = ["sklearn.*"]
ignore_missing_imports = true

[tool.pytest]
minversion = "9.1"
strict = true
testpaths = ["tests"]
addopts = ["-ra"]
filterwarnings = ["error"]
`
const ARGS = { overrides: {}, tools: [], mcp: [] }
const pyHost = (files: Record<string, string>, o: FakeOpts = {}) => { forgetFlowCaches(); return fakeHost({ gitOut: { ...GIT }, ...o, files }) }
const added = (path: string, lines: readonly string[], minus: readonly string[] = []): DiffFile => ({
  path, status: 'modified', lines: [...minus.map((text, n) => ({ kind: '-' as const, n: n + 1, text })), ...lines.map((text, n) => ({ kind: '+' as const, n: n + 1, text }))],
})
const run = (stdout: string, stderr = '') => ({ output: [stdout, stderr].filter(Boolean).join('\n'), stdout })

describe('the Python stack at S1 (R2 AC-PY-1)', () => {
  test('a 535 project (pyproject.toml, uv.lock) is Python; the echo proposes the venv\'s pytest, mypy on its configured files and ruff check', async () => {
    const w = pyHost({ [`${ROOT}/pyproject.toml`]: PYPROJECT_535, [`${ROOT}/uv.lock`]: 'version = 1\n', [`${ROOT}/src/lotto535/__init__.py`]: '' })
    const out = await detectSetup(w.host, ARGS)
    if (!out.ok) throw new Error(out.refusals.join('\n'))
    expect([out.draft.stack, out.draft.managers]).toEqual(['python', ['uv']])
    const text = setupEcho(w.host, out.draft).lines.join('\n')
    for (const line of ['test: .venv/bin/pytest (runner pytest)', 'typecheck: .venv/bin/mypy (runner mypy)', 'lint: .venv/bin/ruff check (runner ruff)']) expect(text).toContain(line)
    expect(text).not.toContain('weakens the check')
    expect(out.draft.block.network.allowedDomains).toEqual(['files.pythonhosted.org', 'pypi.org'])
    expect(Object.keys(out.draft.sources)).toEqual(expect.arrayContaining(['git:config']))
  })

  test('a root .hypothesis/ git does not ignore, or a tracked __pycache__/, is refused at S1 like any build output (535 trial 2, M-6)', async () => {
    const ls = (d: string): string => `ls-files -t -c -o --exclude-standard --directory --no-empty-directory -- ${d}`
    const w = pyHost({ [`${ROOT}/pyproject.toml`]: PYPROJECT_535 }, { gitOut: { ...GIT, [ls('.hypothesis')]: '? .hypothesis/\n', [ls('__pycache__')]: 'H __pycache__/m.cpython-314.pyc\n' } })
    const out = await detectSetup(w.host, ARGS)
    const text = out.ok ? '' : out.refusals.join('\n')
    expect(text).toContain('.hypothesis holds files git neither tracks nor ignores')
    expect(text).toContain('__pycache__ is tracked by git')
  })

  test('the flags that weaken a check show in the echo; `python -m pytest` is not one', async () => {
    const w = pyHost({ [`${ROOT}/pyproject.toml`]: PYPROJECT_535 })
    const out = await detectSetup(w.host, { ...ARGS, overrides: { test: '.venv/bin/pytest -x -k slow -p no:randomly', lint: 'none' } })
    if (!out.ok) throw new Error(out.refusals.join('\n'))
    const text = setupEcho(w.host, out.draft).lines.join('\n')
    expect(text).toContain('weakens the check: -x, -k slow, -p no:randomly')
    expect(text).not.toContain('lint:')
    expect(weakFlags('.venv/bin/python -m pytest tests')).toEqual([])
    expect(weakFlags('.venv/bin/pytest -xvs || true')).toEqual(['|| true', '-xvs'])
    expect(weakFlags('pytest --lf --deselect tests/a.py::t -m "not slow" --ignore=tests/b ; ruff check --exit-zero --fix')).toEqual(['--lf', '-m "not slow"', '--deselect tests/a.py::t', '--ignore=tests/b', '--exit-zero', '--fix'])
    expect(weakFlags('.venv/bin/pytest -rx -ra')).toEqual([]) // -r and its report characters
  })

  test('a credential in a requirements file, a [pypi-token] table or uv\'s index password is refused at S1 (security review, step 3)', async () => {
    const w = pyHost({ [`${ROOT}/pyproject.toml`]: PYPROJECT_535, [`${ROOT}/requirements-dev.txt`]: '--extra-index-url https://u:s3cret@pypi.corp/simple\npytest==9.1.1\n' })
    const out = await detectSetup(w.host, ARGS)
    expect(out.ok ? [] : out.refusals).toContain('requirements-dev.txt holds a registry credential; move it to your user config')
    expect(hasAuth('poetry.toml', '[pypi-token]\npypi = "pypi-AgEIcHlwaS5vcmc"\n')).toBe(true)
    expect(hasAuth('poetry.toml', '[repositories.corp]\nurl = "https://pypi.corp/simple"\n')).toBe(false)
    expect(authEnvNames(['UV_INDEX_CORP_PASSWORD', 'UV_INDEX_CORP_USERNAME', 'UV_INDEX_URL'], PYTHON)).toEqual(['UV_INDEX_CORP_PASSWORD'])
  })

  test('a project with requirements files only is Python (a name pattern) with pip; with no ruff or mypy only the test command is proposed', async () => {
    const w = pyHost({ [`${ROOT}/requirements-dev.txt`]: 'pytest==9.1.1\n', [`${ROOT}/setup.py`]: 'from setuptools import setup\nsetup()\n' })
    const out = await detectSetup(w.host, ARGS)
    if (!out.ok) throw new Error(out.refusals.join('\n'))
    expect([out.draft.stack, out.draft.managers, out.draft.commands.map(c => c.id)]).toEqual(['python', ['pip'], ['test']])
  })

  test('a program that is not there from the root is refused (the venv is the judge\'s interpreter)', async () => {
    const w = pyHost({ [`${ROOT}/pyproject.toml`]: PYPROJECT_535 }, { missing: ['.venv/bin/pytest'] })
    const out = await detectSetup(w.host, ARGS)
    expect(out.ok ? [] : out.refusals).toContain('test: ".venv/bin/pytest" cannot be run (its program is not found)')
    expect(w.runs.find(a => a.includes('command -v "$1"'))).toBeDefined()
  })

  test('proposeCommands: mypy bare when its config names the files, else on src or the root; overrides replace or drop', () => {
    const ids = (r: ReturnType<typeof proposeCommands>) => r.commands.map(c => `${c.id}=${c.argv.join(' ')}`)
    expect(ids(proposeCommands(PYPROJECT_535, 'uv', {}, ['src', 'tests']))).toEqual(['test=.venv/bin/pytest', 'typecheck=.venv/bin/mypy', 'lint=.venv/bin/ruff check'])
    expect(ids(proposeCommands('[project]\nname = "x"\ndependencies = ["mypy>=2"]\n', 'uv', {}, ['src']))).toEqual(['test=.venv/bin/pytest', 'typecheck=.venv/bin/mypy src'])
    expect(ids(proposeCommands('[tool.mypy]\nstrict = true\n', 'uv', {}, []))).toEqual(['test=.venv/bin/pytest', 'typecheck=.venv/bin/mypy .'])
    expect(ids(proposeCommands(null, 'pip', {}, ['mypy.ini', 'ruff.toml']))).toEqual(['test=.venv/bin/pytest', 'typecheck=.venv/bin/mypy', 'lint=.venv/bin/ruff check'])
    expect(ids(proposeCommands(PYPROJECT_535, 'uv', { typecheck: 'none', build: '.venv/bin/python -m build' }, []))).toEqual(['test=.venv/bin/pytest', 'lint=.venv/bin/ruff check', 'build=.venv/bin/python -m build'])
    expect(proposeCommands(PYPROJECT_535, 'uv', {}, []).scripts).toEqual({})
  })

  test('runnerOf: the console script, or the module after `python -m`; else the program', () => {
    expect([['.venv/bin/pytest'], ['.venv/bin/python', '-m', 'mypy', 'src'], ['.venv/bin/python3.14', '-X', 'dev', '-m', 'pytest'], ['uv', 'run', 'pytest'], ['make', 'test']].map(runnerOf)).toEqual(['pytest', 'mypy', 'pytest', 'uv', 'make'])
  })

  test('registry credentials: the names in the environment, and project files with a password or a URL that carries one (AC-STK-10)', () => {
    expect(authEnvNames(['PATH', 'TWINE_PASSWORD', 'UV_PUBLISH_TOKEN', 'POETRY_PYPI_TOKEN_PYPI', 'POETRY_HTTP_BASIC_CORP_PASSWORD', 'POETRY_HOME'], PYTHON)).toEqual(['TWINE_PASSWORD', 'UV_PUBLISH_TOKEN', 'POETRY_PYPI_TOKEN_PYPI', 'POETRY_HTTP_BASIC_CORP_PASSWORD'])
    expect(hasAuth('pip.conf', '[global]\nindex-url = https://u:secret@pypi.corp/simple\n')).toBe(true)
    expect(hasAuth('pip.conf', '[global]\n# index-url = https://u:secret@pypi.corp/simple\nindex-url = https://pypi.corp/simple\n')).toBe(false)
    expect(hasAuth('poetry.toml', '[http-basic.corp]\nusername = "u"\npassword = "p"\n')).toBe(true)
    expect(hasAuth('pyproject.toml', '[[tool.uv.index]]\nurl = "https://__token__:pypi-x@pypi.corp/simple"\n')).toBe(true)
    expect(hasAuth('pyproject.toml', '[tool.other]\ntoken = "not a registry"\n')).toBe(false)
  })

  test('every registry credential variable is refused at S1 by name (AC-STK-10: one case per variable)', async () => {
    for (const name of [...PYTHON.registryAuthEnv, 'POETRY_PYPI_TOKEN_PYPI', 'POETRY_HTTP_BASIC_CORP_PASSWORD', 'UV_INDEX_CORP_PASSWORD']) {
      const out = await detectSetup(pyHost({ [`${ROOT}/pyproject.toml`]: PYPROJECT_535 }, { envText: `PATH=/usr/bin\n${name}=x\n` }).host, ARGS)
      expect([name, out.ok ? [] : out.refusals]).toEqual([name, expect.arrayContaining([`registry credentials are set in the environment: ${name}; unset them for this session`])])
    }
  })

  test('a Python tool\'s variable whose URL carries a password is refused; the values are read only in the child, which prints names (AC-STK-10, F19)', async () => {
    const env = ['PATH=/usr/bin', 'PIP_INDEX_URL=https://u:s3cret@pypi.corp/simple', 'UV_INDEX=corp=https://__token__:pypi-x@pypi.corp/simple', 'PIP_EXTRA_INDEX_URL=https://pypi.corp/simple', 'UV_DEFAULT_INDEX=https://u@pypi.corp/simple', 'UV_FIND_LINKS=https://:tok@links.corp/w', 'UV_INDEX_URL=https://me@corp.com:tok@pypi.corp/simple', 'TWINE_PASSWORD=x', 'DATABASE_URL=postgres://u:p@db/x', '']
    const w = pyHost({ [`${ROOT}/pyproject.toml`]: PYPROJECT_535 }, { envText: env.join('\n') })
    const out = await detectSetup(w.host, ARGS)
    // an empty user with a password counts too (reviews r2), and a user holding `@`, as pip splits at the last one (security review r4)
    expect(out.ok ? [] : out.refusals).toContain('registry credentials are set in the environment: TWINE_PASSWORD, PIP_INDEX_URL, UV_INDEX, UV_FIND_LINKS, UV_INDEX_URL; unset them for this session')
    expect(hasAuth('pip.conf', '[global]\nindex-url = https://:t@pypi.corp/simple\n')).toBe(true)
    expect(hasAuth('pip.conf', '[global]\nindex-url = https://me@corp.com:t@pypi.corp/simple\n')).toBe(true)
    // the names go to the child; a name already refused by name is not checked again
    expect(w.runs.filter(a => a[0] === '/bin/sh' && a[2] === URL_AUTH_SCRIPT).map(a => a.slice(4))).toEqual([['PIP_INDEX_URL', 'UV_INDEX', 'PIP_EXTRA_INDEX_URL', 'UV_DEFAULT_INDEX', 'UV_FIND_LINKS', 'UV_INDEX_URL']])
    expect(urlEnvNames(['PATH', 'PIP_INDEX_URL', 'pip_index_url', 'UVX', 'DATABASE_URL', 'HATCH_INDEX_REPO', 'FLIT_INDEX_URL', 'POETRY_REPOSITORIES_CORP_URL', 'PDM_PYPI_URL', 'PIPENV_PYPI_MIRROR']))
      .toEqual(['PIP_INDEX_URL', 'HATCH_INDEX_REPO', 'FLIT_INDEX_URL', 'POETRY_REPOSITORIES_CORP_URL', 'PDM_PYPI_URL', 'PIPENV_PYPI_MIRROR'])
  })

  test('each Python auth file with a credential is refused at S1, naming it (AC-STK-10: one case per file)', async () => {
    const url = 'https://u:s3cret@pypi.corp/simple'
    const cases: Record<string, string> = {
      'pip.conf': `[global]\nindex-url = ${url}\n`, 'uv.toml': `[[index]]\nurl = "${url}"\n`, 'poetry.toml': '[http-basic.corp]\npassword = "p"\n',
      'pyproject.toml': `${PYPROJECT_535}\n[[tool.uv.index]]\nurl = "${url}"\n`, 'requirements.txt': `--index-url ${url}\n`, 'constraints-dev.txt': `--extra-index-url ${url}\n`,
      'Pipfile': `[[source]]\nurl = "${url}"\n`, '.pypirc': '[pypi]\npassword = p\n',
    }
    expect(Object.keys(cases)).toHaveLength(PYTHON.authFiles.length)
    for (const [file, text] of Object.entries(cases)) {
      const out = await detectSetup(pyHost({ [`${ROOT}/pyproject.toml`]: PYPROJECT_535, [`${ROOT}/${file}`]: text }).host, ARGS)
      expect([file, out.ok ? [] : out.refusals]).toEqual([file, expect.arrayContaining([`${file} holds a registry credential; move it to your user config`])])
    }
  })

  test('the proposed block holds PyPI and the caches of each manager found, and hides the Python credential files (AC-STK-10)', async () => {
    for (const [lock, id] of [['uv.lock', 'uv'], ['poetry.lock', 'poetry'], ['requirements.txt', 'pip']] as const) {
      const out = await detectSetup(pyHost({ [`${ROOT}/pyproject.toml`]: PYPROJECT_535, [`${ROOT}/${lock}`]: '' }).host, ARGS)
      if (!out.ok) throw new Error(out.refusals.join('\n'))
      expect([id, out.draft.managers, out.draft.block.network.allowedDomains]).toEqual([id, [id], ['files.pythonhosted.org', 'pypi.org']])
      expect(out.draft.block.filesystem.allowWrite).toEqual(expect.arrayContaining([...(PYTHON.packageManagers.find(m => m.id === id)?.cacheDirs ?? [])]))
      expect(out.draft.block.filesystem.denyRead).toEqual(expect.arrayContaining([...PYTHON.sandbox.denyRead, '~/.pypirc', '~/.netrc']))
    }
  })

  test('weakening flags in pytest\'s addopts show in the echo with their file; other sections and comments do not count (§4.5)', async () => {
    const w = pyHost({ [`${ROOT}/pyproject.toml`]: PYPROJECT_535.replace('addopts = ["-ra"]', 'addopts = ["-ra", "-x", "-k", "not slow", "-p", "no:randomly"]') })
    const out = await detectSetup(w.host, ARGS)
    if (!out.ok) throw new Error(out.refusals.join('\n'))
    const lines = setupEcho(w.host, out.draft).lines
    expect(lines).toContain('  weakens the check from pyproject.toml: -x, -k "not slow", -p no:randomly')
    expect(lines.filter(l => l.includes('weakens the check'))).toHaveLength(1) // ruff and mypy take no addopts
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ['pyproject.toml', '[tool.pytest.ini_options]\naddopts = "-x --lf"\n', '-x --lf'],
      ['pyproject.toml', '[tool.pytest]\nminversion = "9"\n[tool.other]\naddopts = ["-x"]\n', ''],
      ['pytest.ini', '[pytest]\naddopts = -ra\n    --deselect tests/a.py::t\n\n[other]\naddopts = -x\n', '-ra --deselect tests/a.py::t'],
      ['setup.cfg', '[metadata]\nname = x\n[tool:pytest]\n# addopts = -x\naddopts = --sw\n', '--sw'],
      ['tox.ini', '[tox]\naddopts = -x\n[pytest]\naddopts =\n  -p no:cov\n', '-p no:cov'],
      ['pytest.toml', '[pytest]\naddopts = [\n  "--maxfail=2", # "-x" in a comment\n  \'-q\',\n]\n', '--maxfail=2 -q'],
      // INI as pytest's iniconfig reads it: blank and comment lines (also indented) are skipped, an indented line continues
      // the value, and only a line in column 0 starts a key or a section (code review r1)
      ['pytest.ini', '[pytest]\naddopts = -ra\n\n    -x\n', '-ra -x'],
      ['tox.ini', '[pytest]\naddopts =\n  # -x\n  ; -k slow\n  -q\n', '-q'],
      ['setup.cfg', '[tool:pytest]\nmarkers =\n    slow\n    addopts = -x\n', ''],
      // a quoted TOML key is the same key (security review r3)
      ['pyproject.toml', '[tool.pytest.ini_options]\n"addopts" = ["-x"]\n', '-x'],
      ['pytest.toml', "[pytest]\n'addopts' = '-k slow'\n", '-k slow'],
    ]
    for (const [file, text, opts] of cases) expect([file, text, addoptsIn(file, text)]).toEqual([file, text, opts])
  })

  test('a config file that cannot be read the second time stops S1 instead of showing no flags (code review r1)', async () => {
    let reads = 0
    const io = { read: async (p: string) => { if (!p.endsWith('/pyproject.toml')) throw new Error('ENOENT'); reads += 1; if (reads > 1) throw new Error('EIO'); return '[tool.pytest]\naddopts = ["-x"]\n' } }
    await expect(configOptions(io as unknown as Parameters<typeof configOptions>[0], ROOT, ['.venv/bin/pytest'])).rejects.toThrow('EIO')
  })

  test('a URL check or a name listing that fails stops S1; the error names the exit status, never the child\'s output (reviews r1, r2)', async () => {
    const w = pyHost({ [`${ROOT}/pyproject.toml`]: PYPROJECT_535 }, { envText: 'PATH=/usr/bin\nPIP_INDEX_URL=https://pypi.corp/simple\n', run: argv => (argv[2] === URL_AUTH_SCRIPT ? { exitCode: 4, stdout: '', stderr: '+ v=https://u:s3cret@h/simple' } : undefined) })
    const err = await detectSetup(w.host, ARGS).then(() => '', (e: unknown) => String(e))
    expect(err).toContain('the registry URLs in the environment could not be checked (exit 4)')
    expect(err).not.toContain('s3cret')
    const names = pyHost({ [`${ROOT}/pyproject.toml`]: PYPROJECT_535 }, { run: argv => ((argv[2] ?? '').includes('/usr/bin/env |') ? { exitCode: 4, stdout: '', stderr: '+ s3cret' } : undefined) })
    const listing = await detectSetup(names.host, ARGS).then(() => '', (e: unknown) => String(e))
    expect(listing).toContain('the environment names could not be read (exit 4)')
    expect(listing).not.toContain('s3cret') // the listing's error names its exit status only too (security review r3)
    // a listing or a URL check that exits 0 without its end mark did not run to the end (security review r4)
    const unfinished = (match: (argv: readonly string[]) => boolean, env = 'PATH=/usr/bin\n') => pyHost({ [`${ROOT}/pyproject.toml`]: PYPROJECT_535 }, { envText: env, run: argv => (match(argv) ? { exitCode: 0, stdout: '', stderr: '' } : undefined) })
    await expect(detectSetup(unfinished(argv => (argv[2] ?? '').includes('/usr/bin/env |')).host, ARGS)).rejects.toThrow('the environment names could not be read (exit 0, unfinished)')
    await expect(detectSetup(unfinished(argv => argv[2] === URL_AUTH_SCRIPT, 'PATH=/usr/bin\nPIP_INDEX_URL=https://pypi.corp/simple\n').host, ARGS)).rejects.toThrow('the registry URLs in the environment could not be checked (exit 0, unfinished)')
  })
})

describe('the Python stack in the judge (R2 AC-STK-12, GAP-R2-0.6-2, -3, -12, -23, -25)', () => {
  test('pytest: the JUnit report in the run folder, no cache, the root as rootdir and conftest limit, the config pinned', () => {
    const tail = ['-p', 'no:cacheprovider', '-o', 'junit_family=xunit1', '--junitxml=/run/report.xml', '--junit-prefix=', '--rootdir=.', '--confcutdir=.', '--continue-on-collection-errors', '--verbosity=0', '-c']
    expect(judgedArgv(['.venv/bin/pytest', 'tests'], 'pytest', '/run', 'pyproject.toml')).toEqual({ argv: ['.venv/bin/pytest', 'tests', ...tail, 'pyproject.toml'], reportFile: '/run/report.xml' })
    expect(judgedArgv(['.venv/bin/python', '-m', 'pytest'], 'pytest', '/run', '')).toEqual({ argv: ['.venv/bin/python', '-m', 'pytest', ...tail, '/dev/null'], reportFile: '/run/report.xml' })
  })

  test('ruff check and format with no cache and the pinned config (or none at all); mypy with its cache in the run folder; anything else as approved', () => {
    expect(judgedArgv(['.venv/bin/ruff', 'check', 'src'], 'ruff', '/run', 'pyproject.toml').argv).toEqual(['.venv/bin/ruff', 'check', 'src', '--no-cache', '--output-format=concise', '--config=pyproject.toml'])
    expect(judgedArgv(['.venv/bin/ruff', 'format', '--check'], 'ruff', '/run', '').argv).toEqual(['.venv/bin/ruff', 'format', '--check', '--no-cache', '--isolated'])
    expect(judgedArgv(['.venv/bin/ruff', '--version'], 'ruff', '/run', '').argv).toEqual(['.venv/bin/ruff', '--version'])
    expect(judgedArgv(['.venv/bin/ruff', '--config', 'x.toml', 'check'], 'ruff', '/run', 'ruff.toml').argv).toEqual(['.venv/bin/ruff', '--config', 'x.toml', 'check', '--no-cache', '--output-format=concise', '--config=ruff.toml'])
    expect(judgedArgv(['.venv/bin/mypy'], 'mypy', '/run', '')).toEqual({ argv: ['.venv/bin/mypy', '--cache-dir=/run/mypy', '--show-error-codes', '--config-file='], reportFile: null })
    expect(judgedArgv(['make', 'test'], 'make', '/run')).toEqual({ argv: ['make', 'test'], reportFile: null })
    expect(judgeEnv({ runDir: '/run' })).toEqual(['PYTHONPYCACHEPREFIX=/run/pyc', 'PYTHONDONTWRITEBYTECODE=1', 'PYTHONHASHSEED=0', 'PYTHONIOENCODING=utf-8', 'PYTHONSAFEPATH=1', 'PYTHONNOUSERSITE=1', 'PYTEST_DISABLE_PLUGIN_AUTOLOAD=1'])
  })

  test('configFor: the root\'s config of the runner, in the runner\'s own order; none is \'\'; another program undefined', async () => {
    const io = (files: Record<string, string>) => pyHost(Object.fromEntries(Object.entries(files).map(([k, v]) => [`${ROOT}/${k}`, v]))).host.io
    const at = (files: Record<string, string>, argv: string[]) => configFor(io(files), ROOT, argv)
    expect(await at({ 'pyproject.toml': PYPROJECT_535, 'pytest.ini': '[pytest]\n' }, ['.venv/bin/pytest'])).toBe('pytest.ini')
    expect(await at({ 'pytest.ini': '[pytest]\n', '.pytest.toml': '[pytest]\n' }, ['.venv/bin/pytest'])).toBe('.pytest.toml') // pytest 9 reads it first
    expect(await at({ 'pyproject.toml': PYPROJECT_535 }, ['.venv/bin/pytest'])).toBe('pyproject.toml')
    expect(await at({ 'pyproject.toml': '[project]\nname = "x"\n', 'setup.cfg': '[tool:pytest]\naddopts = -q\n' }, ['.venv/bin/pytest'])).toBe('setup.cfg')
    expect(await at({ 'pyproject.toml': '[project]\nname = "x"\n' }, ['.venv/bin/pytest'])).toBe('')
    expect(await at({ 'pyproject.toml': PYPROJECT_535, 'ruff.toml': 'line-length = 90\n' }, ['.venv/bin/ruff', 'check'])).toBe('ruff.toml')
    expect(await at({ 'setup.cfg': '[mypy]\nstrict = True\n' }, ['.venv/bin/python', '-m', 'mypy'])).toBe('setup.cfg')
    expect(await at({ 'pyproject.toml': PYPROJECT_535 }, ['make', 'test'])).toBeUndefined()
  })
})

describe('the Python stack in judgedRun, end to end (code review, step 3)', () => {
  const RUN_DIR = '/private/var/folders/t/flow-run.py1'
  const judgedHost = (o: { link?: boolean; listed?: string[]; survivor?: boolean } = {}) => {
    const w = pyHost({ [`${ROOT}/pyproject.toml`]: PYPROJECT_535 }, {
      ...(o.link ? { links: { [`${RUN_DIR}/report.xml`]: '/dev/zero' } } : {}),
      run: argv => {
        if (o.listed && argv.includes('ls-files')) return { exitCode: 0, stdout: argv.includes('-i') ? '' : o.listed.map(x => `${x}\0`).join(''), stderr: '' }
        if (argv[0] === '/bin/sh' && (argv[2] ?? '').includes('mktemp')) return { exitCode: 0, stdout: `${RUN_DIR}\n`, stderr: '' }
        // reaping scans (R2 step 7): ps -E carries the marker of a survivor; the plain ps forms give the before-sets
        if (argv[0] === '/bin/ps' && argv.includes('-E')) return { exitCode: 0, stdout: o.survivor ? ` 999 998 node x ${RUN_MARKER_VAR}=flow-run.py1\n` : '', stderr: '' }
        if (argv[0] === '/bin/ps') return { exitCode: 0, stdout: argv.includes('pgid=') ? '1\n' : '1\n2\n', stderr: '' }
        if (argv[0] === '/usr/sbin/lsof' || argv[0] === '/bin/kill') return { exitCode: 0, stdout: '', stderr: '' }
        if (!argv.includes('/usr/bin/sandbox-exec')) return undefined
        const report = argv.find(a => a.startsWith('--junitxml='))?.slice('--junitxml='.length)
        if (report && !o.link) w.files.set(report, X1)
        return { exitCode: 1, stdout: OUT_X1, stderr: '' }
      },
    })
    return w
  }
  const cmd = { id: 'test', argv: ['.venv/bin/pytest'], runner: 'pytest', mode: 'must-pass' as const }
  /** A Python record frozen as the host is now: its command sources and its runner (judgedRun checks both first). */
  const record = async (w: ReturnType<typeof judgedHost>) => {
    const r = activeRecord(), p = await gitPaths(w.host.io, ROOT)
    const src = await commandSources(w.host.io, p, [cmd.argv]), run = await PYTHON_STACK.code.runnerIntegrity(w.host.io, p.top, [cmd], w.host.home)
    const kept = Object.fromEntries(Object.entries(r.frozen).filter(([k]) => !k.startsWith('src:')))
    return { ...r, setup: r.setup ? { ...r.setup, stack: 'python', commands: [cmd] } : r.setup, frozen: { ...kept, ...Object.fromEntries(Object.entries(src.hashes).map(([k, v]) => [`src:${k}`, v])), 'runner:v2': run.hash } }
  }

  test('the judge runs pytest with its config pinned and the Python env, and reads the report with the run\'s stdout', async () => {
    const w = judgedHost(), out = await judgedRun(w.host, await record(w), cmd)
    const argv = w.runs.find(a => a.includes('/usr/bin/sandbox-exec')) ?? []
    expect(argv).toEqual(expect.arrayContaining([`--junitxml=${RUN_DIR}/report.xml`, '-c', 'pyproject.toml', 'PYTHONSAFEPATH=1', `PYTHONPYCACHEPREFIX=${RUN_DIR}/pyc`]))
    expect(out.ok && out.report).toEqual(readJunit(X1))
  })

  test('a report that is a link (to a device, a pipe) is not read: null, never a pass', async () => {
    const w = judgedHost({ link: true }), out = await judgedRun(w.host, await record(w), cmd)
    expect(out.ok && out.report).toBeNull()
  })

  test('AC-STK-9: a command source or the runner changed since the check (by an earlier judged run) blocks before the run', async () => {
    const w = judgedHost({ listed: ['pyproject.toml'] }), r = await record(w)
    w.files.set(`${ROOT}/pyproject.toml`, `${PYPROJECT_535}\n# written by an earlier judged run\n`)
    const out = await judgedRun(w.host, r, cmd)
    expect(out).toEqual({ ok: false, reason: 'tampered', detail: 'pyproject.toml' })
    expect(w.runs.some(a => a.includes('/usr/bin/sandbox-exec'))).toBe(false)
    expect(judgedBlock(cmd, { ok: false, reason: 'tampered', detail: '.venv' })).toEqual({ reason: 'tampered', vars: { file: '.venv' } })
  })

  test('a surviving marked process makes the run couldNotRun (outranking its result) and is ended before the run folder is removed (step-7 review GAP-R2-0.6-82, -83)', async () => {
    const w = judgedHost({ survivor: true }), out = await judgedRun(w.host, await record(w), cmd)
    expect(out.ok).toBe(false)
    if (!out.ok) { expect(out.reason).toBe('couldNotRun'); expect(out.detail).toContain('999') }
    const killAt = w.runs.findIndex(a => a[0] === '/bin/kill' && a.includes('999'))
    const rmAt = w.runs.findIndex(a => a[0] === '/bin/rm')
    expect(killAt).toBeGreaterThanOrEqual(0) // the marked survivor was ended (GAP-R2-0.6-83)
    expect(killAt < rmAt).toBe(true) // reaping ran before the run folder was removed
  })
})

describe('the Python stack: the report against pytest\'s summary line (R2 AC-PY-3, AC-STK-2, AC-STK-3)', () => {
  const pairs: Array<[string, string, string]> = [['X1', X1, OUT_X1], ['STRICT', STRICT, OUT_STRICT], ['RED', RED, OUT_RED], ['MODULE_SKIP', MODULE_SKIP, OUT_MODULE_SKIP], ['SUBTESTS', SUBTESTS_RUN, OUT_SUBTESTS]]
  for (const [name, xml, out] of pairs) test(`real run ${name}: the report is read when the summary agrees`, () => expect(readPytestReport(xml, run(out))).toEqual(readJunit(xml)))

  test('a summary line a test printed (anywhere, on either stream), or a last line that is not the summary, gives null', () => {
    const lines = OUT_X1.split('\n'), fake = '============================== 25 passed in 0.01s =============================='
    expect(readPytestReport(X1, run([...lines.slice(0, 20), fake, ...lines.slice(20)].join('\n')))).toBeNull()
    expect(readPytestReport(X1, run(`${OUT_X1}\n${fake}\n`))).toBeNull()
    expect(readPytestReport(X1, run(OUT_X1, fake))).toBeNull()
    expect(readPytestReport(X1, run(`${OUT_X1}\nbye from atexit\n`))).toBeNull()
    // what the run printed on stderr after it does not matter while stdout ends with the summary
    expect(readPytestReport(X1, run(OUT_X1, 'DeprecationWarning: x'))).not.toBeNull()
  })

  test('a report missing, cut short or rewritten so its counts leave the summary gives null; so does a run with no output', () => {
    expect(readPytestReport('', run(OUT_X1))).toBeNull()
    expect(readPytestReport(X1.slice(0, X1.length / 2), run(OUT_X1))).toBeNull()
    const first = /<failure message="assert 3 == 4">[\s\S]*?<\/failure>/.exec(X1)?.[0] ?? ''
    const passed = X1.replace(first, '').replace('failures="9"', 'failures="8"')
    expect(readJunit(passed)).not.toBeNull() // a report that reads on its own
    expect(readPytestReport(passed, run(OUT_X1))).toBeNull()
    expect(readPytestReport(X1)).toBeNull()
  })

  test('pytestSummary: the items pytest prints, the long time form, colours, and `no tests ran`; another item gives null', () => {
    expect(pytestSummary('== 1 failed, 2 passed, 1 deselected, 3 warnings, 2 errors in 61.20s (0:01:01) ==', '== 1 failed, 2 passed, 1 deselected, 3 warnings, 2 errors in 61.20s (0:01:01) ==')).toEqual({ failed: 1, passed: 2, skipped: 0, xfailed: 0, xpassed: 0, errors: 2 })
    const coloured = '\u001b[31m=== \u001b[1m1 failed\u001b[0m in 0.10s ===\u001b[0m'
    expect(pytestSummary(coloured, coloured)?.failed).toBe(1)
    expect(pytestSummary('==== no tests ran in 0.01s ====', '==== no tests ran in 0.01s ====')).toEqual({ failed: 0, passed: 0, skipped: 0, xfailed: 0, xpassed: 0, errors: 0 })
    expect(pytestSummary('== 1 passed, 1 rerun in 0.1s ==', '== 1 passed, 1 rerun in 0.1s ==')).toBeNull()
  })
})

describe('the Python stack: RED (R2 AC-PY-4, AC-STK-4)', () => {
  const report = readJunit(RED)
  test('real messages: rewritten asserts, AssertionError and pytest.raises expectations are assertions; the import forms name their module', () => {
    const kinds = (report?.tests ?? []).map(t => [t.id, classify(t.message, PYTHON)])
    expect(kinds).toEqual([
      ['test_attr', { kind: 'missingExport', symbol: 'missing_fn', module: 'spikefix.core' }],
      ['test_inner_import', { kind: 'moduleNotFound', module: 'spikefix.other' }],
      ['test_name', { kind: 'other' }],
    ])
    expect((report?.collection ?? []).map(c => classify(c.message, PYTHON).kind)).toEqual(['moduleNotFound', 'missingExport', 'other'])
    const x1 = readJunit(X1)?.tests ?? [], msg = (id: string) => x1.find(t => t.id === id)?.message ?? ''
    expect(['test_fail_assert', 'TestU > test_bad', 'test_error_setup', 'test_fail_exception'].map(id => classify(msg(id), PYTHON).kind)).toEqual(['assertion', 'assertion', 'other', 'other'])
    expect(classify("Failed: DID NOT RAISE <class 'ValueError'>", PYTHON).kind).toBe('assertion')
  })

  test('the RED check on the real run: a (new) module and an absent symbol pass; a syntax error, a NameError and a module the plan does not mark fail', async () => {
    const files = [
      added('red/test_red_module.py', ['from spikefix.newmod import go', 'def test_go():', '    assert go() == 1']),
      added('red/test_red_symbol.py', ['from spikefix.core import missing_symbol', 'def test_symbol():', '    assert missing_symbol()']),
      added('red/test_red_syntax.py', ['def test_syntax(:']),
      added('red/test_red_attr.py', ['import spikefix.core', 'def test_attr():', '    spikefix.core.missing_fn()', 'def test_inner_import():', '    import spikefix.other']),
      added('red/test_red_name.py', ['def test_name():', '    undefined_name']),
    ]
    const asked: string[] = [], inTree: string[] = []
    const out = await redCheck({
      files, failures: reportSignatures(report ?? { tests: [], collection: [], fileErrors: [], counts: { passed: 0, failed: 0, skipped: 0 } }, 'pytest'), fTestFiles: files.map(f => f.path), fAcs: [], newFiles: ['src/spikefix/newmod.py'],
      stack: PYTHON_STACK, ...(report ? { report } : {}), absentAtStart: async (m, name) => { asked.push(`${m}:${name}`); return true },
      inStart: async fs => { inTree.push(...fs.filter(f => f === 'src/spikefix/core.py')); return fs.includes('src/spikefix/core.py') },
    })
    expect(out.problems).toEqual([
      'red/test_red_syntax.py fails for another reason (SyntaxError: invalid syntax)',
      'red/test_red_attr.py cannot load spikefix.other, which the plan does not mark (new)',
      'test_name fails for another reason (NameError: name \'undefined_name\' is not defined)',
    ])
    expect(asked).toEqual(['spikefix/core:missing_symbol', 'spikefix/core:missing_fn'])
    expect(inTree).toEqual(['src/spikefix/core.py', 'src/spikefix/core.py'])
  })

  test('a missing symbol of a module that is not the project\'s (the standard library, a package) is not RED (code review, step 3)', async () => {
    const files = [added('tests/test_os.py', ['from os import nope', 'def test_nope():', '    assert nope() == 1'])]
    const failures = [{ runner: 'pytest', file: 'tests/test_os.py', id: '', message: "ImportError: cannot import name 'nope' from 'os' (/opt/python3.14/lib/python3.14/os.py)", collection: true }]
    const out = await redCheck({ files, failures, fTestFiles: ['tests/test_os.py'], fAcs: [], newFiles: [], stack: PYTHON_STACK, absentAtStart: async () => true, inStart: async () => false })
    expect(out.problems).toEqual(['tests/test_os.py fails on nope, which it does not import from a project file'])
  })

  test('two added tests of one name in two classes each fail on their own (code review, step 3)', async () => {
    const files = [added('tests/test_ab.py', ['class TestA:', '    def test_init(self):', '        assert A().x == 1', 'class TestB:', '    def test_init(self):', '        assert B().x == 1'])]
    const sig = (id: string) => ({ runner: 'pytest', file: 'tests/test_ab.py', id, message: 'assert 0 == 1', collection: false })
    const out = await redCheck({ files, failures: [sig('TestA > test_init'), sig('TestB > test_init')], fTestFiles: ['tests/test_ab.py'], fAcs: [], newFiles: [], stack: PYTHON_STACK, absentAtStart: async () => true, inStart: async () => true })
    expect(out).toEqual({ ok: true, problems: [] })
  })

  test('every parameter set of an added test must fail, and a parameter id names its eval id (GAP-R2-0.6-1, -34)', async () => {
    const report = readJunit(X1)
    const out = await redCheck({
      files: [added('tests/test_status.py', ['def test_param_ids(v):', '    assert v'])], failures: reportSignatures(report ?? { tests: [], collection: [], fileErrors: [], counts: { passed: 0, failed: 0, skipped: 0 } }, 'pytest'),
      fTestFiles: ['tests/test_status.py'], fAcs: ['AC-001', 'AC-002', 'AC-009'], newFiles: [], stack: PYTHON_STACK, ...(report ? { report } : {}), absentAtStart: async () => true, inStart: async () => true,
    })
    expect(out.problems).toEqual(['an added test passes: test_param_ids', 'no added test names AC-009'])
  })
})

describe('the Python stack: eval ids in the judge (GAP-R2-0.6-1)', () => {
  test('AC-nnn in a parameter id and ac_nnn in a name both prove their id; a failed one fails it', () => {
    const v = judgeRun({ id: 'test', runner: 'pytest', mode: 'no-new-failures' }, { exitCode: 1, output: OUT_X1, ms: 1 }, null, PYTHON, ['AC-001', 'AC-002', 'AC-003', 'AC-004'], new Map(), readJunit(X1))
    expect(v.evalProblems).toEqual(['AC-002 failed', 'AC-004 not run'])
  })
})

describe('the Python stack: test code, imports and sources', () => {
  test('tests and classes the diff adds and removes, read on code (a docstring or a comment declares nothing)', () => {
    const f = added('tests/test_a.py', ['class TestA:', '    def test_one(self):', '        pass', '    async def test_two(self):', '        """def test_doc(): in a docstring"""', '# def test_commented():', 'def helper():', 'def testplain():'], ['def test_old():', 'class TestOld(unittest.TestCase):', 'class Helper:'])
    expect(addedTests([f], ['tests/test_a.py'])).toEqual(['test_one', 'test_two', 'testplain'].map(name => ({ file: 'tests/test_a.py', name })))
    expect(declChanges([f], ['tests/test_a.py'])).toEqual({ removedTitles: ['test_old'], addedTitles: ['test_one', 'test_two', 'testplain'], removedSuites: ['TestOld'], addedSuites: ['TestA'] })
    expect(addedTests([f], [])).toEqual([])
  })

  test('a test added under an edited docstring is still found: each side is read with its kept lines (535 trial M-5)', () => {
    // the module docstring's first line is edited, so its closing quotes are a context line; a test is renamed below it
    const f: DiffFile = { path: 'tests/test_a.py', status: 'modified', lines: [
      { kind: '-', n: 1, at: 1, text: '"""Old title.' }, { kind: '+', n: 1, text: '"""New title.' },
      { kind: ' ', n: 2, o: 2, text: '"""' }, { kind: ' ', n: 3, o: 3, text: '' },
      { kind: '-', n: 4, at: 4, text: 'def test_old():' }, { kind: '+', n: 4, text: 'def test_ac_004_new():' },
      { kind: ' ', n: 5, o: 5, text: '    assert False' },
    ] }
    expect(addedTests([f], ['tests/test_a.py'])).toEqual([{ file: 'tests/test_a.py', name: 'test_ac_004_new' }])
    expect(declChanges([f], ['tests/test_a.py'])).toEqual({ removedTitles: ['test_old'], addedTitles: ['test_ac_004_new'], removedSuites: [], addedSuites: [] })
  })

  test('a test appended after a closing """ is found: from the whole file, else from either reading (review of the M-5 fix)', () => {
    // real `git diff` output with SCAN_DIFF_ARGS: the hunk's one kept line closes a string the hunk does not show
    const diff = ['diff --git a/tests/test_a.py b/tests/test_a.py', 'index ac63a55..7d41a9a 100644', '--- a/tests/test_a.py', '+++ b/tests/test_a.py', '@@ -7 +7,5 @@ def test_ac_001_text():', '         """)', '+', '+', '+def test_ac_004_new():', '+    assert False', ''].join('\n')
    const whole = ['from textwrap import dedent', '', '', 'def test_ac_001_text():', '    assert dedent("""', '        alpha', '        """)', '', '', 'def test_ac_004_new():', '    assert False', ''].join('\n')
    const files = parseDiff(diff), want = [{ file: 'tests/test_a.py', name: 'test_ac_004_new' }]
    expect(addedTests(files, ['tests/test_a.py'], { 'tests/test_a.py': whole })).toEqual(want)
    expect(addedTests(files, ['tests/test_a.py'])).toEqual(want) // read hunk by hunk it hides the test; read alone it does not
    expect(addedTests(files, ['tests/test_a.py'], { 'tests/test_a.py': 'x = 1\n' })).toEqual(want) // a text that is not the diff's is not used
    expect(declChanges(files, ['tests/test_a.py'], { now: { 'tests/test_a.py': whole } }).addedTitles).toEqual(['test_ac_004_new'])
  })

  test('a hunk that starts inside a string and closes it on a changed line is read from the whole files (review of the M-5 fix)', () => {
    // real `git diff` output with SCAN_DIFF_ARGS: git took the string's column-0 line `text` for a function line, so
    // both readings without the files start in code and miss the test
    const diff = ['diff --git a/tests/test_c.py b/tests/test_c.py', 'index 147c226..c4c2691 100644', '--- a/tests/test_c.py', '+++ b/tests/test_c.py', '@@ -3,2 +3,6 @@ title', ' text', '-more"""', '+"""', '+', '+', '+def test_ac_005_x():', '+    assert False', ''].join('\n')
    const now = { 'tests/test_c.py': 'DOC = """\ntitle\ntext\n"""\n\n\ndef test_ac_005_x():\n    assert False\n' }, before = { 'tests/test_c.py': 'DOC = """\ntitle\ntext\nmore"""\n' }
    const files = parseDiff(diff)
    expect(addedTests(files, ['tests/test_c.py'], now)).toEqual([{ file: 'tests/test_c.py', name: 'test_ac_005_x' }])
    expect(declChanges(files, ['tests/test_c.py'], { before, now })).toEqual({ removedTitles: [], addedTitles: ['test_ac_005_x'], removedSuites: [], addedSuites: [] })
  })

  test('importsOf, resolveImport, moduleFiles', () => {
    const imports = importsOf(['from spikefix.core import a, b as c', 'from . import d', 'from .mod import (', '    e,', '    f as g,', ')', 'import os.path', 'import numpy as np', '# import fake', 's = "import nope"'])
    expect(Object.fromEntries(imports)).toEqual({ a: { spec: 'spikefix.core', name: 'a' }, c: { spec: 'spikefix.core', name: 'b' }, d: { spec: '.', name: 'd' }, e: { spec: '.mod', name: 'e' }, g: { spec: '.mod', name: 'f' }, os: { spec: 'os', name: '' }, np: { spec: 'numpy', name: '' } })
    expect([['tests/test_a.py', 'spikefix.core'], ['src/pkg/a.py', '.core'], ['src/pkg/sub/a.py', '..core'], ['src/pkg/a.py', '.'], ['a.py', '..x'], ['x.py', ''], ['x.py', 'a..b']].map(([f, s]) => resolveImport(f ?? '', s ?? ''))).toEqual(['spikefix/core', 'src/pkg/core', 'src/pkg/core', 'src/pkg', null, null, null])
    expect(moduleFiles('spikefix/core')).toEqual(expect.arrayContaining(['spikefix/core.py', 'spikefix/core/__init__.py', 'src/spikefix/core.py', 'tests/spikefix/core.py']))
  })

  test('eval ids in test files: in names and in the code\'s strings, comments aside (GAP-R2-0.6-44)', async () => {
    const text = ['import pytest', '"""Module docstring AC-004."""', '@pytest.mark.parametrize("v", [1], ids=["AC-002 one"])', 'def test_ac_001_x(v):', '    # AC-003 only in a comment', '    assert v'].join('\n')
    const w = pyHost({ [`${ROOT}/tests/test_ids.py`]: text }, { run: argv => (argv.includes('grep') ? { exitCode: 0, stdout: 'tests/test_ids.py\0', stderr: '' } : undefined) })
    const ids = await evalIdsInTests(w.host.io, await gitPaths(w.host.io, ROOT), PYTHON.testFiles, PYTHON)
    expect([...ids.entries()].sort()).toEqual([['AC-001', ['tests/test_ids.py']], ['AC-002', ['tests/test_ids.py']], ['AC-004', ['tests/test_ids.py']]])
  })

  test('command sources: the listed files at any depth, outside the root\'s venv, and the git keys; a change outside Files is CMD-SRC', async () => {
    const listed = ['pyproject.toml', 'tests/conftest.py', 'src/a.py', '.venv/lib/x/pyproject.toml', 'requirements-dev.txt', 'sub/.gitignore', 'sub/.venv/conftest.py']
    const w = pyHost(Object.fromEntries(listed.map(f => [`${ROOT}/${f}`, f === 'pyproject.toml' ? '[project]\nname = "x"\n' : `${f}\n`])), { run: argv => (argv.includes('ls-files') ? { exitCode: 0, stdout: argv.includes('-i') ? '' : `${listed.join('\0')}\0`, stderr: '' } : undefined) })
    const { hashes } = await commandSources(w.host.io, await gitPaths(w.host.io, ROOT))
    expect(Object.keys(hashes).sort()).toEqual(['git:config', 'git:config.worktree', 'git:info/exclude', 'pyproject.toml', 'requirements-dev.txt', 'sub/.gitignore', 'sub/.venv/conftest.py', 'tests/conftest.py'])
    expect(cmdSourceVerdict(['pyproject.toml', 'uv.lock'], {}, [])).toEqual({ cmdSrc: ['pyproject.toml', 'uv.lock'], dependencyOnly: [], declared: [], forceSecurity: false })
  })

})

describe('the Python stack: runner integrity (R2 step 6)', () => {
  const SITE = `${ROOT}/.venv/lib/python3.14/site-packages`, PY = '/opt/py/bin/python3.14', H = (c: string): string => c.repeat(64)
  /** The tree script's answer for the root's venv: a `.pth`, pyvenv.cfg and pytest-cov's entry points, as flow-tree.ts prints them. */
  const treeOut = (o: { cfg?: string; pth?: string[] } = {}): string => [
    `hash\t${H('a')} *stdin`, `y\t${H('b')} *${PY}`, `p\t${ROOT}/.venv/bin/python\t${PY}`,
    `r\t${ROOT}/.venv/pyvenv.cfg\t${H('c')}`, `r\t${SITE}/x.pth\t${H('d')}`,
    `x\t${ROOT}/.venv/pyvenv.cfg\t${o.cfg ?? 'include-system-site-packages = false'}`,
    ...(o.pth ?? [`${ROOT}/src`, 'import _virtualenv']).map(l => `x\t${SITE}/x.pth\t${l}`),
    ...['[console_scripts]', 'cov = x:main', '[pytest11]', 'pytest_cov = pytest_cov.plugin'].map(l => `x\t${SITE}/pytest_cov-7.1.0.dist-info/entry_points.txt\t${l}`),
  ].join('\n')
  const venvHost = (out: string, real: (p: string) => string = p => p, files: Record<string, string> = {}) => pyHost({ [`${ROOT}/.venv/pyvenv.cfg`]: 'home = /opt/py/bin\n', ...files }, { run: argv => {
    if (argv[0] !== '/bin/sh') return undefined
    if ((argv[2] ?? '').includes('for m in "$@"')) return { exitCode: 0, stdout: argv.slice(4).map(m => `${'e'.repeat(64)} *${m}.py`).join('\n'), stderr: '' }
    if ((argv[2] ?? '').startsWith('set -u')) return out.startsWith('hash\t') ? { exitCode: 0, stdout: `${out}\n`, stderr: '' } : { exitCode: 3, stdout: '', stderr: `${out}\n` }
    if ((argv[2] ?? '').startsWith('for p in')) return { exitCode: 0, stdout: argv.slice(4).map(p => `${real(p)}\n.\0`).join(''), stderr: '' }
    return undefined
  } })

  test('AC-PY-7, AC-STK-9: the venv tree, its interpreter and what it runs at start; the pytest11 plugins the judge loads by name', async () => {
    const s = await PYTHON_STACK.code.runnerIntegrity(venvHost(treeOut()).host.io, ROOT, [], '/Users/u')
    expect(s.hash).toBe(H('a'))
    expect(s.load).toEqual(['pytest_cov'])
    expect(s.problems).toEqual([])
    // the module the .pth import line runs at start is a start fact too (security review, step 6)
    const facts = JSON.parse(s.facts)
    // the plugin's distribution is pinned (its RECORD is not in this fake: the entry's own module); no folder without a venv
    expect({ ...facts, tool: Object.keys(facts.tool) }).toEqual({ interp: { '.venv': `${PY} ${H('b')}` }, start: { '.venv/lib/python3.14/site-packages/_virtualenv.py': H('e'), '.venv/lib/python3.14/site-packages/x.pth': H('d'), '.venv/pyvenv.cfg': H('c') }, pytest11: ['pytest_cov=pytest_cov.plugin'], tool: ['.venv/lib/python3.14/site-packages/pytest_cov'], others: {} })
    expect(judgedArgv(['.venv/bin/pytest'], 'pytest', '/run', '', s.load).argv.join(' ')).toContain('-p no:cacheprovider -p pytest_cov -o')
  })

  test('S1/S2 refusals (O-4): the system site-packages; a .pth line outside the project, its venvs and the interpreter, also through a link', async () => {
    const sys = await PYTHON_STACK.code.runnerIntegrity(venvHost(treeOut({ cfg: 'include-system-site-packages = True' })).host.io, ROOT, [], '/Users/u')
    expect(sys.problems).toEqual([{ key: 'setup.venvSystem', vars: { venv: '.venv' } }])
    const lines = ['/tmp/evil', '../../../../../elsewhere', '/opt/py/lib/python3.14/x', '# /tmp/comment', `${ROOT}/link`]
    const pth = await PYTHON_STACK.code.runnerIntegrity(venvHost(treeOut({ pth: lines }), p => (p.endsWith('/link') ? '/private/tmp/away' : p)).host.io, ROOT, [], '/Users/u')
    expect(pth.problems.map(x => [x.key, x.vars.file, x.vars.path])).toEqual(['/tmp/evil', pthPaths(`${SITE}/x.pth`, ['../../../../../elsewhere'])[0], `${ROOT}/link`].map(p => ['setup.venvPath', '.venv/lib/python3.14/site-packages/x.pth', p]))
  })

  test('S1: the echo lists the plugins the judge loads by name; a refusal or a tree that cannot be pinned stops setup', async () => {
    const files = { [`${ROOT}/pyproject.toml`]: PYPROJECT_535 }
    const ok = await detectSetup(venvHost(treeOut(), undefined, files).host, ARGS)
    if (!ok.ok) throw new Error(ok.refusals.join('\n'))
    expect(ok.draft.runner.hash).toBe(H('a'))
    expect(setupEcho(venvHost(treeOut()).host, ok.draft).lines).toContain('pytest plugins in the venv (pytest11) the judge loads by name: pytest_cov')
    const sys = await detectSetup(venvHost(treeOut({ cfg: 'include-system-site-packages = true' }), undefined, files).host, ARGS)
    expect(sys.ok ? [] : sys.refusals).toContain('.venv sees the system site-packages (include-system-site-packages = true in pyvenv.cfg): create the venv again without --system-site-packages')
    const link = await detectSetup(venvHost(`link\t${SITE}/evil.py\t/tmp/evil.py`, undefined, files).host, ARGS)
    expect(link.ok ? [] : link.refusals).toContain(`the runner cannot be pinned: ${SITE}/evil.py is a link to /tmp/evil.py, outside the dependency folders and the package managers' caches; reinstall without links that leave the project`)
    const read = await detectSetup(venvHost(`find: ${SITE}/x: Permission denied\nread\tfind\t`, undefined, files).host, ARGS)
    expect(read.ok ? [] : read.refusals).toContain('the runner cannot be pinned: its files cannot all be read (find)')
  })

  test('the standard library of the venv\'s base interpreter is hashed once at S1 for the echo, its site-packages aside (GAP-R2-0.6-7)', async () => {
    const lib = '/opt/py/lib/python3.14', hashed = (bs: ReadonlyArray<{ path: string; hash: string | null }>) => bs.map(b => [b.path, /^[0-9a-f]{64}$/.test(b.hash ?? '')])
    const files = { [`${ROOT}/pyproject.toml`]: PYPROJECT_535, [`${ROOT}/.venv/pyvenv.cfg`]: 'home = /opt/py/bin\nversion_info = 3.14.0\n', [`${lib}/os.py`]: '', [`${lib}/json/__init__.py`]: '', [`${lib}/site-packages/x.py`]: '' }
    const w = venvHost(treeOut(), undefined, files)
    const out = await detectSetup(w.host, ARGS)
    if (!out.ok) throw new Error(out.refusals.join('\n'))
    expect(hashed(out.draft.bases)).toEqual([[lib, true]])
    expect(w.runs.filter(a => a.includes(`${lib}/os.py`)).map(a => a.slice(4).sort())).toEqual([[`${lib}/json`, `${lib}/os.py`]])
    expect(setupEcho(w.host, out.draft).lines).toContain(`Standard library of the venv's base interpreter (outside the project and the sandbox's write paths, so hashed only here): ${lib} ${out.draft.bases[0]?.hash?.slice(0, 8)}`)
    // no version in pyvenv.cfg: the one python3.* folder there; none there: said, not hashed, not refused
    expect(hashed(await baseLibraries(venvHost(treeOut(), undefined, { [`${lib}/os.py`]: '' }).host.io, ROOT, []))).toEqual([[lib, true]])
    const none = await detectSetup(venvHost(treeOut(), undefined, { [`${ROOT}/pyproject.toml`]: PYPROJECT_535 }).host, ARGS)
    if (!none.ok) throw new Error(none.refusals.join('\n'))
    expect(setupEcho(w.host, none.draft).lines).toContain("Standard library of the venv's base interpreter: not found or not readable from /opt/py/lib, so not hashed")
  })

  test('bin/pyvenv.cfg comes first and venv\'s `version` names the library; a hashing run that fails, or a cfg with no absolute home, gives a null hash and its echo line (reviews r1)', async () => {
    const lib = '/opt/py/lib/python3.14'
    const bin = { [`${ROOT}/.venv/bin/pyvenv.cfg`]: 'home = /opt/py/bin\nversion = 3.14.0rc1\n', [`${ROOT}/.venv/pyvenv.cfg`]: 'home = /other/bin\nversion_info = 3.12\n', [`${lib}/os.py`]: '' }
    expect((await baseLibraries(venvHost(treeOut(), undefined, bin).host.io, ROOT, [])).map(b => b.path)).toEqual([lib])
    const failing = pyHost({ [`${ROOT}/.venv/pyvenv.cfg`]: 'home = /opt/py/bin\nversion_info = 3.14\n', [`${lib}/os.py`]: '' }, { run: argv => { if ((argv[2] ?? '').includes('for m in "$@"')) throw new Error('timed out'); return undefined } })
    expect(await baseLibraries(failing.host.io, ROOT, [])).toEqual([{ path: lib, hash: null }])
    const noHome = venvHost(treeOut(), undefined, { [`${ROOT}/pyproject.toml`]: PYPROJECT_535, [`${ROOT}/.venv/pyvenv.cfg`]: 'version = 3.12\n' })
    const out = await detectSetup(noHome.host, ARGS)
    if (!out.ok) throw new Error(out.refusals.join('\n'))
    expect(out.draft.bases).toEqual([{ path: `${ROOT}/.venv/pyvenv.cfg`, hash: null }])
    expect(setupEcho(noHome.host, out.draft).lines).toContain(`Standard library of the venv's base interpreter: not found or not readable from ${ROOT}/.venv/pyvenv.cfg, so not hashed`)
  })

  test('a refusal of S1 seen at a later check (a .pth line now leads out) is a changed runner, with what failed', async () => {
    const w = venvHost(treeOut({ pth: ['/tmp/evil'] })), r = activeRecord()
    const rec = { ...r, setup: r.setup ? { ...r.setup, stack: 'python', commands: [] } : r.setup, frozen: { ...r.frozen, 'runner:v2': H('a') } }
    expect((await sourcesDrift(w.host, rec)).runner).toMatchObject({ changed: true, error: '.venv/lib/python3.14/site-packages/x.pth /tmp/evil' })
  })

  test('a re-baseline leaves the toolchain packages as they were (owner decision 2026-10-19): changed, added or gone blocks', () => {
    const f = (tool: Record<string, string>) => JSON.stringify({ interp: {}, start: {}, pytest11: [], tool }), k = '.venv/lib/python3.14/site-packages/_pytest'
    expect([venvRebaseBlock(f({ [k]: H('a') }), f({ [k]: H('a') })), venvRebaseBlock(f({ [k]: H('a') }), f({ [k]: H('b') })), venvRebaseBlock(f({}), f({ [k]: H('a') })), venvRebaseBlock(f({ [k]: H('a') }), f({}))]).toEqual([null, `${k} (toolchain)`, `${k} (toolchain)`, `${k} (toolchain)`])
  })

  test('security review round 4: a venv or a pyvenv.cfg gone, or an interpreter folder without one changed, never re-baselines; a .pth gone does', () => {
    const f = (o: Record<string, unknown>) => JSON.stringify({ interp: { '.venv': 'p h' }, start: { '.venv/pyvenv.cfg': H('c'), '.venv/bin/pyvenv.cfg': H('d'), '.venv/x.pth': H('e') }, pytest11: [], tool: {}, others: { 'tools/py': H('f') }, ...o })
    expect([
      venvRebaseBlock(f({}), f({ interp: {} })),
      venvRebaseBlock(f({}), f({ start: { '.venv/pyvenv.cfg': H('c'), '.venv/x.pth': H('e') } })),
      venvRebaseBlock(f({}), f({ others: { 'tools/py': H('a') } })),
      venvRebaseBlock(f({}), f({ others: {} })),
      venvRebaseBlock(f({}), f({ start: { '.venv/pyvenv.cfg': H('c'), '.venv/bin/pyvenv.cfg': H('d') } })),
    ]).toEqual(['.venv/bin/python', '.venv/bin/pyvenv.cfg', 'tools/py', 'tools/py', null])
  })

  test('security review round 4: a .pth import line that computes what it imports is refused; the forms the facts can follow pass', async () => {
    const problems = async (line: string) => (await PYTHON_STACK.code.runnerIntegrity(venvHost(treeOut({ pth: [line] })).host.io, ROOT, [], '/Users/u')).problems.map(p => p.vars.path)
    for (const line of ['import sys; exec("imp" + "ort evil")', 'import sys; getattr(__builtins__, "__imp" + "ort__")("evil")', 'import os; eval(os.environ["X"])', "import importlib; importlib.import_module(name)"]) expect([line, await problems(line)]).toEqual([line, ['(an import line that computes what it imports)']])
    for (const line of ["import os; var = 'X'; enabled = os.environ.get(var, 'local') == 'local'; enabled and __import__('_distutils_hack').add_shim(); ", "import os, sys;exec('if \\'COV\\' in os.environ:\\n from pytest_cov.embed import init\\n init()\\n')", 'import _virtualenv', "import sys, types, os;importlib = __import__('importlib.util');m = importlib.util.module_from_spec(None)"]) expect([line, await problems(line)]).toEqual([line, []])
  })

  test('pytest11Of and pthPaths read the files as setuptools and site.py do', () => {
    expect(pytest11Of(['[pytest11]', 'a = a.plugin', '; comment', '[ console_scripts ]', 'b = b:main', '[ pytest11 ]', 'c=c'])).toEqual(['a=a.plugin', 'c=c'])
    expect(pthPaths('/v/site/x.pth', ['/abs/dir  ', 'rel/dir', '#c', '   ', 'import os; os.x()', 'importer'])).toEqual(['/abs/dir', '/v/site/rel/dir', '/v/site/importer'])
    expect(pthPaths('/v/site/x.pth', ['/proj/src\r/elsewhere'])).toEqual(['/proj/src', '/elsewhere']) // \r ends a line for every version
    // every import an import line can make, the strings an exec runs and __import__ included (security review, step 6)
    expect(pthImports(['import _virtualenv', 'import os, sys; exec("import evil")', 'import a.b as c', '/path', 'importer'])).toEqual(['_virtualenv', 'os', 'sys', 'evil', 'a'])
    expect(pthImports(["import os; var = 'X'; enabled = os.environ.get(var) == 'local'; enabled and __import__('_distutils_hack').add_shim();"])).toEqual(['os', '_distutils_hack'])
  })

  test('AC-RI-3: a dependency change re-baselines only when it adds or changes nothing the venv runs at start', () => {
    const f = (o: Partial<{ interp: Record<string, string>; start: Record<string, string>; pytest11: string[] }> = {}): string => JSON.stringify({ interp: { '.venv': 'py h' }, start: { '.venv/pyvenv.cfg': 'c', 'site/a.pth': 'p' }, pytest11: ['a=a'], ...o })
    expect(venvRebaseBlock(f(), f())).toBeNull()
    expect(venvRebaseBlock(f(), f({ start: { '.venv/pyvenv.cfg': 'c' }, pytest11: [] }))).toBeNull() // removals pass
    expect(venvRebaseBlock(f(), f({ start: { '.venv/pyvenv.cfg': 'c', 'site/a.pth': 'p', 'site/b.pth': 'q' } }))).toBe('site/b.pth')
    expect(venvRebaseBlock(f(), f({ start: { '.venv/pyvenv.cfg': 'c2', 'site/a.pth': 'p' } }))).toBe('.venv/pyvenv.cfg')
    expect(venvRebaseBlock(f(), f({ start: { '.venv/pyvenv.cfg': 'c', 'site/a.pth': 'p2' } }))).toBe('site/a.pth') // GAP-R2-0.6-63
    expect(venvRebaseBlock(f(), f({ interp: { '.venv': 'py2 h' } }))).toBe('.venv/bin/python')
    expect(venvRebaseBlock(f(), f({ pytest11: ['a=a', 'evil=evil.plugin'] }))).toBe('pytest11 evil=evil.plugin')
    expect(venvRebaseBlock('', f())).not.toBeNull()
  })

  test('no venv: absent, and the tree script never runs', async () => {
    const w = pyHost({})
    expect((await PYTHON_STACK.code.runnerIntegrity(w.host.io, ROOT, [], '/Users/u')).hash).toBe('absent')
    expect(w.runs.some(a => (a[2] ?? '').startsWith('set -u'))).toBe(false)
  })
})

describe('the Python stack\'s build output (535 trial M-4)', () => {
  test('the ignored-file set leaves out pytest-cov\'s .coverage data file, at the root or deeper', async () => {
    const lsFiles = ['.coverage', 'pkg/.coverage', 'htmlcov/', 'notes.txt', ''].join('\0')
    const io = { read: async () => '', write: async () => {}, exists: async () => false, list: async () => [], now: async () => 0, pluginRoot: '/mod', run: async () => ({ exitCode: 0, stdout: lsFiles, stderr: '' }) }
    const got = await ignoredSet(io, { top: '/r', commonDir: '/r/.git', gitDir: '/r/.git', index: '/r/.git/index' }, ignoredSkip(PYTHON))
    expect(got.names).toEqual(['notes.txt'])
  })

  test('the ignored-file set leaves out the test run\'s caches .hypothesis/ and __pycache__/ at any depth (535 trial 2, M-6)', async () => {
    const lsFiles = ['.hypothesis/', 'tests/__pycache__/', '__pycache__/', 'src/pkg/__pycache__/', 'notes.txt', 'pycache_notes/', ''].join('\0')
    const io = { read: async () => '', write: async () => {}, exists: async () => false, list: async () => [], now: async () => 0, pluginRoot: '/mod', run: async () => ({ exitCode: 0, stdout: lsFiles, stderr: '' }) }
    const got = await ignoredSet(io, { top: '/r', commonDir: '/r/.git', gitDir: '/r/.git', index: '/r/.git/index' }, ignoredSkip(PYTHON))
    expect(got.names).toEqual(['notes.txt', 'pycache_notes/'])
  })
})
