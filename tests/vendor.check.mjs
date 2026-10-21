// Developer check of the vendored agent-skills methods on disk (claude plugin test has no file system), plan v7.1 §8, §8.1:
// node tests/vendor.check.mjs. Prints "vendor check: ok". The pure parts are tests/vendor.test.ts.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'

const root = new URL('..', import.meta.url)
const at = rel => new URL(rel, root)
const read = rel => fs.readFileSync(at(rel), 'utf8')
const VENDOR = 'flow/vendor/agent-skills'
const LOCK = 'flow/vendor/agent-skills.lock.json'
const OVERRIDES = 'flow/vendor/overrides.md'
const lock = JSON.parse(read(LOCK))

// The lock (plan §8): where the files came from, when, and each file's hash as copied.
assert.deepEqual(Object.keys(lock).sort(), ['fetchedAt', 'files', 'repo', 'sha'], 'the lock holds {repo, sha, fetchedAt, files}')
assert.equal(lock.repo, 'https://github.com/addyosmani/agent-skills', 'the lock names the upstream repository')
assert.match(lock.sha, /^[0-9a-f]{40}$/, 'the lock pins a full commit sha')
assert.match(lock.fetchedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/, 'the lock has a UTC fetch time')

// Every vendored file is locked with its hash and every locked file is there (Finder's .DS_Store aside); none is a link
// (it could point outside the plugin) and none is executable, since the mod never runs vendored text.
const entries = fs.readdirSync(at(VENDOR), { recursive: true }).filter(p => !p.endsWith('.DS_Store'))
for (const p of entries) assert.ok(!fs.lstatSync(at(`${VENDOR}/${p}`)).isSymbolicLink(), `${p} is not a link`)
const onDisk = entries.filter(p => fs.statSync(at(`${VENDOR}/${p}`)).isFile()).sort()
assert.deepEqual(onDisk, Object.keys(lock.files).sort(), 'the vendored files are exactly the locked files')
for (const [p, e] of Object.entries(lock.files)) {
  assert.deepEqual(Object.keys(e).sort(), ['hash', 'patched'], `${p}: the lock entry is {hash, patched}`)
  assert.equal(typeof e.patched, 'boolean', `${p}: patched is true or false`)
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(at(`${VENDOR}/${p}`))).digest('hex'), e.hash, `${p} matches its lock hash`)
  assert.equal(fs.statSync(at(`${VENDOR}/${p}`)).mode & 0o111, 0, `${p} is not executable`)
}

// The set is the owner-approved one routing.ts names (14 skills, 3 agents, 7 references) with its licence, and only that.
const routing = read('flow/data/routing.ts')
const namesIn = (src, key) => [...(new RegExp(`${key}: \\[([^\\]]*)\\]`).exec(src)?.[1] ?? '').matchAll(/'([\w-]+)'/g)].map(m => m[1])
const vendoredSrc = routing.slice(routing.indexOf('vendored: {'))
const approved = { skills: namesIn(vendoredSrc, 'skills'), agents: namesIn(vendoredSrc, 'agents'), references: namesIn(vendoredSrc, 'references') }
assert.deepEqual([approved.skills.length, approved.agents.length, approved.references.length], [14, 3, 7], 'routing names the approved set')
const locked = Object.keys(lock.files)
const inSet = p => p === 'LICENSE' || approved.skills.some(s => p.startsWith(`skills/${s}/`)) || approved.agents.some(a => p === `agents/${a}.md`) || approved.references.some(r => p === `references/${r}.md`)
assert.deepEqual(locked.filter(p => !inSet(p)), [], 'nothing outside the approved set is vendored')
for (const p of [...approved.skills.map(s => `skills/${s}/SKILL.md`), ...approved.agents.map(a => `agents/${a}.md`), ...approved.references.map(r => `references/${r}.md`), 'LICENSE']) {
  assert.ok(locked.includes(p), `${p} is vendored`)
}

