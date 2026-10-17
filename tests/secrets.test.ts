import { describe, expect, test } from 'claude-code/testing'
import { findSecrets, isForbiddenPath, scanDiff, redactSecrets, REDACTED_LINE } from '../hooks/secrets'

const FAKE_ANTHROPIC = 'sk-ant-' + 'api03-' + 'A'.repeat(30)
const FAKE_GITHUB = 'ghp_' + 'b'.repeat(36)
const BEGIN = '-----BEGIN RSA ' + 'PRIVATE KEY-----', END = '-----END RSA ' + 'PRIVATE KEY-----'
const FULL = ['MIIEpAIBAAKCAQEA'.repeat(4), 'Zm9vYmFyYmF6cXV4'.repeat(4), 'cXV1eC1ib2R5LWVu'.repeat(4)] // PEM lines: 64 characters
const LAST = 'ZA=='
const KEY = '[secret removed: private key]', R = REDACTED_LINE
const out = (lines: string[]) => redactSecrets(lines.join('\n')).split('\n')

describe('redactSecrets (plan §7: packs, tickets, agent output, views)', () => {
  test('every line is checked; a secret is replaced where it stands and the rest of its line stays', () => {
    const text = ['const a = 1', `const k = "${FAKE_ANTHROPIC}"`, '', `  token: ${FAKE_GITHUB} # x`, 'login({ password = "hunter2hunter2" })', 'done']
    expect(out(text)).toEqual(['const a = 1', 'const k = "[secret removed: Anthropic API key]"', '', '  token: [secret removed: GitHub token] # x',
      'login({ [secret removed: quoted password or key assignment] })', 'done'])
    const clean = 'nothing here\nat all\n'
    expect(redactSecrets(clean)).toBe(clean)
    expect(redactSecrets(redactSecrets(text.join('\n')))).toBe(redactSecrets(text.join('\n')))
  })

  test('a private key goes whole, as a file or a code string holds it, also when the text was cut inside it', () => {
    const block = ['before', BEGIN, ...FULL, LAST, END, 'after']
    expect(out(block)).toEqual(['before', KEY, R, R, R, R, KEY, 'after'])
    expect(redactSecrets(block.join('\n'))).not.toMatch(/MIIE|Zm9v|cXV1|ZA==/)
    expect(out([...FULL, LAST, END, 'after'])).toEqual([R, R, R, R, KEY, 'after']) // a text cut inside the block (a hunk)
    expect(out(['before', BEGIN, ...FULL, LAST])).toEqual(['before', KEY, R, R, R, R]) // cut before its END
    expect(out(['x', `"key": "${BEGIN}\\n${FULL[0]}\\n${END}\\n"`, 'y'])).toEqual(['x', `"key": "${KEY}\\n"`, 'y']) // one-line PEM in JSON
    expect(out([`'${BEGIN}\\n' +`, `'${FULL[0]}\\n' +`, `  "${FULL[1]}\\n",`, `b'${LAST}\\n' +`, `'${END}\\n'`])).toEqual([`'${KEY}\\n' +`, R, R, R, `'${KEY}\\n'`])
    expect(out([`+${BEGIN}`, `+${FULL[0]}`, `-${FULL[1]}`, ` ${LAST}`, `+${END}`])).toEqual([`+${KEY}`, R, R, R, `+${KEY}`]) // in a diff
    const ssh = ['-----BEGIN OPENSSH ' + 'PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZWQy', 'NTUxOQ==', '-----END OPENSSH ' + 'PRIVATE KEY-----']
    expect(out(ssh)).toEqual([KEY, R, R, KEY]) // OpenSSH wraps at 70
    expect(out([BEGIN, FULL[0] ?? '', `${END} ${BEGIN}`, FULL[1] ?? '', END, 'after'])).toEqual([KEY, R, `${KEY} ${KEY}`, R, KEY, 'after'])
    expect(out([BEGIN, FULL[0] ?? '', `${END} ${BEGIN}`, FULL[1] ?? ''])).toEqual([KEY, R, `${KEY} ${KEY}`, R]) // the second key has no END
  })

  test('other ways keys are written: JSON escapes, Java "+" first, armor headers, a PGP block, an encrypted PEM cut before its END', () => {
    const slashed = `MIIEvQIB\\/ADANBgkqhkiG9w0BAQEFAASCBKcwggSj\\u002BAoIBAQC7`
    expect(out([`{"private_key":"${BEGIN}\\n${slashed}\\n${END}\\n"}`])).toEqual([`{"private_key":"${KEY}\\n"}`]) // PHP \/, .NET +
    expect(out([`"${BEGIN}\\\\n${FULL[0]}\\\\n${END}\\\\n"`])).toEqual([`"${KEY}\\\\n"`]) // JSON encoded twice
    const java = [`String k = "${BEGIN}\\n"`, `        + "${FULL[0]}\\n"`, `+        + "${FULL[1]}\\n"`, `        + "${LAST}\\n"`, `        + "${END}\\n";`]
    expect(out(java)).toEqual([`String k = "${KEY}\\n"`, R, R, R, `        + "${KEY}\\n";`])
    const pgpBegin = '-----BEGIN PGP ' + 'PRIVATE KEY BLOCK-----', pgpEnd = '-----END PGP ' + 'PRIVATE KEY BLOCK-----'
    expect(out([pgpBegin, 'Version: GnuPG v2', '', FULL[0] ?? '', FULL[1] ?? '', 'abcd', '=AbCd', pgpEnd])).toEqual([KEY, 'Version: GnuPG v2', '', R, R, R, R, KEY])
    expect(out([FULL[0] ?? '', 'abcd', '=AbCd', pgpEnd, 'after'])).toEqual([R, R, R, KEY, 'after']) // cut inside, checksum above END
    expect(findSecrets(pgpBegin)).toEqual(['private key block'])
    expect(out([BEGIN, 'Proc-Type: 4,ENCRYPTED', 'DEK-Info: AES-128-CBC,0123456789ABCDEF', '', FULL[0] ?? '', LAST]))
      .toEqual([KEY, 'Proc-Type: 4,ENCRYPTED', 'DEK-Info: AES-128-CBC,0123456789ABCDEF', '', R, R])
    // a header-like line after a fake marker is skipped, never hidden
    expect(out([BEGIN, 'name: evil()', FULL[0] ?? '', END])).toEqual([KEY, 'name: evil()', R, KEY])
  })

  test('a long line costs linear time (no backtracking blow-up on whitespace or backslash runs)', () => {
    const t0 = Date.now()
    for (const line of [`a${' '.repeat(20_000)}x`, `a${'\\'.repeat(100_000)}x`, `"${'A'.repeat(20_000)}" ${' '.repeat(20_000)}+ x`, `${BEGIN}${' '.repeat(20_000)}x`]) redactSecrets(line)
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  test('code beside a stray or fake key marker, or holding a fake token, stays visible (a reviewer must still see it)', () => {
    expect(out(['const a = 1', 'exec(process.env.PAYLOAD)', `// ${END}`])).toEqual(['const a = 1', 'exec(process.env.PAYLOAD)', `// ${KEY}`])
    expect(out([`// ${BEGIN}`, 'fetch(url, { body: JSON.stringify(process.env) })', `// ${END}`])).toEqual([`// ${KEY}`, 'fetch(url, { body: JSON.stringify(process.env) })', `// ${KEY}`])
    expect(out([`exec(x) // ${FAKE_GITHUB}`, `run(y) // ${BEGIN}`])).toEqual(['exec(x) // [secret removed: GitHub token]', `run(y) // ${KEY}`])
    // a run needs a whole PEM line (60+ base64 characters): one word or a short base64 line beside a marker is not a key
    expect(out([`# ${BEGIN}`, 'reboot', `# ${END}`, 'reboot', `# ${END}`])).toEqual([`# ${KEY}`, 'reboot', `# ${KEY}`, 'reboot', `# ${KEY}`])
    expect(out([BEGIN, 'A'.repeat(59), END])).toEqual([KEY, 'A'.repeat(59), KEY])
    expect(out([BEGIN, 'A'.repeat(60), END])).toEqual([KEY, R, KEY])
    expect(out([BEGIN, FULL[0] ?? '', LAST, 'reboot', END])).toEqual([KEY, R, R, 'reboot', KEY]) // one shorter line ends a key
    expect(out([BEGIN, 'reboot', FULL[0] ?? '', END])).toEqual([KEY, 'reboot', R, KEY]) // ... and never starts one below BEGIN
    expect(out([`a("${BEGIN}"); exec(evil); b("${END}")`])).toEqual([`a("${KEY}"); exec(evil); b("${KEY}")`]) // code between markers on one line
    expect(out([`${FAKE_GITHUB} then ${FAKE_GITHUB}`])).toEqual(['[secret removed: GitHub token] then [secret removed: GitHub token]'])
  })
})

describe('secrets', () => {
  test('known token shapes and quoted password assignments are found by name', () => {
    expect(findSecrets(`key ${FAKE_ANTHROPIC}`)).toEqual(['Anthropic API key'])
    expect(findSecrets(FAKE_GITHUB)).toEqual(['GitHub token'])
    expect(findSecrets('-----BEGIN OPENSSH ' + 'PRIVATE KEY-----')).toEqual(['private key block'])
    expect(findSecrets('password = "hunter2hunter2"')).toEqual(['quoted password or key assignment'])
  })

  test('ordinary code and prose are not secrets', () => {
    expect(findSecrets('token = get_token()')).toEqual([])
    expect(findSecrets('the password must be long')).toEqual([])
    expect(findSecrets('sk-ant is a prefix')).toEqual([])
  })

  test('per-user data, env files and keys are private paths', () => {
    for (const p of ['.snagon/memory/memory.jsonl', 'mods/demo/local/config.json', '.env', 'config/.env.local', 'deploy/id_ed25519', 'certs/site.pem', 'x/memory.db']) {
      expect(isForbiddenPath(p)).toBe(true)
    }
    for (const p of ['src/env.py', 'docs/local-notes.md', 'mods/demo/hooks/memory.ts', '.envrc.example', '.env.example', 'config/.env.sample', '.env.template']) {
      expect(isForbiddenPath(p)).toBe(false)
    }
  })

  test('a diff scan reports the file and pattern of added lines only, never the value', () => {
    const diff = ['diff --git a/a.py b/a.py', '--- a/a.py', '+++ b/a.py', '@@ -1 +1 @@', `-old = "${FAKE_GITHUB}"`, `+KEY = "${FAKE_ANTHROPIC}"`].join('\n')
    const found = scanDiff(diff)
    expect(found).toEqual(['a.py: Anthropic API key'])
    expect(found.join(' ')).not.toContain('AAAA')
  })

  test('an added line that itself starts with ++ is content, not a file header', () => {
    const diff = ['diff --git a/c.txt b/c.txt', '--- a/c.txt', '+++ b/c.txt', '@@ -0,0 +1 @@', `+++ ${FAKE_GITHUB}`].join('\n')
    expect(scanDiff(diff)).toEqual(['c.txt: GitHub token'])
  })
})
