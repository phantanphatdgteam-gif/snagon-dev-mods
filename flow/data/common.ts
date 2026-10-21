// Safety data every stack shares (R2 plan §3.1, architect review A-3), whatever stack a flow froze: the credential
// files that Bash and the judge may never read, and the publishing commands the guard denies.
import type { Stack } from './types'
import { STACKS } from './stacks'

/** A stack's own credential files are in its data (`sandbox.denyRead`); the proposed sandbox block holds both, the
 * stack's first, so a block frozen before R2 hashes the same. */
export const COMMON_DENY_READ: readonly string[] = ['~/.netrc', '~/.git-credentials', '~/.config/gh', '~/.pypirc', '~/.docker/config.json', '~/.ssh', '~/.aws', '~/.config/gcloud', '~/.kube']

const unique = (xs: readonly string[]): string[] => [...new Set(xs)]
/** Every stack's publishing commands in one list: a flow on one stack still cannot publish with another's tools. */
export const PUBLISH_UNION: Stack['publish'] = {
  tools: unique(STACKS.flatMap(s => s.publish.tools)),
  subcommands: unique(STACKS.flatMap(s => s.publish.subcommands)),
  prefixes: Object.fromEntries(unique(STACKS.flatMap(s => Object.keys(s.publish.prefixes))).map(t => [t, unique(STACKS.flatMap(s => s.publish.prefixes[t] ?? []))])),
  valueOptions: unique(STACKS.flatMap(s => s.publish.valueOptions)),
  releaseTools: unique(STACKS.flatMap(s => s.publish.releaseTools)),
}
