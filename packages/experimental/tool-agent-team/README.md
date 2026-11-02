---
description: "Ten tools that let the model create, message, and coordinate teammates, for compositions mounting the experimental Team plugins."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-agent-team

English | [中文](README.zh.md)

## Summary

This package lets the model create named teammates, send them messages, inspect availability, wait for progress, interrupt stuck work, and coordinate through a shared task board. Every team member receives the same ten tools and guidance for coordinating in a shared workspace. It replaces legacy subagent controls with the same tool names, so compositions that need both must disable the legacy definitions. The package is published under its experimental name and provides no stability guarantee.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Add this package on top of `@deepseek-ai/dsh-experimental-agent-team` when the model should run a team through tools. Once mounted, every team member — the Lead and each teammate — gets the same ten tools plus the same coordination policy. Each member receives its current role and name through required runtime context; `spawn_teammate` sends the initial task, optionally enriched by the required task brief.

### When to choose it

Choose it when the model should create and coordinate teammates by itself rather than a human driving subagent controls. Avoid it when the legacy global subagent tools with the same names must stay available: the team tools replace them for team members, so a composition that wants both must disable the legacy definitions.

### Smallest working example

The smallest addition to an existing composition is the two-package fragment from the [agent-team README](../agent-team/README.md#smallest-working-setup): durable session storage, the team domain package, and this package. The plugin accepts delegation providers and optional coding policy:

```yaml
- id: tool-agent-team
  name: '@deepseek-ai/dsh-experimental-tool-agent-team'
  config:
    freshProvider: spawn
    forkProvider: fork
```

| Field | Default | Meaning |
|---|---|---|
| `freshProvider` | `spawn` | Provider that starts fresh teammates |
| `forkProvider` | `fork` | Provider that starts fork teammates |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-tool-agent-team) is the exhaustive source for every accepted field and its JSDoc.

Try it by asking the Lead model: "create a teammate named reviewer to check the diff, then send reviewer the change summary". The model calls the creation tool and then the messaging tool.

### What the model can do

The ten tools group into five capabilities:

- **Choose a model** — `select_model_profile` selects an approved route for the calling agent’s next step.
- **Create a teammate** — `spawn_teammate` takes a name, a description, and the initial task; only the Lead can call it.
- **Send messages** — `send_message` steers a running member at its nearest step boundary, starts or resumes an inactive member.
- **See and wait** — `list_agents` returns each member’s `target` and availability; `wait_agent` waits for the next team change; `interrupt_agent` stops a teammate's current turn (Lead only).
- **Manage the task board** — `team_task_create`, `team_task_list`, `team_task_get`, and `team_task_update` add, browse, read, and update shared tasks.

Creation and listing results identify members by `target`, with no member Session ID. Use that value in message and interrupt calls or the task tools’ `owner` parameter; task `ownerName` uses the same value. `inactive` means no turn is executing, whether the member is loaded or must be resumed; it does not describe task completion or outcome. `provisioning` and `failed` describe member creation. Any member can message any other member and use the task board; only the Lead creates and interrupts teammates. Task updates keep the domain's owner and revision checks, so an outdated edit is rejected instead of overwriting newer work.

### What success and failure look like

`send_message` returns `{ "sent": true }` after inbox acceptance, without exposing the message ID. Success does not confirm recipient processing or a synchronous storage flush; send failures are reported as tool errors. `wait_agent` returns `noProgress` right away when no other member is running or provisioning, telling the caller to wake a teammate first; otherwise it waits for the next change and the caller re-reads state afterward. Task edits based on an outdated revision are rejected rather than overwriting newer work.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the adapter and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The adapter is built on three commitments:

- **Scoped, not global.** Every registration lives on the member Agent's own `ctx`; installation uses the member identity available when the Agent is published.
- **Declared results, compact JSON.** Every tool declares its complete result schema and renders that value as compact JSON, so the compiler checks `execute` against what the model is promised and no result spends tokens on indentation.
- **The domain owns authority.** Tools delegate to `ctx.agentTeams`, which enforces Lead authority and revision checks; the adapter adds no weaker path.

The [Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.md) owns the model-facing and scoping decisions.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config, the fixed policy text, and the ten scoped tool registrations |

### Policy and tools

One `team:policy` section on the member scope states the shared coordination rules; the fixed text and the ten tool registrations are declared in [`src/index.ts`](src/index.ts). The ten tool schemas are registered in scopes recognized as Team members at publication. Scoped registrations with the same names as the legacy global continuable-subagent controls shadow those globals for team members only.

### Scoped registration and teardown

`maybeInstall` runs for every live Agent and subscribes to `agent/created`; it skips Agents without Team membership. Disposal of an Agent runs the installed disposer, and plugin HMR disposes every installed scope before reinstall. Each disposer unwinds registrations in reverse order, so a failed install cannot leave a partial scope.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the domain service to the exact schemas and the decisions behind the design.

- [agent-team package](../agent-team/README.md) — the `ctx.agentTeams` domain service behind these tools.
- [Agent Teams subsystem](../../../docs/subsystems/agent-team.md) — durable Team types and service API.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-tool-agent-team) — every tool schema the model receives.
- [Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.md) — model-facing, scoping, and isolation decisions.

-----

## Coding policy

