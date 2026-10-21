// AC-SAFE-1 (GAP-R2-0.6-113): the shipped mod has no test mode, flag or back door the eval harness could use, so the
// harness has to reach a phase by running a real flow or by restoring a snapshot of one. Reads the source only.
// Usage: node tests/no-backdoor.check.mjs   (exits non-zero on the first failed check)
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MOD = join(import.meta.dirname, '..')
// every code file, whatever its extension: a back door in a .mjs would count as much as one in a .ts (both reviews r1)
const CODE = /\.(tsx?|jsx?|mjs|cjs)$/
const SRC = ['hooks', 'flow'].flatMap(d => walk(join(MOD, d)))
let n = 0
const check = (name, ok, extra = '') => { n += 1; if (!ok) { console.error(`FAIL ${n}: ${name} ${extra}`); process.exit(1) } console.log(`ok ${n}: ${name}`) }
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return CODE.test(e.name) ? [{ rel: p.slice(MOD.length + 1), text: readFileSync(p, 'utf8') }] : []
  })
}
function names(dir) {
  try { return readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? names(join(dir, e.name)) : [e.name])) } catch { return [] }
}

// Every environment variable the mod reads: each call must name it as a single-quoted literal of the list below, so a
// computed or double-quoted name (which this check could not read) fails it (both reviews r1).
const CALLS = SRC.flatMap(f => [...f.text.matchAll(/env\.get\(([^)]*)\)/g)].map(m => ({ rel: f.rel, arg: m[1].trim() })))
const LITERAL = /^'([A-Z][A-Z0-9_]*)'$/
const READS = [...new Set(CALLS.map(c => LITERAL.exec(c.arg)?.[1]).filter(Boolean))].sort()
const ALLOWED = ['CLAUDE_CODE_PLUGIN_DIRS', 'CLAUDE_CONFIG_DIR', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'HOME', 'LANG', 'PATH', 'TMPDIR', 'TZ', 'XDG_CONFIG_HOME']
check('every environment read names its variable as a plain single-quoted literal', CALLS.every(c => LITERAL.test(c.arg)), CALLS.filter(c => !LITERAL.test(c.arg)).map(c => `${c.rel}: ${c.arg}`).join(', '))
check('the mod reads only the environment variables of its own list', READS.join() === ALLOWED.join(), JSON.stringify(READS))
check('no name it reads reads like a switch (eval, test, debug, harness, bypass, skip, mock, fake)', !READS.some(x => /EVAL|TEST|DEBUG|HARNESS|BYPASS|SKIP|MOCK|FAKE/i.test(x)), JSON.stringify(READS))

// The variables that mark a session as a loop runner's or as this mod's own handoff worker: they turn the journal and
// address reminders off, never a guard (AC-MM-2). The list stays the three known names.
const session = SRC.find(f => f.rel === 'hooks/session.ts')?.text ?? ''
const EXEMPT = [...(session.match(/EXEMPT_VARS = \[([^\]]*)\]/)?.[1].matchAll(/'([^']+)'/g) ?? [])].map(m => m[1])
check('EXEMPT_VARS holds the three known names', EXEMPT.join() === 'LOOP535_ROLE,HANDOFF_WORKER,SNAGON_WORKER', JSON.stringify(EXEMPT))
// every flow module, not a fixed list of six, and any spelling of the flag; an empty list would pass vacuously (r1)
const guards = SRC.filter(f => /^hooks\/flow.*\.ts$/.test(f.rel))
check('there are flow modules to check', guards.length >= 20, String(guards.length))
check('no flow module reads the exempt flag (it turns journal and address reminders off, never a guard)', guards.every(f => !/exempt/i.test(f.text)), guards.filter(f => /exempt/i.test(f.text)).map(f => f.rel).join(', '))

// Nothing in the shipped mod knows about the harness: no eval path, scenario name or snapshot folder.
const WORDS = /flow-evals|flow-eval-mod|FLOW_EVAL|snagon\/evals|pty-drive|scenarios\.sh|scenario_|\.flow-eval/
check('no file of hooks/ or flow/ names the eval harness', SRC.every(f => !WORDS.test(f.text)), SRC.filter(f => WORDS.test(f.text)).map(f => f.rel).join(', '))
// the harness's own files, by their exact names (a vendored skill may have a run.py of its own)
const HARNESS_FILES = /^(run\.sh|scenarios\.sh|scenarios-main\.sh|pty-drive\.sh|calls\.mjs|metrics\.mjs|plugin-hash\.mjs|fake-mcp\.mjs)$/
check('the harness files live under evals/ alone', ['hooks', 'flow', 'agents', 'skills', 'commands'].every(d => !names(join(MOD, d)).some(x => HARNESS_FILES.test(x))))

// A flow phase can be reached only by running one or by restoring a snapshot: no owner command sets a task or a phase
// from its argument, and the mod never writes where the snapshots live.
const cmd = SRC.filter(f => /^hooks\/flow-(cmd|owner|decide)\.ts$/.test(f.rel))
check('the command modules are there', cmd.length === 3, cmd.map(f => f.rel).join(', '))
// a task or phase set from anything but a literal: `task: 'B2'` is the mod's own, `task: args[0]` would be a back door
check('no owner command takes a task or phase from a value that is not a literal', cmd.every(f => !/\b(?:task|phase):\s*(?!')[A-Za-z_]/.test(f.text)),
  cmd.flatMap(f => [...f.text.matchAll(/\b(?:task|phase):\s*(?!')[A-Za-z_][^,\n}]*/g)].map(m => `${f.rel}: ${m[0]}`)).join(', '))
check('the mod writes nothing under ~/.snagon/evals (where the snapshots live)', !SRC.some(f => /snagon\/evals/.test(f.text)))

console.log(`no-backdoor check: ${n} ok`)
