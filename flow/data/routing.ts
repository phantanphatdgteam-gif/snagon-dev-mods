// Which identity agent, model, skills and references each role uses in a flow ticket (plan v7.1 §3, §8, §8.1).
// Vendored names refer to flow/vendor/agent-skills (MIT, step 12); a developer check lists what must exist.
import type { Routing } from './types'

export const ROUTING: Routing = {
  agents: {
    planner: { agent: 'planner', model: 'opus' },
    red: { agent: 'tdd-guide', model: 'sonnet' },
    author: { agent: 'tdd-guide', model: 'sonnet' },
    reviewer: { agent: 'code-reviewer', typescript: 'typescript-reviewer', model: 'sonnet' },
    securityReviewer: { agent: 'security-reviewer', model: 'sonnet' },
    debugger: { agent: 'tdd-guide', model: 'sonnet' },
    buildFixer: { agent: 'build-error-resolver', model: 'sonnet' },
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

/** B1's testing text (plan §3 B1, §8 routing fallbacks, §8.1): these sections of the vendored testing-patterns reference,
 * which shows TypeScript (the MVP's only stack). tests/vendor.check.mjs reads this line. */
export const RED_TESTING = { reference: 'testing-patterns', sections: ['Test Structure', 'Test Naming', 'Mock at Boundaries Only', 'Test Anti-Patterns'] } as const

/** Share of changed lines in TypeScript from which the TypeScript reviewer takes the review (plan §3 B4). */
export const TYPESCRIPT_SHARE = 0.7

/** The agent a role's ticket goes to, given the share (0..1) of changed lines that are TypeScript. */
export function routedAgent(role: keyof Routing['agents'], typescriptShare: number): string {
  const r = ROUTING.agents[role]
  return typescriptShare >= TYPESCRIPT_SHARE && r.typescript ? r.typescript : r.agent
}

/** The plugin the routed agents ship in (plugin.json `name`; tests/flow-data.check.mjs compares them). */
export const AGENT_PLUGIN = 'snagon-dev-mods'
/** The name a routed agent is started by: the Agent tool and a spawn rewrite take a plugin's agent only as
 * `<plugin>:<name>` (checked live on 2.1.302: a bare name is refused, or starts a project agent of that name). */
export const dispatchType = (agent: string): string => `${AGENT_PLUGIN}:${agent}`