When `coding.decisions.enabled` is true, `coding_decide` adds bounded OpenRouter decision advice, separate from chat models. It batches Choice, Noul (yes/no probability) and Score (ordered rubric) questions. Below-threshold answers remain uncertain; invalid or contradictory responses fail with sanitized codes. Reported confidence is capped by the distribution-derived confidence; missing Choice/Score confidence abstains, while Noul uses `abs(2p-1)`. Confidence is a distribution statistic, not proof of correctness. Deadlines, complete text-byte limits and a shared per-turn request budget bound overhead. No automatic retry or workflow action occurs. Explicit retained images remain supported; remote image URLs are refused. Credentials and provider error bodies are never returned. Tool advice reports model, usage and elapsed time separately from chat-model accounting.

The volatile `coding` configuration optionally requires `spawn_teammate` to name a ready `task_id` with nonempty Markdown sections Objective, Inputs, Scope, Acceptance, Verification, and Stop conditions. Its description joins the worker prompt. `model_profile` selects an approved `workerProfiles` route, otherwise optional automatic routing or `defaultWorkerProfile` applies; provider, model, reasoning effort and output cap are passed through native subagent options. With `requireTaskBrief`, only the Lead can complete a task and must supply nonempty verification evidence. `select_model_profile` changes the calling agent to an approved route at the next step after LLM configuration validation, without saving a global default; worker output caps do not change the caller’s output cap. These tools do not schedule assignments or verify evidence automatically.

<a id="automatic-routing-and-bounded-evidence"></a>
### Automatic routing and bounded evidence

`autoSelectSkills`, `autoRouteWorkers` and `inspectFiles` default to `false` in the plugin; the CodeCrew profile enables them. Settings → Coding exposes each switch. Local skill rules and explicit invocations take precedence. On an eligible unmatched assignment, Jev picks one permitted skill or none from a local lexical shortlist; the skill loader still enforces visibility and instruction budgets. This adds no selection call to mechanical lookups or exact UI edits. The full skill catalog remains available.

Unpinned substantial worker assignments can use Jev to choose an approved profile; explicit `model_profile` values are preserved. The configured default remains on uncertainty, missing credentials, exhausted budget or service failure. Task readiness and brief validation precede routing. Spawn results retain a compact routing receipt. Routing does not change the supervisor's selected chat model. Automatic skill choices, worker routing and explicit tool advice share `maxCallsPerTurn`; two is the default.

`coding_decide.files` accepts an explicit shortlist inside the current workspace, including canonical containment checks. Default limits allow eleven files within the combined 12 KB text budget; wrappers, questions, escaped text and unknown-size streams count. Credential paths and recognizable key material are refused. Reads use `ctx.fs` and preserve its permissions, reject changed versions and emit no `fs/observed`, so they cannot authorize editing. The main model receives answers plus source paths, versions and byte counts; file text goes to the configured decision provider. Use normal `read` before editing or quoting code, and grep for exact strings. The filters are not a general secret detector.

| Recipe | Advice |
|---|---|
| `rank_files` | Rank the supplied files for the goal in one request; no autonomous traversal |
| `review` | Seven risk questions; quick review only when every answer confidently indicates no risk, otherwise full review |
| `coverage` | Whether supplied tests cover supplied requirements, with an explicit unknown outcome |
| `rules` | Whether a proposed change conflicts with supplied rules; advisory, not an edit gate |
| `browser` | Visible progress and blockers; batch a custom choice over observed controls for a next action |
| `compaction` | Work-boundary, checkpoint completeness and in-flight-operation checks |

Recipes can include additional typed questions within `maxQuestions` (default eight). Review errors require full review. Browser advice executes no interaction; compaction advice does not prune history, override native automatic compaction or replace the workspace brief. Jev never grants permission, accepts a task or substitutes for tests and supervisor verification.

<a id="model-experience"></a>
## Model Experience

### Team policy and tools

#### What the model sees

One shared system policy covers Team availability, shared-cwd safety, task coordination, Steer delivery, inbox acceptance, and the Lead’s duty to wait. All ten schemas are identical for Leads and teammates; execution enforces Lead-only operations. Required runtime context states `You are the Team Lead named "lead".` or `You are teammate "<name>".` with `Your Team Lead is named "lead".`, plus roster and messaging instructions. Identity comes from current Team membership, survives optional-context suppression, and is restored when compaction removes its snapshot. An ordinary fork from a teammate receives its current Lead identity.

#### Token effect

Fixed policy and schema cost on every Team member request. Identity is part of the complete runtime-context snapshot. An unchanged retained snapshot adds no message; changed or removed context causes the loop to append a complete snapshot, including identity. Tool calls add compact JSON roster, task, wait, or receipt results. Peer content is retained by the Team domain in the target's history.

#### KV Cache effect

With the same provider/model, shared system policy, and tool schemas, a fork retains the parent request prefix and appends its task and current runtime context. Tool results and peer messages append after the reusable request prefix. Sessions recorded with identity inside the system prompt can change that prefix on their first request under this layout; actual provider cache hits remain best-effort.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what the policy and tools cannot guarantee for a team. They are current package constraints, not a comparison with other collaboration surfaces.

- **Prompt policy is coordination, not confinement** — it cannot stop Bash or external processes from writing overlapping files.
- **No Web controls** — browser roster and task-board presentation is outside this runtime package.
- **Experimental prototype with no stability promise** — the package is public, but its schemas can change freely while it incubates.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
