---
name: cost-aware-claude-pipeline
description: Cost-aware patterns for apps that call the Claude API and for Claude Code subagents, updated for the current lineup (Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 4.5; Haiku 3.5 is retired). Covers which levers to pull first (prompt caching, batch, effort) before model routing, current prices and per-model cache minimums, immutable budget tracking, the SDK's built-in retries, and choosing the `model` and `effort` for each subagent. Use this whenever you write or review code that calls Claude or another LLM API and spend matters, route work across model tiers, set an API budget, process batches, or are about to spawn subagents / Agent-tool workers that a cheaper model could handle - even if the user never says "cost".
metadata:
  origin: "Project 535 - updated successor of an upstream cost-aware-llm-pipeline skill (see CREDITS.md)"
  model-data-as-of: "2026-09-25"
---

# Cost-Aware Claude Pipeline

The goal is a lower cost per *completed task* without lower quality. A cheap request that needs a retry or a second pass is not cheap.

Model IDs and prices below are a snapshot (2026-09-25, taken from the `claude-api` skill). They go stale - that is how the original upstream skill ended up recommending Sonnet 5 and the retired Haiku 3.5. For everyday decisions the snapshot is enough. Before hardcoding an ID into code that ships, or quoting prices in a report, confirm them with the `claude-api` skill or `client.models.list()` - that lookup costs extra tokens, so don't repeat it for every answer.

To audit the bill of an existing codebase end to end (measure, rank levers, propose diffs), run the `claude-api` skill's `cost-optimize` workflow. This skill is the pattern library that work draws on.

## 1. Current models (snapshot 2026-09-25)

| Model | ID | Input / Output ($ per 1M tokens) | Cache read | Context / max output | Reach for it when |
|---|---|---|---|---|---|
| Claude Fable 5.1 | `claude-fable-5-1` | $10 / $50 | $0.25 (0.025x) | 1M / 128K | The hardest long-horizon reasoning, and only when asked for: thinking is always on and it requires 30-day data retention |
| Claude Opus 5.5 | `claude-opus-5-5` | $4 / $20 | $0.20 (0.05x) | 1M / 128K | Complex coding and agentic work; the general default. Effort defaults to `medium` on this model |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | $2 / $10 | $0.20 (0.1x) | 1M / 128K | Everyday coding, agents, and workers that still need judgment |
| Claude Haiku 4.5 | `claude-haiku-4-5` | $1 / $5 | about $0.10 (0.1x) | 200K / 64K | High-volume work with checkable outputs: classification, extraction, read-and-summarize workers |

What changed since the upstream original:

- **Sonnet 5 to Sonnet 5.5 costs the same per token** ($2 / $10). The upgrade buys a newer model, not a lower price, and it is still a migration (for example `thinking: {"type": "disabled"}` now returns a 400) - use the `claude-api` skill's `migrate` workflow.
- **Opus got cheaper**: Opus 5.5 is $4 / $20, against $5 / $25 for Opus 5 and Opus 4.8 / 4.7 / 4.6. Moving an Opus 4.x workload to Opus 5.5 is often the easiest saving there is.
- **Haiku 3.5 (`claude-3-5-haiku-20241022`) was retired on 2026-02-19** - calls to it fail. Use `claude-haiku-4-5`.
- Previous generation, still served: Fable 5 ($10 / $50), Opus 5 and Opus 4.8 / 4.7 / 4.6 ($5 / $25), Sonnet 5 ($2 / $10), Sonnet 4.6 ($3 / $15). Deprecated or already retired - migrate off: Opus 4.1, Opus 4, Sonnet 4, Haiku 3.
- Use the aliases exactly as written and don't append date suffixes. Haiku 4.5 also has the snapshot ID `claude-haiku-4-5-20251001`, but the alias is preferred.

Price modifiers that often matter more than the list price:

- **Prompt caching**: writes cost 1.25x (5-minute TTL) or 2x (1-hour TTL); reads cost about 0.1x (0.05x on Opus 5.5, 0.025x on Fable 5.1). Two requests on a 5-minute cache already break even.
- **Batch API**: 50% off every token, including cache reads and writes - the discounts stack.
- **Fast mode** on Opus 5.5 ($8 / $40) is a speed premium, not a saving.

