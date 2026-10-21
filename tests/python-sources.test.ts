import { describe, expect, test } from 'claude-code/testing'
import { readToml } from '../flow/toml'
import { gitPaths } from '../hooks/flow-git'
import { cmdSourceVerdict, commandSources, configRefs, lockDepsOnly, pFlagNames, pluginBindings, pyprojectDepsOnly, pytestPlugins, shadowedFor, shadowFiles, sysPathRoots } from '../hooks/stacks/python-sources'
import { fakeHost, ROOT } from './flow-fakes'
import { TOML_CASES } from './fixtures/toml-cases'

/** A project whose listed (tracked or untracked) files and ignored files git reports as given. */
const host = (files: Record<string, string>, ignored: Record<string, string> = {}) => fakeHost({
  files: Object.fromEntries(Object.entries({ ...files, ...ignored }).map(([k, v]) => [`${ROOT}/${k}`, v])),
  run: argv => (argv.includes('ls-files') ? { exitCode: 0, stdout: `${Object.keys(argv.includes('-i') ? ignored : files).join('\0')}\0`, stderr: '' } : undefined),
})
const sources = async (files: Record<string, string>, ignored: Record<string, string> = {}, argvs: string[][] = []) => {
  const w = host(files, ignored)
  return commandSources(w.host.io, await gitPaths(w.host.io, ROOT), argvs)
}
const GIT_KEYS = ['git:config', 'git:config.worktree', 'git:info/exclude']

describe('the strict TOML reader against tomllib (R2 plan S-14: values produced once with Python 3.14)', () => {
  test('every case reads as tomllib reads it, or is refused where the reader refuses by design', () => {
    for (const c of TOML_CASES) expect([c.name, readToml(c.input)]).toEqual([c.name, c.ours === 'same' ? JSON.parse(c.tomllib) : null])
  })
})

