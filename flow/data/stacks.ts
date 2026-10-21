// The stacks flow knows (R2 plan §3.1), in the order S1 tries them: each one's data in flow/data/stacks/<id>.ts, its
// code in hooks/stacks/<id>.ts (the registry, hooks/stacks/index.ts, pairs them).
import type { Stack } from './types'
import { PYTHON } from './stacks/python'
import { TYPESCRIPT } from './stacks/typescript'

export const STACKS: readonly Stack[] = [TYPESCRIPT, PYTHON]
