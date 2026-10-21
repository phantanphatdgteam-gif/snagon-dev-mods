// Source checks over the mod's code. Run: node tests/flow-code.check.mjs (exits non-zero when one fails)
// F37: the release code is read only by the pane renderer (flow-owner.ts keeps it).
// R2 step 1 (plan §3.2 step 6): the core reaches a stack only through the registry (hooks/stacks/index.ts): no
// `TYPESCRIPT` outside the stack folders (AC-CORE-1), no stack module imported from outside hooks/stacks/ and no stack
// importing another stack's modules (A-10), no model call where results are judged (AC-STK-1), and no import cycle
// through the registry (a cycle would leave a stack's code undefined while the modules load).
import { readdirSync, readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = rel => readFileSync(new URL(rel, root), 'utf8')
const tsFiles = dir => readdirSync(new URL(dir, root), { recursive: true }).filter(f => /\.tsx?$/.test(f)).map(f => `${dir}${f}`)
const hooks = tsFiles('hooks/'), flow = tsFiles('flow/')
let failed = 0
const check = (ok, good, bad) => { console.log(ok ? `ok: ${good}` : `FAIL: ${bad}`); if (!ok) failed += 1 }

const readers = hooks.filter(f => f !== 'hooks/flow-owner.ts' && /\b(?:paneCode|releaseCode)\b/.test(read(f)))
check(readers.length === 1 && readers[0] === 'hooks/flow-pane.ts', 'only flow-pane.ts reads the release code', `the release code is read by ${readers.join(', ') || 'no file'}`)

const inStackFolders = f => f.startsWith('hooks/stacks/') || f.startsWith('flow/data/stacks')
const direct = [...hooks, ...flow].filter(f => !inStackFolders(f) && /\b(?:TYPESCRIPT|PYTHON)\b/.test(read(f)))
check(!direct.length, 'the stacks (TYPESCRIPT, PYTHON) are named only in the stack folders (AC-CORE-1)', `a stack is named in ${direct.join(', ')}`)

/** The modules a file imports at run time (type-only imports are erased), as root-relative paths: static imports and
 * re-exports (`export {…}`, `export *`) at the start of a line, and dynamic `import('…')` anywhere. */
const valueImports = f => {
  const text = read(f)
  const specs = [
    ...[...text.matchAll(/^\s*(?:import\s+(?!type\b)[^'"]*?from|export\s+(?!type\b)\{[^}]*\}\s*from|export\s*\*(?:\s+as\s+[\w$]+)?\s*from|import)\s*['"](\.{1,2}\/[^'"]+)['"]/gm)].map(m => m[1]),
    ...[...text.matchAll(/\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)].map(m => m[1]),
  ]
  return specs.map(s => new URL(s.endsWith('.ts') || s.endsWith('.tsx') ? s : `${s}.ts`, new URL(f, root)).href.slice(root.href.length))
}
const stackModule = /^hooks\/stacks\/(?!index\.ts$)/
const reachIn = hooks.filter(f => !f.startsWith('hooks/stacks/')).flatMap(f => valueImports(f).filter(i => stackModule.test(i)).map(i => `${f} → ${i}`))
check(!reachIn.length, 'stack modules are imported only inside hooks/stacks/ (A-10)', `the core imports a stack module: ${reachIn.join('; ')}`)
const stackOf = f => /^hooks\/stacks\/([a-z0-9]+)(?:-[\w-]+)?\.ts$/.exec(f)?.[1]
const crossed = hooks.filter(f => stackOf(f) && stackOf(f) !== 'index').flatMap(f => valueImports(f).filter(i => stackOf(i) && stackOf(i) !== 'index' && stackOf(i) !== stackOf(f)).map(i => `${f} → ${i}`))
check(!crossed.length, "no stack imports another stack's modules", `a stack reaches into another: ${crossed.join('; ')}`)
const parseReport = hooks.filter(f => !f.startsWith('hooks/stacks/') && /import\s*\{[^}]*\breadReport\b[^}]*\}\s*from\s*['"][^'"]*flow\/parse['"]/.test(read(f)))
check(!parseReport.length, "only the TypeScript stack imports the runners' JSON report reader (readReport)", `readReport is imported in ${parseReport.join(', ')}`)
const junitReaders = hooks.filter(f => !f.startsWith('hooks/stacks/') && /from\s*['"][^'"]*flow\/junit['"]/.test(read(f)))
check(!junitReaders.length, 'only stack code imports the JUnit reader (flow/junit.ts)', `flow/junit is imported in ${junitReaders.join(', ')}`)

const judged = [...hooks.filter(f => f.startsWith('hooks/stacks/') || /^hooks\/flow-(?:judge|judging|scan|setup|run|baseline|build|verify|sandbox|freeze)\.ts$/.test(f)), ...flow.filter(f => f === 'flow/parse.ts' || f === 'flow/junit.ts' || f.startsWith('flow/data/'))]
const asks = judged.filter(f => /\$\s*\.\s*model\b/.test(read(f)))
check(!asks.length, 'no model call in the judge, scans, RED, sources, setup or stack data (AC-STK-1)', `a model is called in ${asks.join(', ')}`)

// a depth-first walk over run-time imports from the registry must not come back to it
const seen = new Set(), stack = [...valueImports('hooks/stacks/index.ts').map(i => [i, ['hooks/stacks/index.ts', i]])]
let cycle = null
while (stack.length && !cycle) {
  const [f, path] = stack.pop()
  if (f === 'hooks/stacks/index.ts') { cycle = path; break }
  if (seen.has(f)) continue
  seen.add(f)
  for (const i of valueImports(f)) stack.push([i, [...path, i]])
}
check(!cycle, `no import cycle through the registry (${seen.size} modules under it)`, `import cycle: ${cycle?.join(' → ')}`)

process.exit(failed ? 1 : 0)