describe('the Python command sources (R2 step 5: AC-PY-6, AC-STK-8, GAP-R2-0.6-10, -11, -46)', () => {
  test('the setup chain: conftests, the plugins pytest_plugins and -p name (configs and command lines), what they import, the packages above', async () => {
    const files = {
      'pyproject.toml': '[tool.pytest.ini_options]\naddopts = ["-p", "tests.plugins.db"]\n[tool.mypy]\nplugins = ["tools.mypy_plugin"]\n[tool.ruff]\nextend = "ruff-base.toml"\n',
      'ruff-base.toml': 'line-length = 100\n', 'tools/mypy_plugin.py': 'def plugin(v): ...\n',
      'tests/conftest.py': 'pytest_plugins = ["tests.fixtures.data"]\nfrom lotto535.contracts import draw_schedule\n',
      'tests/fixtures/data.py': 'import json\n', 'tests/plugins/db.py': 'X = 1\n', 'tests/plugins/extra.py': 'Y = 2\n', 'tests/test_a.py': 'def test_a(): ...\n',
      'src/lotto535/__init__.py': '', 'src/lotto535/contracts.py': 'from .models import Draw\n', 'src/lotto535/models.py': 'class Draw: ...\n', 'src/lotto535/app.py': 'unrelated\n',
      'tests/json.py': 'SHADOW = 1\n',
    }
    const out = await sources(files, { 'gen/fast.so': 'ELF' }, [['.venv/bin/pytest', '-p', 'tests.plugins.extra']])
    const chain = ['src/lotto535/__init__.py', 'src/lotto535/contracts.py', 'src/lotto535/models.py', 'tests/conftest.py', 'tests/fixtures/data.py', 'tests/plugins/db.py', 'tests/plugins/extra.py']
    expect([...out.reached].sort()).toEqual(chain)
    expect([...out.setupChain].sort()).toEqual(chain)
    expect(Object.keys(out.hashes).sort()).toEqual([...GIT_KEYS, 'gen/fast.so', 'pyproject.toml', 'ruff-base.toml', ...chain, 'tests/json.py', 'tools/mypy_plugin.py'].sort())
  })

  test('a config the strict reader cannot read, or a ruff extend outside the root, marks the closure truncated', async () => {
    expect((await sources({ 'pyproject.toml': '[tool.ruff]\nextend = "a"\nextend = "b"\n' })).hashes['closure:truncated']).toBe('yes')
    expect((await sources({ 'ruff.toml': 'extend = "~/base.toml"\n' })).hashes['closure:truncated']).toBe('yes')
    expect((await sources({ 'pyproject.toml': '[project]\nname = "x"\n' })).hashes['closure:truncated']).toBeUndefined()
  })

  test('the names -p loads, pytest_plugins, mypy plugins in an INI file, and the files that would shadow a runner or stdlib module', () => {
    expect(pFlagNames('addopts = -p xdist -pno:cacheprovider -ptests.plug "-p", "a.b" -p no:x --pdb')).toEqual(['xdist', 'tests.plug', 'a.b'])
    expect(pytestPlugins('import x\npytest_plugins = (\n    "a.b",\n    "c",\n)\n')).toEqual(['a.b', 'c'])
    expect(pytestPlugins('pytest_plugins = "one.two"\n')).toEqual(['one.two'])
    expect(configRefs('mypy.ini', '[mypy]\nplugins = a.b, tools/p.py:entry\n').mypy).toEqual(['a.b', 'tools/p.py'])
    const fs = ['json.py', 'src/typing/__init__.py', 'tests/pytest.py', 'tests/conftest.py', 'pkg/json.py', 'tests/sub/__init__.py', 'tests/sub/test_x.py', 'tests/sub/os.py', 'pluggy.cpython-314-darwin.so']
    expect(shadowFiles(fs, sysPathRoots(fs, []))).toEqual(['json.py', 'src/typing/__init__.py', 'tests/pytest.py', 'pluggy.cpython-314-darwin.so'])
    // the venv's minor version picks its list (read from real interpreters 3.11–3.14); another version takes them all
    expect([shadowedFor('version_info = 3.11').has('asyncore'), shadowedFor('version_info = 3.14').has('asyncore'), shadowedFor('version = 3.14.8').has('annotationlib'), shadowedFor('version_info = 3.99').has('asyncore'), shadowedFor('').has('annotationlib')]).toEqual([true, false, true, true, true])
  })
})