// Headings outside fenced code; a cited heading names the start of one in whole words ("Test Naming Conventions").
function headings(text) {
  const out = []
  let fence = ''
  for (const line of text.split('\n')) {
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = ''
      continue
    }
    if (f) { fence = f[1]; continue }
    const h = /^(#{1,6}) (.*)$/.exec(line)
    if (h) out.push(h[2].trim())
  }
  return out
}
const cites = (heading, cited) => heading === cited || (heading.startsWith(cited) && /^[\s(]/.test(heading.slice(cited.length)))

// Every heading §8.1 cites exists in its reference. §8.1 quotes orchestration-patterns' rule as "Personas do not invoke
// personas"; upstream states it in a sentence (its governing rule), not a heading.
const CITED = {
  'testing-patterns': ['Test Structure', 'Test Naming', 'Mock at Boundaries Only', 'Test Anti-Patterns'],
  'security-checklist': ['Threat Modeling', 'Input Validation', 'AI / LLM Security', 'OWASP Top 10', 'Install-Script Gate'],
  'performance-checklist': ['Measurement Commands'],
}
for (const [ref, cited] of Object.entries(CITED)) {
  const hs = headings(read(`${VENDOR}/references/${ref}.md`))
  for (const c of cited) assert.ok(hs.some(h => cites(h, c)), `references/${ref}.md has the heading §8.1 cites: ${c}`)
}
assert.ok(read(`${VENDOR}/references/orchestration-patterns.md`).includes('Personas do not invoke other personas.'), 'orchestration-patterns.md states the rule §8.1 cites')

// What tickets quote (plan §8; hooks/flow-method.ts): each role's routed skill at the path the code reads, B1's testing
// sections, and the overrides. None holds a flow protocol token (the fence's list in flow-review.ts), a fence marker, an
// invisible format character, a carriage return, one of the ticket's own section headings or a reply line its parsers
// read (flow-review.ts), so vendored text cannot pass for ticket structure or for an answer.
const method = read('hooks/flow-method.ts')
for (const path of [VENDOR, LOCK, OVERRIDES]) assert.ok(method.includes(`'${path}'`), `flow-method.ts reads ${path}`)
assert.ok(method.includes('/skills/${s}/SKILL.md') && method.includes('/references/${'), 'flow-method.ts reads skills/<name>/SKILL.md and references/<name>.md')
const skillsSrc = routing.slice(routing.indexOf('  skills: {'), routing.indexOf('  references: {'))
const routedSkills = [...new Set([...skillsSrc.matchAll(/'([\w-]+)'/g)].map(m => m[1]))]
assert.ok(routedSkills.length >= 5 && routedSkills.every(s => approved.skills.includes(s)), 'every routed skill is vendored')
// B1's testing text is the flow stack's (R2 plan §4.4): sections of a vendored reference (those §8.1 cites), or of one of
// the mod's own skills; each cited heading is in the file the code reads
const stackFiles = fs.readdirSync(at('flow/data/stacks')).filter(n => n.endsWith('.ts')).sort().map(n => `flow/data/stacks/${n}`)
const redOf = f => {
  const m = /redTesting: \{ from: '(reference|skill)', name: '([\w-]+)', sections: \[([^\]]*)\] \}/.exec(read(f))
  assert.ok(m, `${f} names its B1 testing text`)
  return { from: m[1], name: m[2], sections: [...m[3].matchAll(/'([^']+)'/g)].map(x => x[1]), file: m[1] === 'reference' ? `${VENDOR}/references/${m[2]}.md` : `skills/${m[2]}/SKILL.md` }
}
const reds = Object.fromEntries(stackFiles.map(f => [/id: '([\w-]+)'/.exec(read(f))?.[1], redOf(f)]))
assert.ok(method.includes('`skills/${red.name}/SKILL.md`'), 'flow-method.ts reads a stack\'s own testing skill at skills/<name>/SKILL.md')
for (const r of Object.values(reds)) {
  if (r.from === 'reference') assert.deepEqual(r.sections, CITED[r.name], `B1 testing text of ${r.name} is the sections §8.1 cites`)
  const hs = headings(read(r.file))
  for (const s of r.sections) assert.ok(hs.some(h => cites(h, s)), `${r.file} has the heading B1 cites: ${s}`)
}
const quoted = [...routedSkills.map(s => `${VENDOR}/skills/${s}/SKILL.md`), ...new Set(Object.values(reds).map(r => r.file)), OVERRIDES]
const PROTOCOL = [
  /UNTRUSTED-/i, /REVIEW-END/i, /NO-FINDINGS/i, /FINDING\s*\|/i, /\[flow-escalate\]/i, /TICKET\s+\S/, /<<<|>>>/, /\p{Cf}/u, /\r/,
  // a line or paragraph separator reads as a line break, and a run of them makes the line-start patterns below quadratic
  /[\p{Zl}\p{Zp}]/u,
  // as the parsers read them: a trimmed line, any space between the word and its id ([^\S\n] is a space that is no line end)
  /^ {0,3}#{1,6}[^\S\n]+(ANSWER|PACK|CONTRACT|ARTIFACT|FINDINGS|PLAN|LINT|PROBLEMS|CHANGE SINCE|RED|IMPLEMENT|DEBUG|FIX)\b/m,
  /^[^\S\n]*(RESOLVED|OPEN|UPHOLD|WITHDRAW|FIX|DISPUTE)[^\S\n]+[A-Z]+-\d+/m,
  /^[^\S\n]*(ASSUMPTIONS|REPRODUCE|LOCALIZE|HYPOTHESIS|FIX|GUARD):/m,
]
for (const f of quoted) {
  assert.ok(fs.existsSync(at(f)), `${f} exists where the code reads it`)
  for (const re of PROTOCOL) assert.ok(!re.test(read(f)), `${f} holds nothing matching ${re}`)
}

// overrides.md says the three rules of plan §8, and how the flow's rules for tickets answer the method's own advice
// (skills/flow-loop "In a ticket"): installs and git commands change files, a review changes none even for a moment,
// nothing keeps running in the background, no test is weakened, and the ticket's ANSWER decides what is reported.
const overrides = read(OVERRIDES)
for (const rule of ['Write only the files this ticket names', 'Never commit, push or spawn agents', '`/build auto`', '`/spec`', '`/review`', '`/test`', '`tasks/plan.md`',
  'no package installs', 'no git command that changes the worktree or HEAD', 'A review changes no file, not even for a moment', 'in the background',
  'Never make a check pass by weakening, skipping or deleting a test, or by changing the tests written at RED', '`## ANSWER`']) {
  assert.ok(overrides.includes(rule), `overrides.md says ${rule}`)
}

// The ticket budget (§7 cap) with the real texts: the fixed parts of each ticket (its frame, the role's method, for a
// feature ticket the flow stack's rules and for a debug ticket the longest failing output) leave room for the feature's
// own files or diff. Step 12's review found every TypeScript feature split once all stacks' rules went into the pack.
const reviewSrc = read('hooks/flow-review.ts')
const num = re => Number((re.exec(reviewSrc)?.[1] ?? 'NaN').replace(/_/g, ''))
const CAP = { lines: num(/TICKET_CAP = \{ lines: ([\d_]+)/), chars: num(/TICKET_CAP = \{ lines: [\d_]+, chars: ([\d_]+)/) }
const FAILING = { lines: num(/DEBUG_OUTPUT_LINES = ([\d_]+)/), chars: num(/DEBUG_OUTPUT_LINES = ([\d_]+)/) * num(/DEBUG_LINE_CHARS = ([\d_]+)/) }
assert.ok([CAP.lines, CAP.chars, FAILING.lines, FAILING.chars].every(Number.isFinite), 'the ticket cap and the debug output size are read from flow-review.ts')
// every stack a flow can freeze: its rules go into its feature tickets
const stackIds = fs.readdirSync(at('flow/data/stacks')).filter(n => n.endsWith('.ts')).sort().map(n => /id: '([\w-]+)'/.exec(read(`flow/data/stacks/${n}`))?.[1])
assert.ok(stackIds.length > 0 && stackIds.every(Boolean), 'each file in flow/data/stacks names its stack')
const rulesOf = stackId => fs.readdirSync(at(`instructions/paths/${stackId}`)).filter(n => n.endsWith('.md')).sort()
  .map(n => [`### Stack rules (${stackId}/${n})`, read(`instructions/paths/${stackId}/${n}`).replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/<!--[\s\S]*?-->\n?/g, '').trim()].join('\n')).join('\n')
const roleSkills = Object.fromEntries([...skillsSrc.matchAll(/^\s+(\w+): \[([^\]]*)\]/gm)].map(m => [m[1], [...(m[2] ?? '').matchAll(/'([\w-]+)'/g)].map(x => x[1])]))
const sectionOf = files => ['## Reference method (agent-skills, MIT, xxxxxxxx)', ...files.map(f => read(f).trim()), overrides.trim()].join('\n\n')
const size = t => ({ lines: t.split('\n').length, chars: t.length })
// estimates: a feature ticket's own lines with the flow rules, the feature's rows and its ACs; a review's preamble,
// severity scale, rubric and answer rules; the plan ticket's format, rules and the owner's words
const FEATURE_FRAME = { lines: 40, chars: 3_000 }, REVIEW_FRAME = { lines: 60, chars: 8_000 }, PLAN_FRAME = { lines: 40, chars: 4_000 }
const MIN_ROOM = { lines: 300, chars: 10_000 } // what must stay for the feature's files, or for a review's diff
for (const stackId of stackIds) {
  const stackRules = rulesOf(stackId)
  const BUDGET = {
    planner: [PLAN_FRAME], red: [FEATURE_FRAME, stackRules], author: [FEATURE_FRAME, stackRules], debugger: [FEATURE_FRAME, stackRules, FAILING],
    buildFixer: [FEATURE_FRAME, stackRules, FAILING], reviewer: [REVIEW_FRAME], securityReviewer: [REVIEW_FRAME],
  }
  for (const [role, extras] of Object.entries(BUDGET)) {
    // B1's method is a few sections of the stack's testing text; the whole file is counted here, which only overstates it
    const files = role === 'red' ? [reds[stackId]?.file ?? ''] : (roleSkills[role] ?? []).map(s => `${VENDOR}/skills/${s}/SKILL.md`)
    assert.ok(files.length > 0, `${role} has a method to count`)
    const used = [size(sectionOf(files)), ...extras.map(x => (typeof x === 'string' ? size(x) : x))].reduce((a, b) => ({ lines: a.lines + b.lines, chars: a.chars + b.chars }))
    assert.ok(CAP.lines - used.lines >= MIN_ROOM.lines && CAP.chars - used.chars >= MIN_ROOM.chars, `${stackId} ${role}: the fixed parts of its ticket (${used.lines} lines, ${used.chars} chars) leave room under the cap for its files or diff`)
  }
}

// Credits: the MIT licence beside the other licences, and a CREDITS.md section naming the locked commit.
assert.equal(read('LICENSES/agent-skills-MIT.txt'), read(`${VENDOR}/LICENSE`), 'LICENSES/agent-skills-MIT.txt is the vendored LICENSE')
assert.match(read(`${VENDOR}/LICENSE`), /^MIT License\n\nCopyright \(c\) 2025 Addy Osmani\n/, 'agent-skills is MIT, by Addy Osmani')
const credits = read('CREDITS.md')
for (const s of ['## agent-skills (MIT)', lock.repo, lock.sha, 'LICENSES/agent-skills-MIT.txt', 'flow/vendor/agent-skills']) assert.ok(credits.includes(s), `CREDITS.md names ${s}`)

// The update procedure is written down; Claude Code never loads the vendored files (plan §8: ticket text only).
const update = read('docs/vendor-update.md')
for (const s of [LOCK, 'node tests/vendor.check.mjs', 'security-reviewer']) assert.ok(update.includes(s), `docs/vendor-update.md names ${s}`)
assert.ok(!read('.claude-plugin/plugin.json').includes('flow/vendor'), 'the plugin manifest does not load the vendored files')
for (const f of [OVERRIDES, 'docs/vendor-update.md', 'hooks/flow-method.ts', 'tests/vendor.test.ts', 'tests/vendor.check.mjs']) {
  assert.ok(read(f).split('\n').length <= 400, `${f} stays under 400 lines`)
}
console.log('vendor check: ok')
