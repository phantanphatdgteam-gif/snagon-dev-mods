// The TypeScript stack's data (moved from flow/data/stacks.ts in R2 step 1): how commands are found, how runner output
// is read, what RED accepts, which package managers and sandbox domains a project needs, what publishing looks like, and
// which patterns force `Security: yes`. The patterns are tested against real runner output (tests/fixtures/runners.ts).
// Its code is hooks/stacks/typescript.ts; the credential files every stack hides are flow/data/common.ts.
import type { Stack } from '../types'

export const TYPESCRIPT: Stack = {
  id: 'typescript',
  detect: { files: ['package.json', 'tsconfig.json'] },
  manifest: 'package.json',
  scripts: { test: ['test'], typecheck: ['typecheck', 'type-check', 'tsc'], lint: ['lint'], build: ['build'] },
  testRunners: ['vitest', 'jest'],
  runnerPackages: { tsc: 'typescript' },
  authFiles: ['.npmrc', '.yarnrc.yml'],
  ownsFile: '\\.(?:[cm]?ts|tsx)$',
  routing: { reviewer: 'typescript-reviewer', buildFixer: 'build-error-resolver' },
  // the testing-patterns sections plan §8.1 cites (the vendored reference shows TypeScript)
  redTesting: { from: 'reference', name: 'testing-patterns', sections: ['Test Structure', 'Test Naming', 'Mock at Boundaries Only', 'Test Anti-Patterns'] },
  exampleFiles: 'src/a.ts, tests/a.test.ts (new)',
  planRule: '', // a vitest title is free text, so RED can always add the id
  counters: [
    { runner: 'vitest', passed: '^\\s*Tests\\s+.*?(\\d+) passed', failed: '^\\s*Tests\\s+.*?(\\d+) failed', skipped: '^\\s*Tests\\s+.*?(\\d+) skipped' },
    { runner: 'jest', passed: '^Tests:\\s+.*?(\\d+) passed', failed: '^Tests:\\s+.*?(\\d+) failed', skipped: '^Tests:\\s+.*?(\\d+) skipped' },
  ],
  failures: [
    // An optional project label (`|unit|`, or `unit` once colours are stripped) may stand before the file (F17).
    { runner: 'vitest', entry: '^\\s*FAIL\\s+(?:\\|[^|]+\\|\\s+|[^\\s/.]+\\s+(?=\\S+\\s+\\[))?(?<file>\\S+)\\s+\\[\\s*\\S+\\s*\\]\\s*$', collection: true, messageNext: true },
    { runner: 'vitest', entry: '^\\s*FAIL\\s+(?:\\|[^|]+\\|\\s+|[^\\s/.]+\\s+(?=\\S+\\s+>))?(?<file>\\S+)\\s+>\\s+(?<test>.+?)\\s*$', messageNext: true },
    { runner: 'jest', fileHeader: '^FAIL\\s+(?:.*\\s)?(?<file>\\S+\\.[cm]?[jt]sx?)(?:\\s+\\([\\d.]+ m?s\\))?\\s*$', entry: '^\\s+●\\s+Test suite failed to run\\s*$', collection: true, messageNext: true, stopAt: '^Summary of all failing tests' },
    { runner: 'jest', fileHeader: '^FAIL\\s+(?:.*\\s)?(?<file>\\S+\\.[cm]?[jt]sx?)(?:\\s+\\([\\d.]+ m?s\\))?\\s*$', entry: '^\\s+●\\s+(?<test>(?!Test suite failed to run|Console\\s*$).+?)\\s*$', messageNext: true, stopAt: '^Summary of all failing tests' },
    { runner: 'tsc', entry: '^(?<file>\\S.*?)\\(\\d+,\\d+\\): error (?<id>TS\\d+): (?<message>.*)$' },
    { runner: 'tsc', entry: '^(?<file>\\S+?):\\d+:\\d+ - error (?<id>TS\\d+): (?<message>.*)$' },
    { runner: 'tsc', entry: '^error (?<id>TS\\d+): (?<message>.*)$' },
    { runner: 'eslint', fileHeader: '^(?<file>/[^:]+|[A-Za-z]:\\\\[^:]+)$', entry: '^\\s+\\d+:\\d+\\s+(?:error|warning)\\s+(?<message>.+?)(?:\\s{2,}(?<rule>[\\w@/.-]+))?\\s*$' },
    { runner: 'eslint', entry: '^(?<file>[^:\\s][^:]*):\\d+:\\d+: (?<message>.+?) \\[(?:Error|Warning)(?:/(?<rule>[^\\]]+))?\\]$' },
  ],
  red: {
    assertion: ['^\\s*AssertionError:', '^\\s*→ expected ', 'expect\\((?:[^()]|\\([^()]*\\))*\\)\\.(?:not\\.|resolves\\.|rejects\\.)*\\w+\\('],
    moduleNotFound: ["Cannot find module '(?<module>[^']+)'", 'Failed to load url (?<module>\\S+)'],
    missingExport: [
      "has no exported member named '(?<symbol>[\\w$]+)'",
      "has no exported member '(?<symbol>[\\w$]+)'",
      "does not provide an export named '(?<symbol>[\\w$]+)'",
      '\\(0 , (?:[\\w$]+\\.)?(?<symbol>[\\w$]+)\\) is not a function',
      'TypeError: (?<symbol>[\\w$]+) is not a function',
      '__vite_ssr_import_\\d+__\\.(?<symbol>[\\w$]+) is not a function',
    ],
  },
  evalIdForms: ['(?<![\\w-])AC-(\\d{3})(?!\\d)'],
  paramIds: false,
  packageManagers: [
    { id: 'npm', lockfiles: ['package-lock.json', 'npm-shrinkwrap.json'], domains: ['registry.npmjs.org'], cacheDirs: ['~/.npm'] },
    { id: 'pnpm', lockfiles: ['pnpm-lock.yaml'], domains: ['registry.npmjs.org'], cacheDirs: ['~/Library/pnpm/store', '~/Library/Caches/pnpm', '~/.local/share/pnpm/store', '~/.cache/pnpm'] },
    { id: 'yarn', lockfiles: ['yarn.lock'], domains: ['registry.yarnpkg.com', 'registry.npmjs.org'], cacheDirs: ['~/Library/Caches/Yarn', '~/.cache/yarn', '~/.yarn/berry'] },
    { id: 'bun', lockfiles: ['bun.lock', 'bun.lockb'], domains: ['registry.npmjs.org'], cacheDirs: ['~/.bun/install/cache'] },
  ],
  publish: {
    tools: ['npm', 'pnpm', 'yarn', 'bun', 'npx', 'pnpx', 'bunx'],
    subcommands: ['publish', 'unpublish', 'dist-tag', 'deprecate', 'owner', 'access', 'token', 'adduser', 'login', 'tag'],
    prefixes: { yarn: ['npm'] },
    valueOptions: ['--workspace', '-w', '--tag', '--registry', '--otp', '--access', '--filter', '-F', '--dir', '-C', '--prefix', '--cwd', '--userconfig'],
    releaseTools: ['changeset', 'lerna', 'semantic-release', 'np', 'release-it'],
  },
  registryAuthEnv: ['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'YARN_NPM_AUTH_TOKEN', 'BUN_AUTH_TOKEN'],
  // the npm family's credential files; the ones every stack hides are COMMON_DENY_READ (flow/data/common.ts)
  sandbox: { denyRead: ['~/.npmrc', '~/.yarnrc', '~/.yarnrc.yml', '~/.config/yarn', '~/.bunfig.toml'] },
  securityPatterns: [
    "\\bfrom ['\"](?:node:)?(?:fs|fs/promises|child_process|net|tls|dgram|http|https|http2|vm|worker_threads)['\"]",
    "\\brequire\\(['\"](?:node:)?(?:fs|fs/promises|child_process|net|tls|http|https|vm)['\"]\\)",
    '\\bfs\\.(?:promises\\b|\\w+\\()',
    '\\b(?:readFile|writeFile|appendFile|unlink|rm|rmdir|mkdir|chmod|chown|rename|symlink|copyFile|cp|createReadStream|createWriteStream)(?:Sync)?\\(',
    '\\bhttps?\\.(?:get|request)\\(', '\\bnet\\.(?:connect|createConnection|createServer)\\(', '\\bnew WebSocket\\(', '\\bfetch\\(',
    "\\bfrom ['\"](?:axios|got|ky|node-fetch|undici|superagent|execa)['\"]",
    '\\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|execa)\\(', '\\bBun\\.spawn', '\\bDeno\\.(?:run|Command)\\b',
    '\\beval\\(', '\\bnew Function\\(', '\\bprocess\\.env\\b', '\\bcrypto\\b',
    "\\bfrom ['\"](?:jose|jsonwebtoken|passport[\\w-]*|bcrypt(?:js)?|argon2|express-session|iron-session|cookie-session|next-auth|@auth/[\\w-]+|openid-client|oauth4webapi|lucia)['\"]",
    "\\bfrom ['\"](?:pg|mysql2?|sqlite3|better-sqlite3|@prisma/client|knex|sequelize|typeorm|mongoose|mongodb|redis|ioredis)['\"]",
    // Call sites that need no new import line (F18): HTML sinks, servers, HTTP clients, tokens, hashes, raw queries.
    '\\.innerHTML\\s*=', 'dangerouslySetInnerHTML', '\\bdocument\\.write(?:ln)?\\(', '\\b(?:http|https|http2|net|tls)\\.createServer\\(',
    '\\baxios(?:\\.\\w+)?\\(', '\\bgot(?:\\.\\w+)?\\(', '\\bjwt\\.\\w+\\(', '\\bbcrypt\\.\\w+\\(', '\\.query\\(\\s*`[^`]*\\$\\{', '\\$(?:queryRawUnsafe|executeRawUnsafe)\\(', '\\.raw\\(\\s*`',
    // Dynamic forms: dynamic import of a node built-in, a require call with a computed name, process[...], globalThis.fetch, process.kill.
    "\\bimport\\(\\s*['\"](?:node:)?(?:fs|fs/promises|child_process|net|tls|dgram|http|https|http2|vm|worker_threads)['\"]", "\\brequire\\(\\s*(?!['\"`])", "\\bimport\\(\\s*(?!['\"])", '\\bprocess\\.binding\\(', '\\bprocess\\s*\\[', '\\bglobalThis\\.fetch\\b', '\\bprocess\\.kill\\(',
  ],
  testFiles: ['**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}', '**/__tests__/**', 'test/**', 'tests/**'],
  entrypoints: ['bin/', 'scripts/', 'cli/', 'src/cli.ts', 'src/main.ts'],
  dependencyDirs: ['node_modules'],
  buildOutputs: ['dist/', 'build/', 'coverage/', '*.tsbuildinfo'],
  // NK-09 (R2 plan row 5)
  loadable: ['*.js', '*.ts', '*.mjs', '*.cjs', '*.json'],
  loopbackPorts: [],
  filterFlag: { vitest: '-t', jest: '-t' },
}
