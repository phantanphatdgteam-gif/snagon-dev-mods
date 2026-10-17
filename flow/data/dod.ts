// The standing Definition of Done (agent-skills references/definition-of-done.md), each row mapped to the check that
// decides it (plan v7.1 §8.1). A row with no check in this release says so; it is never reported as passed.
import type { DodRow } from './types'

export const NOT_CHECKED = 'not checked in this release'

export const DOD: readonly DodRow[] = [
  { id: 'DOD-T1', level: 'task', text: 'Every acceptance criterion of the task is met.', check: 'B3: the eval ids named by the ACs pass' },
  { id: 'DOD-T2', level: 'task', text: 'The behaviour is verified by running it, not only by compiling it.', check: 'B3: the approved test command runs the eval tests' },
  { id: 'DOD-T3', level: 'task', text: 'New behaviour fails without the change.', check: 'B1: RED proof; B3: RED tests unchanged' },
  { id: 'DOD-T4', level: 'task', text: 'Nothing that worked before is broken.', check: 'B3: every approved command passes its mode against the baseline' },
  { id: 'DOD-T5', level: 'task', text: 'Edge cases and error paths are handled.', check: 'B4: rubric CODE-C2' },
  { id: 'DOD-T6', level: 'task', text: 'The code reveals its intent and has no duplicated logic.', check: 'B4: rubric CODE-R1' },
  { id: 'DOD-T7', level: 'task', text: 'No dead code, debug output or commented-out blocks are added.', check: 'B3 and V4: the introduced-junk scan' },
  { id: 'DOD-T8', level: 'task', text: 'The change stays inside the task.', check: 'B3: file scope; fix rounds: the FIX map' },
  { id: 'DOD-T9', level: 'task', text: 'Lint and type checks pass.', check: 'B3: the approved lint and typecheck commands' },
  { id: 'DOD-F1', level: 'feature', text: 'The feature integrates with the rest of the system.', check: 'V1: every approved command at the verified tree' },
  { id: 'DOD-F2', level: 'feature', text: 'Public interfaces are documented.', check: NOT_CHECKED },
  { id: 'DOD-F3', level: 'feature', text: 'Decisions are recorded as ADRs.', check: NOT_CHECKED },
  { id: 'DOD-R1', level: 'release', text: 'A security review was done where the feature needs one.', check: 'B4: security-reviewer when Security: yes' },
  { id: 'DOD-R2', level: 'release', text: 'There is a rollback path.', check: NOT_CHECKED },
  { id: 'DOD-R3', level: 'release', text: 'New critical paths are observable.', check: NOT_CHECKED },
  { id: 'DOD-R4', level: 'release', text: 'A human approved the release.', check: 'H1: /flow-approve release from the owner' },
]
