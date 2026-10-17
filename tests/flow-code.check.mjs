// F37: the release code is read only by the pane renderer (flow-owner.ts keeps it). Run: node tests/flow-code.check.mjs
import { readdirSync, readFileSync } from 'node:fs'

const dir = new URL('../hooks/', import.meta.url)
const readers = readdirSync(dir).filter(f => /\.tsx?$/.test(f) && f !== 'flow-owner.ts' && /\b(?:paneCode|releaseCode)\b/.test(readFileSync(new URL(f, dir), 'utf8')))
const ok = readers.length === 1 && readers[0] === 'flow-pane.ts'
console.log(ok ? 'ok: only flow-pane.ts reads the release code' : `FAIL: the release code is read by ${readers.join(', ') || 'no file'}`)
process.exit(ok ? 0 : 1)
