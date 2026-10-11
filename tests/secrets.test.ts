import { describe, expect, test } from 'claude-code/testing'
import { findSecrets, isForbiddenPath, scanDiff } from '../hooks/secrets'

const FAKE_ANTHROPIC = 'sk-ant-' + 'api03-' + 'A'.repeat(30)
const FAKE_GITHUB = 'ghp_' + 'b'.repeat(36)

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