describe('the Python CMD-SRC verdict: declared setup files and dependency-only edits (R2 step 5: AC-PY-6, AC-PY-8)', () => {
  const PY = (deps: string[], dev = ['pytest>=9'], version = '0.1.0') => `[project]\nname = "x"\nversion = "${version}"\ndependencies = [${deps.map(d => JSON.stringify(d)).join(', ')}]\n\n[dependency-groups]\ndev = [${dev.map(d => JSON.stringify(d)).join(', ')}]\n`
  const HEAD = 'version = 1\nrevision = 3\nrequires-python = ">=3.14"\n'
  const root = (deps: string[]) => `\n[[package]]\nname = "x"\nversion = "0.1.0"\nsource = { editable = "." }\ndependencies = [${deps.map(d => `{ name = "${d}" }`).join(', ')}]\n`
  const pkg = (name: string, version: string) => `\n[[package]]\nname = "${name}"\nversion = "${version}"\nsource = { registry = "https://pypi.org/simple" }\nsdist = { url = "https://files.pythonhosted.org/packages/${name}-${version}.tar.gz", hash = "sha256:00", size = 1 }\n`
  const LOCK = HEAD + root(['numpy']) + pkg('numpy', '2.3.0'), LOCK2 = HEAD + root(['numpy', 'requests']) + pkg('numpy', '2.3.0') + pkg('requests', '2.32.3')
  const files = ['pyproject.toml', 'uv.lock']
  const verdict = (py: string, lock: string, fFiles = files) => cmdSourceVerdict(files, { 'pyproject.toml': { before: PY(['numpy>=2']), after: py }, 'uv.lock': { before: LOCK, after: lock } }, fFiles)

  test('a conftest or a module it reaches, declared in Files: a reviewed edit that forces Security: yes; undeclared, or a mypy plugin: CMD-SRC', () => {
    expect(cmdSourceVerdict(['tests/conftest.py'], {}, ['tests/conftest.py'], ['tests/conftest.py'], ['tests/conftest.py'])).toEqual({ cmdSrc: [], dependencyOnly: [], declared: ['tests/conftest.py'], forceSecurity: true })
    expect(cmdSourceVerdict(['tests/conftest.py'], {}, [], ['tests/conftest.py'], ['tests/conftest.py']).cmdSrc).toEqual(['tests/conftest.py'])
    expect(cmdSourceVerdict(['tools/mypy_plugin.py'], {}, ['tools/mypy_plugin.py'], [], []).cmdSrc).toEqual(['tools/mypy_plugin.py'])
  })

  test('a dependency added to [project.dependencies] with its uv.lock entry, both in Files, from the same index: dependency-only', () => {
    expect(verdict(PY(['numpy>=2', 'requests>=2.32']), LOCK2)).toEqual({ cmdSrc: [], dependencyOnly: files, declared: [], forceSecurity: false })
  })

  test('a toolchain version, a direct URL, any other pyproject change, an unreadable file, a lock outside Files: CMD-SRC', () => {
    expect(verdict(PY(['numpy>=2'], ['pytest>=9.2']), LOCK).cmdSrc).toEqual(files)
    expect(verdict(PY(['numpy>=2', 'requests @ https://x.test/r.whl']), LOCK2).cmdSrc).toEqual(files)
    expect(verdict(PY(['numpy>=2', 'pluggy>=1.6']), LOCK2).cmdSrc).toEqual(files)
    expect(verdict(PY(['numpy>=2'], ['pytest>=9'], '0.2.0'), LOCK).cmdSrc).toEqual(files)
    expect(verdict(PY(['numpy>=2', 'requests']).replace('[project]', '[project]\nname = "dup"'), LOCK2).cmdSrc).toEqual(files) // a key twice: unreadable
    expect(verdict(PY(['numpy>=2', 'requests>=2.32']), LOCK2, ['pyproject.toml'])).toEqual({ cmdSrc: ['uv.lock'], dependencyOnly: ['pyproject.toml'], declared: [], forceSecurity: false })
  })

  test('a lock entry from another index or host, or a toolchain package in the lock, is not dependency-only', () => {
    expect(lockDepsOnly('uv', LOCK, LOCK2)).toBe(true)
    expect(lockDepsOnly('uv', LOCK, LOCK2.replace(/registry = "https:\/\/pypi\.org\/simple" \}\nsdist = \{ url = "https:\/\/files\.pythonhosted\.org\/packages\/requests/, 'registry = "https://corp.test/simple" }\nsdist = { url = "https://files.pythonhosted.org/packages/requests'))).toBe(false)
    expect(lockDepsOnly('uv', LOCK, LOCK2.replace('files.pythonhosted.org/packages/requests', 'evil.test/requests'))).toBe(false)
    expect(lockDepsOnly('uv', LOCK, LOCK + pkg('pytest', '9.2.0'))).toBe(false)
    expect(lockDepsOnly('uv', LOCK, LOCK2.replace('revision = 3', 'revision = 4'))).toBe(false)
  })

  test('type stubs (types-*, *-stubs) are toolchain: mypy reads them (owner decision 2026-10-19)', () => {
    for (const stub of ['types-requests', 'pandas-stubs', 'Types_PyYAML'])
      expect([stub, verdict(PY(['numpy>=2', `${stub}>=1`]), LOCK2).cmdSrc]).toEqual([stub, files])
    expect(lockDepsOnly('uv', LOCK, LOCK + pkg('types-requests', '2.32.0'))).toBe(false)
    expect(lockDepsOnly('uv', LOCK, LOCK + pkg('pandas-stubs', '2.2.0'))).toBe(false)
    expect(verdict(PY(['numpy>=2', 'typesetter>=1']), LOCK2).cmdSrc).toEqual([]) // a name that only starts like a stub's
  })

  test('poetry: a dependency table entry and its poetry.lock package (the content hash changes with it)', () => {
    const py = (extra = '') => `[tool.poetry]\nname = "x"\nversion = "0.1.0"\n\n[tool.poetry.dependencies]\npython = "^3.12"\nnumpy = "^2"\n${extra}`
    const ppkg = (name: string) => `[[package]]\nname = "${name}"\nversion = "1.0"\ndescription = ""\noptional = false\npython-versions = ">=3.8"\nfiles = [\n    {file = "${name}-1.0-py3-none-any.whl", hash = "sha256:00"},\n]\n\n`
    const lock = (pkgs: string, hash: string) => `${pkgs}[metadata]\nlock-version = "2.1"\npython-versions = "^3.12"\ncontent-hash = "${hash}"\n`
    expect(pyprojectDepsOnly(py(), py('requests = "^2.32"\n'))).toBe(true)
    expect(pyprojectDepsOnly(py(), py('requests = { git = "https://x.test/r.git" }\n'))).toBe(false)
    expect(lockDepsOnly('poetry', lock(ppkg('numpy'), 'aa'), lock(ppkg('numpy') + ppkg('requests'), 'bb'))).toBe(true)
    expect(lockDepsOnly('poetry', lock(ppkg('numpy'), 'aa'), lock(ppkg('numpy') + ppkg('pytest-cov'), 'bb'))).toBe(false)
  })
})

describe('the Python command sources after the step-5 reviews', () => {
  const keys = async (files: Record<string, string>, ignored: Record<string, string> = {}, argvs: string[][] = []) => sources(files, ignored, argvs)

  test('the package __init__.py above a conftest runs first: hashed, reached, in the setup chain', async () => {
    const out = await keys({ 'tests/__init__.py': '', 'tests/conftest.py': 'X = 1\n', 'src/myproj/__init__.py': '', 'src/myproj/conftest.py': 'Y = 2\n' })
    expect([...out.setupChain].sort()).toEqual(['src/myproj/__init__.py', 'src/myproj/conftest.py', 'tests/__init__.py', 'tests/conftest.py'])
  })

  test('an ignored module a conftest imports is followed and hashed; one only a build folder holds (at any depth) truncates', async () => {
    const ignoredOk = await keys({ 'tests/conftest.py': 'from tests.gen.helpers import x\n' }, { 'tests/gen/helpers.py': 'x = 1\n' })
    expect(ignoredOk.reached).toContain('tests/gen/helpers.py')
    expect(ignoredOk.hashes['closure:truncated']).toBeUndefined()
    for (const [spec, file] of [['build.gen', 'build/gen.py'], ['tests.build.helpers', 'tests/build/helpers.py']]) {
      const w = host({ 'tests/conftest.py': `from ${spec} import x\n` }, {})
      w.files.set(`${ROOT}/${file}`, 'x = 1\n') // git leaves the build folder out of both listings
      expect([spec, (await commandSources(w.host.io, await gitPaths(w.host.io, ROOT))).hashes['closure:truncated']]).toEqual([spec, 'yes'])
    }
  })

  test('pytest_plugins named through a variable or += is followed; names built at run time truncate the closure; -p in a flag bundle', async () => {
    const out = await keys({ 'tests/conftest.py': 'PLUGINS = ["tests.fx.db"]\npytest_plugins = PLUGINS\npytest_plugins += ["tests.fx.web"]\n', 'tests/fx/db.py': '', 'tests/fx/web.py': '' })
    expect(out.reached).toEqual(expect.arrayContaining(['tests/fx/db.py', 'tests/fx/web.py']))
    expect(pluginBindings('pytest_plugins = [f"tests.{n}" for n in NAMES]\n').built).toBe(true)
    expect(pluginBindings('pytest_plugins = PLUGINS + ["a"]\n').built).toBe(false)
    expect(pFlagNames('-qp mod.one -qpmod.two -rp')).toEqual(['mod.one', 'mod.two'])
  })

  test('pythonpath and every test basedir are sys.path folders: plugins resolve there and shadow names count there', async () => {
    const out = await keys({ 'pyproject.toml': '[tool.pytest.ini_options]\npythonpath = ["lib"]\naddopts = "-p myplug.timing"\n', 'lib/myplug/timing.py': '', 'lib/decimal.py': '', 'tests/pkg/__init__.py': '', 'tests/pkg/test_a.py': '', 'tests/random.py': '' })
    expect(out.reached).toContain('lib/myplug/timing.py')
    expect(Object.keys(out.hashes)).toEqual(expect.arrayContaining(['lib/decimal.py', 'tests/random.py']))
  })

  test('a mypy plugin by path and an ignored ruff extend are hashed; a path above the root truncates', async () => {
    const out = await keys({ 'mypy.ini': '[mypy]\nplugins = ./tools/plug.py\n', 'tools/plug.py': 'def plugin(v): ...\n' })
    expect(out.hashes['tools/plug.py']).toBeDefined()
    expect(out.reached).not.toContain('tools/plug.py')
    const w = host({ 'ruff.toml': 'extend = "ruff-base.toml"\n' })
    w.files.set(`${ROOT}/ruff-base.toml`, 'ignore = ["ALL"]\n')
    expect((await commandSources(w.host.io, await gitPaths(w.host.io, ROOT))).hashes['ruff-base.toml']).toBeDefined()
    expect((await keys({ 'ruff.toml': 'extend = "../../base.toml"\n' })).hashes['closure:truncated']).toBe('yes')
    expect((await keys({ 'mypy.ini': '[mypy]\nplugins = ../outside.py\n' })).hashes['closure:truncated']).toBe('yes')
  })
})

describe('the Python dependency-only rule after the step-5 reviews', () => {
  const poetry = (extra = '') => `[tool.poetry]\nname = "x"\nversion = "0.1.0"\n\n[tool.poetry.dependencies]\npython = "^3.12"\nnumpy = "^2"\n${extra}`
  test('poetry: a source key, a dotted key naming a toolchain package, a git source behind a known url: not dependency-only', () => {
    expect(pyprojectDepsOnly(poetry(), poetry('requests = {version = "^2", source = "internal"}\n'))).toBe(false)
    expect(pyprojectDepsOnly(poetry(), poetry('"pytest.cov" = "^6"\n'))).toBe(false)
    expect(pyprojectDepsOnly(poetry(), poetry('requests = {version = "^2", extras = ["socks"]}\n'))).toBe(true)
    const pkg = (name: string, source = '') => `[[package]]\nname = "${name}"\nversion = "1.0"\nfiles = []\n${source}\n`
    const lock = (pkgs: string) => `${pkgs}[metadata]\nlock-version = "2.1"\ncontent-hash = "x"\n`
    const git = '[package.source]\ntype = "git"\nurl = "https://x.test/foo.git"\nreference = "HEAD"\nresolved_reference = "abc"\n'
    expect(lockDepsOnly('poetry', lock(pkg('foo', git)), lock(pkg('foo', git) + pkg('bar', git.replace('foo', 'bar').replace('https://x.test/bar.git', 'https://x.test/foo.git'))))).toBe(false)
  })

  test('a package a config loads plugins from is toolchain; an include-group is no package; inf and nan stay apart', () => {
    const py = (deps: string, rest = '') => `[project]\nname = "x"\nversion = "0.1.0"\ndependencies = [${deps}]\n\n[dependency-groups]\ndev = ["ruff"]\nall = [${rest}]\n\n[tool.mypy]\nplugins = ["pydantic.mypy"]\n`
    expect(pyprojectDepsOnly(py('"pydantic>=2"'), py('"pydantic>=2.9"'))).toBe(false)
    expect(pyprojectDepsOnly(py('"pydantic>=2"'), py('"pydantic>=2"', '{include-group = "dev"}'))).toBe(true)
    const cov = (v: string) => `[project]\nname = "x"\ndependencies = []\n[tool.coverage.report]\nfail_under = ${v}\n`
    expect(pyprojectDepsOnly(cov('inf'), cov('nan'))).toBe(false)
  })

  test('the reader normalises CRLF as tomllib does and refuses a key deeper than its nesting cap', () => {
    expect(readToml('description = """a\r\nb"""\r\n')).toEqual({ description: 'a\nb' })
    expect(readToml(`[${Array.from({ length: 40 }, () => 'a').join('.')}]\n`)).toBeNull()
  })
})

describe('the Python command sources after the step-5 re-review', () => {
  test('names a comprehension or a write through globals() builds truncate; a tuple of literals does not', () => {
    expect(pluginBindings('PLUGINS = [f"myproj.testing.{n}" for n in ("db", "auth")]\npytest_plugins = PLUGINS\n').built).toBe(true)
    expect(pluginBindings('globals()["pytest_plugins"] = ["a"]\n').built).toBe(true)
    expect(pluginBindings('pytest_plugins = ("tests.a", "tests.b")\n')).toEqual({ names: ['tests.a', 'tests.b'], built: false })
    expect(pluginBindings('import pytest\npytest_plugins = ["pytester"]\n@pytest.mark.parametrize("app", ["myproj"])\ndef test_x(app): ...\n').names).toEqual(['pytester'])
  })

  test('every sys.path candidate of an import is followed (pytest may put the basedir first); many named files leave the conftests reached', async () => {
    const out = await sources({ 'tests/conftest.py': 'from helpers import x\n', 'helpers.py': 'x = 1\n', 'tests/helpers.py': 'x = 2\n' })
    expect(out.reached).toEqual(expect.arrayContaining(['helpers.py', 'tests/helpers.py']))
    const many = Object.fromEntries([...Array.from({ length: 310 }, (_, i) => [`pkg${i}/.gitignore`, '*.log\n']), ['tests/conftest.py', 'X = 1\n']])
    expect((await sources(many)).reached).toEqual(['tests/conftest.py'])
  })

  test('a package the pyproject loads a plugin from is toolchain in its lockfile too: a relock that moves it is not dependency-only', () => {
    const py = (deps: string) => `[project]\nname = "x"\nversion = "0.1.0"\ndependencies = [${deps}]\n\n[tool.pytest.ini_options]\naddopts = "-p anyio"\n`
    const head = 'version = 1\nrevision = 3\nrequires-python = ">=3.14"\n'
    const pkg = (name: string, version: string) => `\n[[package]]\nname = "${name}"\nversion = "${version}"\nsource = { registry = "https://pypi.org/simple" }\nsdist = { url = "https://files.pythonhosted.org/packages/${name}-${version}.tar.gz", hash = "sha256:00", size = 1 }\n`
    const texts = { 'pyproject.toml': { before: py('"httpx>=0.27"'), after: py('"httpx>=0.28"') }, 'uv.lock': { before: head + pkg('httpx', '0.27.0') + pkg('anyio', '4.0.0'), after: head + pkg('httpx', '0.28.0') + pkg('anyio', '4.9.0') } }
    expect(cmdSourceVerdict(['pyproject.toml', 'uv.lock'], texts, ['pyproject.toml', 'uv.lock'])).toEqual({ cmdSrc: ['uv.lock'], dependencyOnly: ['pyproject.toml'], declared: [], forceSecurity: false })
    expect(lockDepsOnly('uv', texts['uv.lock'].before, texts['uv.lock'].after)).toBe(true) // no plugins named: an ordinary relock
  })
})
