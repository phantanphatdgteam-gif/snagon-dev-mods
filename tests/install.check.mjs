// Developer check of the real install script (claude plugin test has no processes): node tests/install.check.mjs
// Runs INSTALL_SCRIPT with /bin/sh on fake PATHs: sqlite3 present, Homebrew, root with apt-get, nothing usable,
// and a planted symlink. Fake brew/apt-get only record their arguments; nothing is installed. Prints "install check: ok".
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const src = fs.readFileSync(new URL('../hooks/install.ts', import.meta.url), 'utf8')
const script = eval(src.slice(src.indexOf('export const INSTALL_SCRIPT = ') + 'export const INSTALL_SCRIPT = '.length, src.indexOf(".join('\\n')", src.indexOf('INSTALL_SCRIPT = ')) + ".join('\\n')".length))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snagon-install-'))
const which = t => execFileSync('/bin/sh', ['-c', `command -v ${t}`], { env: { PATH: '/usr/bin:/bin' } }).toString().trim()
const bin = (name, extra = {}) => {
  const d = path.join(tmp, name); fs.mkdirSync(d)
  for (const t of ['sh', 'date', 'dirname', 'mkdir', 'printf', 'id', 'uname']) if (!(t in extra)) fs.symlinkSync(which(t), path.join(d, t))
  for (const [t, body] of Object.entries(extra)) { fs.writeFileSync(path.join(d, t), `#!/bin/sh\n${body}\n`); fs.chmodSync(path.join(d, t), 0o755) }
  return d
}
const run = (PATH, log) => execFileSync('/bin/sh', ['-c', script, 'sh', log], { env: { PATH } }).toString().trim()
const settle = () => execFileSync('/bin/sleep', ['1'])
try {
  const calls = path.join(tmp, 'calls')
  assert.equal(run(bin('present', { sqlite3: 'exit 0' }), path.join(tmp, 'l0')), 'present')
  assert.equal(run(bin('brew', { brew: `echo "brew $*" >> ${calls}` }), path.join(tmp, 'a', 'install.log')), 'brew'); settle()
  assert.match(fs.readFileSync(path.join(tmp, 'a', 'install.log'), 'utf8'), /start brew[\s\S]*ok/)
  assert.equal(run(bin('root', { id: 'echo 0', 'apt-get': `echo "apt-get $*" >> ${calls}`, brew: `echo "brew-as-root $*" >> ${calls}` }), path.join(tmp, 'b', 'install.log')), 'apt-get'); settle()
  assert.match(run(bin('nothing'), path.join(tmp, 'l3')), /^none - \S+ missing$/)
  // an ordinary user on Linux with apt-get: nothing installed, the package manager and OS reported for the manual command
  assert.equal(run(bin('linux-user', { uname: 'echo Linux', 'apt-get': `echo "apt-get-as-user $*" >> ${calls}` }), path.join(tmp, 'l5')), 'none apt-get Linux missing')
  assert.equal(run(bin('old-sqlite', { sqlite3: 'exit 1', uname: 'echo Linux', dnf: 'exit 0' }), path.join(tmp, 'l6')), 'none dnf Linux old')
  assert.equal(run(bin('no-os', { uname: 'exit 1' }), path.join(tmp, 'l7')), 'none - - missing')
  const target = path.join(tmp, 'outside.txt'); fs.writeFileSync(target, 'untouched\n')
  fs.mkdirSync(path.join(tmp, 'c')); fs.symlinkSync(target, path.join(tmp, 'c', 'install.log'))
  assert.equal(run(bin('brew2', { brew: 'exit 0' }), path.join(tmp, 'c', 'install.log')), 'brew'); settle()
  assert.equal(fs.readFileSync(target, 'utf8'), 'untouched\n', 'a planted link was followed')
  const log = fs.readFileSync(calls, 'utf8')
  assert.match(log, /brew install sqlite/)
  assert.match(log, /apt-get install -y -qq sqlite3/)
  assert.doesNotMatch(log, /brew-as-root/)
  assert.doesNotMatch(log, /apt-get-as-user/)
  console.log('install check: ok')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
