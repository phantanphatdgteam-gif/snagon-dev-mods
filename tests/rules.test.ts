import { describe, expect, test } from 'claude-code/testing'
import { globToRegExp, matchesAny, pathsOf, stripForLoad } from '../hooks/rules'

const RULE = '---\npaths:\n  - "**/*.py"\n  - \'**/*.pyi\'\n  - **/go.mod\n---\n# Python\n\nBody <!-- hidden note --> text.\n'

describe('rules', () => {
  test('stripForLoad drops the frontmatter and HTML block comments, keeps the body', () => {
    expect(stripForLoad(RULE)).toBe('# Python\n\nBody  text.\n')
    expect(stripForLoad('<!-- a\nmulti-line note -->\n## Rule\nkeep\n')).toBe('## Rule\nkeep\n')
    expect(stripForLoad('plain\n')).toBe('plain\n')
  })

  test('pathsOf reads quoted and bare list items and stops at the frontmatter end', () => {
    expect(pathsOf(RULE)).toEqual(['**/*.py', '**/*.pyi', '**/go.mod'])
    expect(pathsOf('# no frontmatter\npaths:\n  - "**/*.py"\n')).toEqual([])
    expect(pathsOf('---\ndescription: x\n---\nbody')).toEqual([])
    expect(pathsOf('---\npaths: ["**/*.py", \'**/*.pyi\']\n---\nb')).toEqual(['**/*.py', '**/*.pyi'])
    expect(pathsOf('---\npaths: "**/*.md"\n---\nb')).toEqual(['**/*.md'])
  })

  test('globToRegExp: ** spans folders (or none), * and ? stay inside one segment, dots are literal', () => {
    expect(globToRegExp('**/*.py').test('src/lotto535/a.py')).toBe(true)
    expect(globToRegExp('**/*.py').test('a.py')).toBe(true)
    expect(globToRegExp('**/*.py').test('a.pyc')).toBe(false)
    expect(globToRegExp('**/*.py').test('apy')).toBe(false)
    expect(globToRegExp('src/*.ts').test('src/x/y.ts')).toBe(false)
    expect(globToRegExp('**/nuxt.config.*').test('web/nuxt.config.ts')).toBe(true)
    expect(globToRegExp('**/?.md').test('docs/a.md')).toBe(true)
  })

  test('matchesAny accepts absolute paths and needs one matching glob', () => {
    expect(matchesAny('/Users/x/proj/src/a.py', ['**/*.ts', '**/*.py'])).toBe(true)
    expect(matchesAny('/Users/x/proj/README.md', ['**/*.py'])).toBe(false)
    expect(matchesAny('/Users/x/proj/go.mod', ['**/go.mod'])).toBe(true)
    expect(matchesAny('/Users/x/proj/a.py', [])).toBe(false)
  })
})
