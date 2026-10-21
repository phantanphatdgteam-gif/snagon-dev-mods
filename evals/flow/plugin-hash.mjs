// Prints the mod's own pluginIntegrity of a plugin folder (hooks/flow-judge.ts), the value a flow record freezes as
// `frozen.plugin` at S2: run.sh restores a snapshot only under the plugin it was taken with (plan §4.7, GAP-R2-0.6-108).
// Usage: node plugin-hash.mjs <plugin folder>
import { registerHooks } from 'node:module'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

registerHooks({ resolve(spec, ctx, next) { try { return next(spec, ctx) } catch (e) { if (spec.startsWith('.') && !spec.endsWith('.ts')) return next(`${spec}.ts`, ctx); throw e } } })
const root = process.argv[2]
if (!root) { console.error('usage: plugin-hash.mjs <plugin folder>'); process.exit(2) }
// from the folder being hashed, not from the repository: the source stays editable while runs go on, and the hash a
// record froze was computed by the code of that copy (security review r1)
const { pluginIntegrity } = await import(new URL(`file://${resolve(root)}/hooks/flow-judge.ts`).href)
// The engine's list and read, as the mod sees its own folder: a directory is walked, anything else read as text. The
// synced copy holds text files only (rsync leaves .DS_Store and .snagon/ out); a binary file inside the plugin folder
// would have to decode the same way here as in the engine for the two hashes to agree.
const io = { list: async d => readdirSync(d, { withFileTypes: true }).map(e => ({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file' })), read: async p => readFileSync(p, 'utf8') }
console.log(await pluginIntegrity(io, root))
