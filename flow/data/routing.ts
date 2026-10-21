// Which identity agent, model, skills and references each role uses in a flow ticket (plan v7.1 §3, §8, §8.1).
// Vendored names refer to flow/vendor/agent-skills (MIT, step 12); a developer check lists what must exist.
import type { Role, Routing } from './types'

export const ROUTING: Routing = {
  agents: {
    planner: { agent: 'planner', model: 'opus' },
    red: { agent: 'tdd-guide', model: 'sonnet' },
    author: { agent: 'tdd-guide', model: 'sonnet' },
    reviewer: { agent: 'code-reviewer', model: 'sonnet' },
    securityReviewer: { agent: 'security-reviewer', model: 'sonnet' },
    debugger: { agent: 'tdd-guide', model: 'sonnet' },
    // each stack names its own build fixer (its data's `routing`); the core's is the debugger, as for a stack with none of
    // its own (GAP-R2-15): build-error-resolver is TypeScript's
    buildFixer: { agent: 'tdd-guide', model: 'sonnet' },
  },
  skills: {
    planner: ['planning-and-task-breakdown'],
    red: [],
    author: ['incremental-implementation'],
    reviewer: ['code-review-and-quality'],
    securityReviewer: ['security-and-hardening'],
    debugger: ['debugging-and-error-recovery'],
    buildFixer: ['debugging-and-error-recovery'],
  },
  references: {
    planner: [],
    red: ['testing-patterns'],
    author: ['testing-patterns'],
    reviewer: ['testing-patterns', 'definition-of-done'],
    securityReviewer: ['security-checklist'],
    debugger: [],
    buildFixer: [],
  },
  pluginProjectSkills: ['plugin-authoring'],
  freeSpawn: ['Explore'],
  allowTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Agent', 'Task', 'Skill', 'TodoWrite', 'ToolSearch', 'AskUserQuestion'],
  vendored: {
    skills: [
      'interview-me', 'idea-refine', 'constraint-driven-development', 'planning-and-task-breakdown', 'incremental-implementation',
      'debugging-and-error-recovery', 'source-driven-development', 'code-review-and-quality', 'security-and-hardening',
      'performance-optimization', 'ci-cd-and-automation', 'observability-and-instrumentation', 'shipping-and-launch',
      'deprecation-and-migration',
    ],
    agents: ['test-engineer', 'security-auditor', 'web-performance-auditor'],
    references: [
      'definition-of-done', 'testing-patterns', 'security-checklist', 'orchestration-patterns', 'performance-checklist',
      'accessibility-checklist', 'observability-checklist',
    ],
  },
}

/** Share of changed lines in the stack's own files (its `ownsFile`) from which the stack's reviewer takes the review (plan
 * §3 B4; R2 plan §3.1, §4.4). */
export const STACK_SHARE = 0.7

/** The agent a role's ticket goes to: the stack's own (its data's `routing`) when it names one, else the core's; the
 * stack's reviewer only from STACK_SHARE of the changed lines (`share`, 0..1) in the stack's own files (R2 plan §4.4). */
export function routedAgent(role: Role, share: number, stackAgents: Readonly<Partial<Record<Role, string>>>): string {
  const own = stackAgents[role]
  return own && (role !== 'reviewer' || share >= STACK_SHARE) ? own : ROUTING.agents[role].agent
}

/** The approved commands whose red run goes to the stack's build fixer (R2 plan §4.4, AC-BF-1). */
const BUILD_COMMANDS: readonly string[] = ['typecheck', 'build', 'lint']
/** The role of the debug ticket for the red command `id`: the build fixer for a typecheck, build or lint, the debugger for
 * a test (and any other command, as before 0.6.0).
 * ASSUMPTION(GAP-R2-0.6-84): with several commands red, the first in the approved order routes the ticket, being the one
 * whose output it carries (flow-judging runAll, flow-verify verifyStep). */
export const debugRole = (id: string): 'buildFixer' | 'debugger' => (BUILD_COMMANDS.includes(id) ? 'buildFixer' : 'debugger')

/** The plugin the routed agents ship in (plugin.json `name`; tests/flow-data.check.mjs compares them). */
export const AGENT_PLUGIN = 'snagon-dev-mods'
/** The name a routed agent is started by: the Agent tool and a spawn rewrite take a plugin's agent only as
 * `<plugin>:<name>` (checked live on 2.1.302: a bare name is refused, or starts a project agent of that name). */
export const dispatchType = (agent: string): string => `${AGENT_PLUGIN}:${agent}`
