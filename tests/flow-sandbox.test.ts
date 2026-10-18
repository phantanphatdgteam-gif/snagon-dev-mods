import { describe, expect, test } from 'claude-code/testing'
import { TYPESCRIPT } from '../flow/data/stacks'
import {
  detectManagers, proposeBlock, postText, sandboxRefusals, effectiveOf, verifyAfterWrite, authEnvNames, npmrcHasAuth,
  pluginRootRefusals, judgeProfile, judgeArgv, probeShowsSandbox, PROTECTED_DIRS, type Settings,
} from '../hooks/flow-sandbox'

const HOME = '/Users/u'
const ROOT = '/Users/u/dev/app'
const CTX = { home: HOME, root: ROOT, protectedPaths: [`${HOME}/.claude`, `${HOME}/.snagon`, '/Users/u/.claude/plugins/cache/snagon'], denyRead: [`${HOME}/.ssh`, `${HOME}/.snagon/flow`, `${HOME}/.claude/projects`] }
const keys = (r: { key: string; layer: string }[]): string[] => r.map(x => `${x.layer}:${x.key}`).sort()

describe('flow sandbox setup', () => {
  test('the proposed block takes registries and caches from the lockfiles found, and hides credentials and flow records', () => {
    expect(detectManagers(TYPESCRIPT, ['package.json', 'pnpm-lock.yaml', 'src'])).toEqual(['pnpm'])
    expect(detectManagers(TYPESCRIPT, ['package.json'])).toEqual(['npm'])
    expect(detectManagers(TYPESCRIPT, ['README.md'])).toEqual([])
    const block = proposeBlock(TYPESCRIPT, ['yarn', 'npm'])
    expect([block.enabled, block.allowUnsandboxedCommands]).toEqual([true, false])
    expect(block.network.allowedDomains).toEqual(['registry.npmjs.org', 'registry.yarnpkg.com'])
    expect(block.filesystem.allowWrite).toContain('~/.npm')
    expect(block.filesystem.allowWrite).toContain('~/Library/Caches/Yarn')
    for (const p of ['~/.ssh', '~/.npmrc', '~/.claude/projects', '~/.snagon/flow']) expect(block.filesystem.denyRead).toContain(p)
  })

  test('post keeps every other key of the local settings file and replaces only the sandbox; a file that is not an object is refused', () => {
    const block = proposeBlock(TYPESCRIPT, ['npm'])
    const pre = '{\n  "permissions": { "allow": ["Bash(npm test)"] },\n  "sandbox": { "enabled": false }\n}\n'
    const post = JSON.parse(postText(pre, block)) as Settings
    expect(post.permissions).toEqual({ allow: ['Bash(npm test)'] })
    expect(post.sandbox).toEqual(block)
    expect(postText(null, block).endsWith('}\n')).toBe(true)
    expect(() => postText('[1]', block)).toThrow()
    expect(() => postText('{ broken', block)).toThrow()
  })

  test('every key that loosens the sandbox is refused with the layer that holds it; unknown keys too; neutral keys pass', async () => {
    const layers: Record<string, Settings> = {
      user: { sandbox: { excludedCommands: ['docker *'], network: { allowUnixSockets: ['/var/run/docker.sock'], strictAllowlist: true }, allowAppleEvents: true } },
      project: { sandbox: { network: { httpProxyPort: 8080, allowLocalBinding: true, allowMachLookup: ['com.x'] }, ignoreViolations: { '*': ['/tmp'] }, futureKey: 1 } },
      flag: { sandbox: { enableWeakerNestedSandbox: true, enableWeakerNetworkIsolation: true, filesystem: { disabled: true, denyWrite: ['/x'] } } },
      policy: { sandbox: { allowUnsandboxedCommands: true, failIfUnavailable: true, credentials: { files: [] }, network: { allowAllUnixSockets: true, socksProxyPort: 1080, tlsTerminate: {} } } },
    }
    expect(keys((await sandboxRefusals(layers, CTX)))).toEqual([
      'flag:enableWeakerNestedSandbox', 'flag:enableWeakerNetworkIsolation', 'flag:filesystem.disabled',
      'policy:allowUnsandboxedCommands', 'policy:network.allowAllUnixSockets', 'policy:network.socksProxyPort',
      'project:futureKey', 'project:ignoreViolations', 'project:network.allowLocalBinding', 'project:network.allowMachLookup', 'project:network.httpProxyPort',
      'user:allowAppleEvents', 'user:excludedCommands', 'user:network.allowUnixSockets',
    ])
    expect((await sandboxRefusals(layers, CTX)).find(r => r.key === 'enableWeakerNestedSandbox')?.why).toBe('loosens')
    expect((await sandboxRefusals(layers, CTX)).find(r => r.key === 'futureKey')?.why).toBe('unknown')
    const quiet = { user: { sandbox: { excludedCommands: [], network: { allowUnixSockets: [] }, allowAppleEvents: false, autoAllowBashIfSandboxed: true } } }
    expect((await sandboxRefusals(quiet, CTX))).toEqual([])
  })

  test('the local layer sandbox is replaced by the block, so only its permission rules count', async () => {
    const local = { sandbox: { excludedCommands: ['x'] }, permissions: { allow: ['Edit(~/.snagon/**)'] } }
    expect(keys((await sandboxRefusals({ local }, CTX)))).toEqual(['local:permissions.allow'])
  })

  test('write access that reaches protected paths is refused whether it comes from allowWrite, an Edit rule or an added directory', async () => {
    const layers = {
      user: { sandbox: { filesystem: { allowWrite: ['~/.claude/plugins', '~/.cache/ok', '/Users/u'] } }, permissions: { allow: ['Edit(//Users/u/.snagon/flow/**)', 'Edit(src/**)', 'Read(~/**)'], additionalDirectories: ['~/elsewhere', '/Users/u/.claude'] } },
      project: { permissions: { allow: ['Edit'] } },
    }
    const r = (await sandboxRefusals(layers, CTX))
    expect(keys(r)).toEqual(['project:permissions.allow', 'user:filesystem.allowWrite', 'user:filesystem.allowWrite', 'user:permissions.additionalDirectories', 'user:permissions.allow'])
    expect(r.filter(x => x.key === 'filesystem.allowWrite').map(x => x.value)).toEqual(['~/.claude/plugins', '/Users/u'])
  })

  test('the whole disk, a double slash, a dot-dot path or any edit-tool rule cannot slip past the protected paths', async () => {
    const layers = {
      user: { sandbox: { filesystem: { allowWrite: ['/', '//', '/tmp/../Users/u/.claude/x', '/opt/cache'] } }, permissions: { allow: ['Edit(//**)', 'Write(~/.snagon/**)', 'NotebookEdit(//Users/u/.claude/a.ipynb)', 'MultiEdit(src/**)', 'Write(src/../../../.claude/**)'], additionalDirectories: ['/'] } },
    }
    expect((await sandboxRefusals(layers, CTX)).map(x => `${x.key}=${x.value}`).sort()).toEqual([
      'filesystem.allowWrite=/', 'filesystem.allowWrite=//', 'filesystem.allowWrite=/tmp/../Users/u/.claude/x',
      'permissions.additionalDirectories=/',
      'permissions.allow=Edit(//**)', 'permissions.allow=NotebookEdit(//Users/u/.claude/a.ipynb)', 'permissions.allow=Write(src/../../../.claude/**)', 'permissions.allow=Write(~/.snagon/**)',
    ])
    expect(effectiveOf({ permissions: { allow: ['Write(docs/**)', 'Bash(ls)'] } }).editAllow).toEqual(['Write(docs/**)'])
  })

  test('a relative path means ~/.claude in user settings and the project in project settings; partial-name globs and links count', async () => {
    const user = { user: { sandbox: { filesystem: { allowWrite: ['.', 'hooks', '~/.c*/**'], allowRead: ['projects'] } }, permissions: { allow: ['Edit(//Users/u/.sn*/**)'] } } }
    expect((await sandboxRefusals(user, CTX)).map(x => `${x.key}=${x.value}`).sort()).toEqual([
      'filesystem.allowRead=projects', 'filesystem.allowWrite=.', 'filesystem.allowWrite=hooks', 'filesystem.allowWrite=~/.c*/**', 'permissions.allow=Edit(//Users/u/.sn*/**)',
    ])
    expect(await sandboxRefusals({ project: { sandbox: { filesystem: { allowWrite: ['.', 'build'] } } } }, CTX)).toEqual([])
    const linked = { ...CTX, resolve: async (p: string) => (p === `${ROOT}/cache` ? `${HOME}/.claude` : p) }
    const tilde = { ...CTX, denyRead: ['~/.ssh'], protectedPaths: ['~/.claude'] }
    expect((await sandboxRefusals({ user: { sandbox: { filesystem: { allowRead: ['~/.ssh/known_hosts'], allowWrite: ['~/.claude/x'] } } } }, tilde)).map(x => x.key).sort()).toEqual(['filesystem.allowRead', 'filesystem.allowWrite'])
    const dotfiles = { ...CTX, resolve: async (p: string) => (p === `${HOME}/.claude` ? `${HOME}/dotfiles/claude` : p) }
    expect((await sandboxRefusals({ user: { sandbox: { filesystem: { allowWrite: ['~/dotfiles'] } } } }, dotfiles)).map(x => x.value)).toEqual(['~/dotfiles'])
    expect((await sandboxRefusals({ project: { sandbox: { filesystem: { allowWrite: ['./cache'] } } } }, linked)).map(x => x.value)).toEqual(['./cache'])
  })

  test('WebFetch rules that open every host, a whole top-level domain or any host at all are refused', async () => {
    const layers = { project: { permissions: { allow: ['WebFetch', 'WebFetch(domain:*.com)', 'WebFetch(domain:**)', 'WebFetch(domain:docs.x.com)', 'WebFetch(domain:*.github.com)'] } } }
    expect((await sandboxRefusals(layers, CTX)).map(x => x.value)).toEqual(['WebFetch', 'WebFetch(domain:*.com)', 'WebFetch(domain:**)'])
    expect(effectiveOf({ permissions: { allow: ['WebFetch'] } }).webFetchDomains).toEqual(['*'])
  })

  test('a host entry wider than one domain or one star-dot domain is refused', async () => {
    const layers = { user: { sandbox: { network: { allowedDomains: ['*', '**', '*.*', 'github.*', '0.0.0.0/0', 'http://*', '*.github.io', '*.co.uk', '*.s3.amazonaws.com', '*.blob.core.windows.net', '*.github.io.', '*.storage.googleapis.com', '*.github.com', 'registry.npmjs.org'] } } } }
    expect((await sandboxRefusals(layers, CTX)).map(x => x.value)).toEqual(['*', '**', '*.*', 'github.*', '0.0.0.0/0', 'http://*', '*.github.io', '*.co.uk', '*.s3.amazonaws.com', '*.blob.core.windows.net', '*.github.io.', '*.storage.googleapis.com'])
  })

  test('read access re-opened inside the hidden paths is refused, and so is a host rule that opens every host', async () => {
    const layers = { user: { sandbox: { filesystem: { allowRead: ['~/.ssh/known_hosts', '~/docs', '~/**/notes'] } }, permissions: { allow: ['WebFetch(domain:*)', 'WebFetch(domain:*.github.com)'] } } }
    expect((await sandboxRefusals(layers, CTX)).map(x => `${x.key}=${x.value}`).sort()).toEqual([
      'filesystem.allowRead=~/**/notes', 'filesystem.allowRead=~/.ssh/known_hosts', 'permissions.allow=WebFetch(domain:*)',
    ])
  })

  test('the effective sandbox is the merged object plus the permission rules that widen it; drift after the write is named', () => {
    const merged = { sandbox: { enabled: true, allowUnsandboxedCommands: false }, permissions: { allow: ['WebFetch(domain:docs.x.com)', 'Bash(ls)', 'Edit(src/**)'], additionalDirectories: ['~/lib'] } }
    expect(effectiveOf(merged)).toEqual({ sandbox: merged.sandbox, webFetchDomains: ['docs.x.com'], editAllow: ['Edit(src/**)'], additionalDirectories: ['~/lib'] })
    const post = JSON.stringify({ sandbox: merged.sandbox }, null, 2) + '\n'
    const approved = effectiveOf(merged)
    expect(verifyAfterWrite({ local: JSON.parse(post), merged, approved, post })).toEqual([])
    const widened = { ...merged, permissions: { ...merged.permissions, allow: [...merged.permissions.allow, 'WebFetch(domain:evil.example)'] } }
    expect(verifyAfterWrite({ local: JSON.parse(post), merged: widened, approved, post })).toEqual(['webFetchDomains'])
    expect(verifyAfterWrite({ local: { sandbox: { enabled: true } }, merged, approved, post })).toEqual(['local'])
    const off = { ...merged, sandbox: { enabled: false, allowUnsandboxedCommands: false } }
    expect(verifyAfterWrite({ local: JSON.parse(post), merged: off, approved: effectiveOf(off), post })).toEqual(['sandbox.enabled'])
  })

  test('registry credentials in the environment are found by name only, including npm_config auth variables in any case', () => {
    const names = ['PATH', 'NPM_TOKEN', 'npm_config_//registry.npmjs.org/:_authToken', 'NPM_CONFIG__AUTH', 'npm_config_cache', 'NODE_OPTIONS']
    expect(authEnvNames(names, TYPESCRIPT)).toEqual(['NPM_TOKEN', 'npm_config_//registry.npmjs.org/:_authToken', 'NPM_CONFIG__AUTH'])
    expect(npmrcHasAuth('registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n')).toBe(true)
    expect(npmrcHasAuth('npmAuthToken: abc\n')).toBe(true)
    expect(npmrcHasAuth('# _authToken=old\nsave-exact=true\n')).toBe(false)
  })

  test('a plugin root inside the project, a writable path or a temp folder is refused; so is a project inside a plugin root', () => {
    const ctx = { root: ROOT, allowWrite: [`${HOME}/.npm`], tempDirs: ['/tmp', '/private/tmp', '/private/var/folders/ab/T'] }
    expect(pluginRootRefusals(['/Users/u/.claude/plugins/cache/a/1.0'], ctx)).toEqual([])
    expect(pluginRootRefusals([`${ROOT}/mods/x`, `${HOME}/.npm/x`, '/private/tmp/claude/mod', '/Users/u/dev'], ctx).map(r => r.root)).toEqual([`${ROOT}/mods/x`, `${HOME}/.npm/x`, '/private/tmp/claude/mod', '/Users/u/dev'])
  })

  test('the judge profile writes only under the root and the temp folder, never into protected paths, hides records, and has no network by default', () => {
    const profile = judgeProfile({ root: ROOT, tmpDir: '/private/var/folders/ab/T', commonDir: `${ROOT}/.git`, denyRead: [`${HOME}/.ssh`, `${HOME}/.snagon/flow`], loopbackPorts: [] })
    expect(profile.startsWith('(version 1)\n(allow default)\n(deny file-write*)\n')).toBe(true)
    expect(profile).toContain(`(allow file-write* (subpath "${ROOT}") (subpath "/private/var/folders/ab/T")`)
    for (const d of PROTECTED_DIRS) expect(profile).toContain(`(subpath "${ROOT}/${d}")`)
    expect(profile).toContain(`(literal "${ROOT}/.mcp.json")`)
    expect(profile).toContain(`(deny file-read* (subpath "${HOME}/.ssh") (subpath "${HOME}/.snagon/flow"))`)
    expect(profile).toContain('(deny appleevent-send)')
    expect(profile).toContain('\n(deny mach-lookup) (allow mach-lookup (global-name "com.apple.audio.systemsoundserver")')
    expect(profile).not.toContain('launchservicesd')
    expect(profile).not.toContain('com.apple.lsd')
    for (const rule of ['(deny lsopen)', '(deny job-creation)', '(deny mach-register)', '(deny signal) (allow signal (target same-sandbox))', '(deny file-ioctl) (allow file-ioctl (literal "/dev/null")', '(deny file-link)']) expect(profile).toContain(`\n${rule}`)
    expect(profile).toContain('\n(deny file-read* file-write* (regex #"^/dev/(tty|pty|ptmx|ttys|cu\\.|console)"))')
    expect(profile).toContain('/\\.[vV][sS][cC][oO][dD][eE](/|$)')
    expect(profile.trimEnd().endsWith('(deny network*)')).toBe(true)
    const withPort = judgeProfile({ root: ROOT, tmpDir: '/t', commonDir: '/elsewhere/.git', denyRead: [], loopbackPorts: [5173] })
    expect(withPort).toContain('(allow network-outbound (remote ip "localhost:5173"))')
    expect(withPort).toContain('(allow network-bind network-inbound (local ip "localhost:5173"))')
    expect(withPort).toContain('(subpath "/elsewhere/.git")')
    expect(() => judgeProfile({ root: '/a "b"', tmpDir: '/t', commonDir: '/a/.git', denyRead: [], loopbackPorts: [] })).toThrow()
    expect(() => judgeProfile({ root: '/a\nb', tmpDir: '/t', commonDir: '/c', denyRead: [], loopbackPorts: [] })).toThrow()
    expect(() => judgeProfile({ root: 'relative', tmpDir: '/t', commonDir: '/c', denyRead: [], loopbackPorts: [] })).toThrow()
  })

  test('the judge command starts from an empty environment and passes only the listed variables', () => {
    const argv = judgeArgv('(version 1)', ['npx', 'vitest', 'run'], { PATH: '/usr/bin:/bin', HOME, TMPDIR: '/t', LANG: 'en_US.UTF-8', emptyConfig: '/mod/flow/empty.npmrc' })
    expect(argv.slice(0, 2)).toEqual(['/usr/bin/env', '-i'])
    expect(argv).toContain('GIT_CONFIG_GLOBAL=/dev/null')
    expect(argv).toContain('npm_config_userconfig=/dev/null')
    expect(argv).toContain('npm_config_globalconfig=/mod/flow/empty.npmrc')
    expect(argv).toContain('CI=1')
    expect(argv.some(a => a.startsWith('TZ='))).toBe(false)
    expect(argv.slice(-6)).toEqual(['/usr/bin/sandbox-exec', '-p', '(version 1)', 'npx', 'vitest', 'run'])
  })

  test('the sandbox counts as active only when the probe was refused by the sandbox', () => {
    expect(probeShowsSandbox(56, 'curl: (56) CONNECT tunnel failed')).toBe(true)
    expect(probeShowsSandbox(1, 'Sandbox: deny network-outbound example.com:443')).toBe(true)
    expect(probeShowsSandbox(0, '200')).toBe(false)
    // the docs' probe (--noproxy): no route out of the sandbox, so the name never resolves (GAP-step13-4)
    expect(probeShowsSandbox(6, 'curl: (6) Could not resolve host: example.com\n000')).toBe(true)
    expect(probeShowsSandbox(28, '000')).toBe(false) // the proxy held an unlisted host until -m ran out: not a refusal
    expect(probeShowsSandbox(0, 'Could not resolve host')).toBe(true)
  })
})
