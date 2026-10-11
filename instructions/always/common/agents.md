# Agent Orchestration

## Available Agents

These agents ship with the snagon-dev-mods harness mod, not in `~/.claude/agents/`.
They are invoked through the Agent tool with a plugin-scoped `subagent_type`:

```text
Agent(subagent_type: "snagon-dev-mods:planner", prompt: "...")
```

| Agent | Purpose | When to Use |
|-------|---------|-------------|
| snagon-dev-mods:planner | Implementation planning | Complex features, refactoring |
| snagon-dev-mods:architect | System design | Architectural decisions |
| snagon-dev-mods:tdd-guide | Test-driven development | New features, bug fixes |
| snagon-dev-mods:code-reviewer | Code review | After writing code |
| snagon-dev-mods:security-reviewer | Security analysis | Before commits |
| snagon-dev-mods:build-error-resolver | Fix build errors | When build fails |
| snagon-dev-mods:e2e-runner | E2E testing | Critical user flows |
| snagon-dev-mods:refactor-cleaner | Dead code cleanup | Code maintenance |
| snagon-dev-mods:doc-updater | Documentation | Updating docs |
| snagon-dev-mods:rust-reviewer | Rust code review | Rust projects |
| snagon-dev-mods:harmonyos-app-resolver | HarmonyOS app development | HarmonyOS/ArkTS projects |

The full roster of 68 agents is in the mod's `agents/` folder.

## Immediate Agent Usage

No user prompt needed:
1. Complex feature requests - Use **snagon-dev-mods:planner** agent
2. Code just written/modified - Use **snagon-dev-mods:code-reviewer** agent
3. Bug fix or new feature - Use **snagon-dev-mods:tdd-guide** agent
4. Architectural decision - Use **snagon-dev-mods:architect** agent

## Parallel Task Execution

ALWAYS use parallel Task execution for independent operations:

```markdown
# GOOD: Parallel execution
Launch 3 agents in parallel:
1. Agent 1: Security analysis of auth module
2. Agent 2: Performance review of cache system
3. Agent 3: Type checking of utilities

# BAD: Sequential when unnecessary
First agent 1, then agent 2, then agent 3
```

## Delegation Completion Contract

Applies to every agent at every depth (parent, child, grandchild):

1. **Your final message IS the deliverable.** Never end your turn with "waiting for background agents" — a spawned task is not a completed task. Ending your turn while children are running orphans their results (completed children cannot notify a parent whose turn has ended).
2. **If you delegate, you own collection.** Wait for results, integrate them, then return. Fire-and-forget delegation is forbidden.
3. **Decompose only when the work cannot fit in one context.** Do not re-delegate a task already sized for a single agent — depth is an outcome, not a plan.

> Rationale: observed failure mode — research agents followed "Parallel Task Execution" above, spawned children, and returned "waiting" as their final answer. All children completed successfully but their results were orphaned. The parallel rule without a completion contract produces zombie tasks.

## Multi-Perspective Analysis

For complex problems, use split role sub-agents:
- Factual reviewer
- Senior engineer
- Security expert
- Consistency reviewer
- Redundancy checker