## 2. Pull the levers in this order

The first levers lower the bill without touching quality. The later ones trade capability for cost, so they come last and get measured on an eval.

1. **Prompt caching** - stable content first, volatile content after the last breakpoint (section 6).
2. **Token hygiene** - send less input (retrieve only what the task needs), cap output verbosity, and keep agent loops from re-sending an ever-growing history.
3. **Batch API** for anything no one is waiting on: nightly jobs, backfills, eval runs (section 8).
4. **Effort** - sweep `output_config={"effort": ...}` on the current model before switching models (section 7).
5. **Task budgets** (beta) for agent loops that run long.
6. **Model routing** - last, and judged on cost per completed task (section 3).

## 3. Model routing - when it earns its place

Check for an *upgrade* before a step-down: a newer model at lower effort is often cheaper per solved task than an older model at high effort. Price the hard tail of the workload, not the median - the bill is decided by the tasks the cheap model fails. Caches are scoped per model, so a cascade gives up cache reuse; switch models between conversations, not in the middle of one (the cache cold-starts and newer models drop other models' thinking blocks).

Routing to a cheaper tier changes what the product can do, so it is the owner's decision - validate it on an eval before shipping.

```python
# Keep model IDs in one place (config), never scattered through the code.
# Snapshot 2026-09-25 - re-check with the claude-api skill before changing.
MODEL_FAST = "claude-haiku-4-5"      # $1 / $5,  200K context
MODEL_DEFAULT = "claude-sonnet-5-5"  # $2 / $10, 1M context
MODEL_DEEP = "claude-opus-5-5"       # $4 / $20, 1M context

_LONG_TEXT_CHARS = 10_000  # complexity proxies from the original skill - tune them from logged outcomes
_MANY_ITEMS = 30

def select_model(
    text_length: int,
    item_count: int,
    *,
    needs_deep_reasoning: bool = False,
    force_model: str | None = None,
) -> str:
    """Pick the cheapest tier that fits the task."""
    if force_model is not None:
        return force_model
    if needs_deep_reasoning:
        return MODEL_DEEP
    if text_length >= _LONG_TEXT_CHARS or item_count >= _MANY_ITEMS:
        return MODEL_DEFAULT
    return MODEL_FAST
```

Log every routing decision together with its outcome, so the thresholds get tuned from data instead of guessed.

## 4. Immutable cost tracking

Price each response from its `usage` block. `input_tokens` excludes the cached part of the prompt, so cache reads and writes are priced separately.

```python
from dataclasses import dataclass

# (input, output, cache_read) USD per 1M tokens - snapshot 2026-09-25
PRICES = {
    "claude-fable-5-1": (10.00, 50.00, 0.25),
    "claude-opus-5-5": (4.00, 20.00, 0.20),
    "claude-sonnet-5-5": (2.00, 10.00, 0.20),
    "claude-haiku-4-5": (1.00, 5.00, 0.10),
}
CACHE_WRITE_MULTIPLIER = {"5m": 1.25, "1h": 2.0}

def cost_usd(model: str, usage, *, batch: bool = False, cache_ttl: str = "5m") -> float:
    price_in, price_out, price_read = PRICES[model]
    cache_writes = getattr(usage, "cache_creation_input_tokens", 0) or 0
    cache_reads = getattr(usage, "cache_read_input_tokens", 0) or 0
    total = (
        usage.input_tokens * price_in
        + usage.output_tokens * price_out
        + cache_reads * price_read
        + cache_writes * price_in * CACHE_WRITE_MULTIPLIER[cache_ttl]
    ) / 1_000_000
    return total * 0.5 if batch else total

@dataclass(frozen=True, slots=True)
class CostRecord:
    model: str
    input_tokens: int
    output_tokens: int
    cost_usd: float

@dataclass(frozen=True, slots=True)
class CostTracker:
    budget_limit: float = 1.00
    records: tuple[CostRecord, ...] = ()

    def add(self, record: CostRecord) -> "CostTracker":
        """Return a new tracker with the record added (never mutates self)."""
        return CostTracker(budget_limit=self.budget_limit, records=(*self.records, record))

    @property
    def total_cost(self) -> float:
        return sum(r.cost_usd for r in self.records)

    @property
    def over_budget(self) -> bool:
        return self.total_cost > self.budget_limit
```

Check the budget *before* each call and stop early. Because the tracker never mutates, every step of a run can be audited afterwards.

## 5. Retries - let the SDK do them

The SDK already retries 408, 409, 429, 5xx (including 529 overloaded) and connection errors with exponential backoff, 2 retries by default. A hand-written retry loop on top multiplies the attempts and burns budget. Raise the retry count instead, and fail fast on errors a retry cannot fix (400, 401, 402, 403, 404, 413):

```python
import anthropic

client = anthropic.Anthropic(max_retries=4)  # per call: client.with_options(max_retries=6)

try:
    response = client.messages.create(model=MODEL_DEFAULT, max_tokens=16000, messages=messages)
except anthropic.NotFoundError:
    ...  # 404 - often a retired or misspelled model ID
except anthropic.RateLimitError:
    ...  # still throttled after the SDK's retries: slow down, queue, or move the work to the Batch API
except anthropic.APIStatusError as err:
    ...  # other HTTP errors: 4xx means fix the request; 5xx was already retried
except anthropic.APIConnectionError:
    ...  # network failure before a response
```

## 6. Prompt caching

```python
response = client.messages.create(
    model=MODEL_DEFAULT,
    max_tokens=16000,
    system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
    messages=[{"role": "user", "content": user_input}],  # the variable part comes after the breakpoint
)
print(response.usage.cache_read_input_tokens)  # should be > 0 from the second call on - verify, don't assume
```

A prefix shorter than the model's minimum silently doesn't cache (no error, `cache_creation_input_tokens == 0`):

| Minimum cacheable prefix | Models |
|---|---|
| 512 tokens | Opus 5.5, Opus 5, Fable 5.1, Fable 5, Sonnet 5.5 (confirm in the caching docs before relying on it) |
| 1024 tokens | Sonnet 5, Opus 4.8, Sonnet 4.6 |
| 2048 tokens | Opus 4.7 |
| 4096 tokens | Haiku 4.5, Opus 4.6, Opus 4.5 |

The minimum is not monotonic: a 3,000-token system prompt caches on Sonnet 5.5 but not on Haiku 4.5, which can change which tier is actually cheaper for a workload.

- **TTL**: the default 5-minute TTL is refreshed by every read, so requests less than 5 minutes apart keep it warm. Use `{"type": "ephemeral", "ttl": "1h"}` only when the same prefix is reused with 5 to 60 minute gaps.
- **Silent invalidators**: timestamps or request IDs in the system prompt, unsorted JSON, a tool list that changes between requests. Caches are also per model and per workspace.

## 7. Effort - the cost knob inside one model

```python
response = client.messages.create(
    model=MODEL_DEFAULT,
    max_tokens=16000,
    output_config={"effort": "low"},  # low | medium | high | xhigh | max
    messages=messages,
)
```

- The default is `high` on current models except Opus 5.5, where it is `medium` - set it explicitly.
- Research and knowledge work has nearly flat curves, so `low` or `medium` save a lot. Long-horizon coding is a real tradeoff - measure it.
- With a checker (tests, a validator), run everything at a low setting and re-run only the failures at a higher one; that kept the pass rate for a little over half the cost in Anthropic's coding runs.
- Haiku 4.5 has no effort parameter (it errors); its cost knob is the model choice itself.
- Thinking is adaptive by default on current models. On Opus 5.5 it cannot be disabled (400) - lower the effort instead. On Sonnet 5.5, `{"type": "disabled"}` is a 400; send `{"type": "between_tools"}` if a route must stay thinking-off.

## 8. Batch API

```python
batch = client.messages.batches.create(requests=[
    {"custom_id": f"msg-{i}", "params": {"model": MODEL_FAST, "max_tokens": 256, "messages": [{"role": "user", "content": text}]}}
    for i, text in enumerate(texts)
])
# Poll client.messages.batches.retrieve(batch.id).processing_status until it is "ended",
# then iterate client.messages.batches.results(batch.id). Results arrive in any order - key them by custom_id.
```

Batches are single-shot (no tool loop inside a request), and the 50% discount stacks with caching.

## 9. Claude Code subagents - choose the `model` and `effort` on purpose

When the main agent spawns a subagent with the Agent tool and leaves `model` unset, the subagent falls back to its definition's `model`, then `CLAUDE_CODE_SUBAGENT_MODEL`, then the session model - usually Opus 5.5 ($4 / $20), sometimes Fable. That is the most expensive way to grep a repository.

| Subagent job | `model` | `effort` | Why |
|---|---|---|---|
| Search or explore, scan many files, summarize logs, simple lookups | `haiku` | none - Haiku 4.5 has no effort | Read-heavy and easy to verify |
| Implement an approved plan, write tests or docs, review against clear criteria | `sonnet` | `medium` | Needs judgment, not frontier reasoning |
| Research or claim verification whose output becomes a spec or a decision | `sonnet` or `opus` | `high`; `max` when the owner asks | A wrong claim costs more later than the extra tokens now |
| Architecture, hard debugging, security or correctness review | `opus` | `high` to `max` | Mistakes here are expensive |
| Frontier-only work the user explicitly asked for | `fable` | as asked | Thinking always on; $10 / $50 |

On the Anthropic API these aliases currently resolve to the latest Haiku (4.5), Sonnet 5.5, Opus 5.5 and Fable 5.1. On Bedrock, Vertex or Foundry, `sonnet` and `opus` can map to older models - check `/model` there.

Setting `effort` (checked 2026-10-07 on code.claude.com):

- Claude Code 2.1.292 (2026-10-06) added an `effort` parameter to the Agent tool: `low | medium | high | xhigh | max`; the levels available depend on the model. Older versions have no per-call `effort` - there a subagent's effort comes from its definition, the settings or the session. The Homebrew cask `claude-code` follows the stable channel (2.1.285 on 2026-10-07); `claude-code@latest` follows the latest channel.
- A custom agent's frontmatter `effort` overrides the session effort level, but not the `CLAUDE_CODE_EFFORT_LEVEL` environment variable.
- Settings `modelSettings.<model>.effortLevel` and `CLAUDE_CODE_EFFORT_LEVEL` change the effort of every use of that model or of the whole session, not of one subagent - keep them for defaults, and choose a single task's effort with the per-call `effort` or a custom agent's frontmatter.
- How a per-call `effort` ranks against a definition's `effort` and settings `modelSettings.<model>.effortLevel` is not documented - after spawning, check the subagent's row in `/tasks`.
- Section 7 still applies: knowledge work has nearly flat effort curves, so `high` usually suffices; keep `max` for when the owner asks or a wrong answer is expensive.

- `subagent_type: "fork"` always inherits the parent's model and ignores `model`, so don't fork work that a cheaper tier can do. Whether a fork inherits the parent's effort is not documented.
- Custom agents in `.claude/agents/` may declare their own `model:` (the `security-reviewer` agent declares `sonnet`). When the job needs a different tier, pass `model` on the call - the call's value wins.

Before spawning at all:

- Split work only when there is bulk to fan out (many independent pieces). For one dependent chain, the main agent at a lower effort beats a planner plus handoffs plus a merge.
- Don't spawn a subagent for a single lookup the main agent can do directly.
- Cheap search subagents are fine; double-check their findings before acting on them.
- A project-wide default for unassigned subagents is `CLAUDE_CODE_SUBAGENT_MODEL` (for example `sonnet`) in the settings `env` - that is the project owner's call.

## Anti-patterns

- Hardcoding retired or stale IDs (`claude-3-5-haiku-20241022`, or `claude-sonnet-5` in new code), or scattering IDs across files.
- Routing to a cheaper model before caching, batching and effort are done.
- Wrapping SDK calls in a catch-all retry loop, or retrying 4xx errors.
- Assuming the cache works: check `cache_read_input_tokens`, and remember that prefixes under the model's minimum silently don't cache.
- Switching models in the middle of a conversation in a cascade.
- Leaving a subagent's `model` or `effort` unset out of habit.
