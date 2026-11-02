# CodeCrew

English | [中文](README.zh.md)

This profile runs the source checkout with isolated settings and sessions in `.coding-home`. DeepSeek account and inference plugins are disabled. Credentials are stored in the ignored local home.

## Run

Use Node 24.9 or newer and the repository's declared pnpm version. Type checks use the local stable native TypeScript 7 checker; generators retain the older compiler API compatibility package.

```sh
pnpm install --frozen-lockfile
pnpm run build
node coding/setup.mjs
DSH_HOME="$PWD/.coding-home" node --import tsx/esm apps/cli/src/bin.ts coding --no-open --port 3088
```

Open the authenticated URL printed by the launcher and keep it private. Rebuild after source changes. Setup links this checkout's built packages and creates both coding and desktop profiles; rerunning it preserves existing settings. `coding/cordis.patch.yml` is the initial template; saved settings live in `.coding-home/profiles/<profile>/cordis.patch.yml`.

Run the desktop development app with:

```sh
DSH_HOME="$PWD/.coding-home" DSH_DESKTOP_USER_DATA_DIR="$PWD/.coding-home/electron-user-data" DSH_DESKTOP_OPEN_DEVTOOLS=0 pnpm run start:desktop
```

The launcher prepares the runtime and creates a local development app. On macOS it lives at `apps/desktop/.desktop-build/development/CodeCrew.app`; keep the source checkout available. Native coding profiles open the workspace directly and configure providers through Settings. No standalone installer is included.

## Configure

Settings → Coding controls the global default model, reader, implementer, planner and reviewer profiles, scoped team assignments, automatic skills, memory, and per-agent parallel tool calls. A model selected in an individual chat affects that chat only. Models appear from the existing provider catalog; a provider must have working authentication before its models can run.

The initial default and reader use Luna. Other roles initially use Sol and remain editable. The supervisor can call `select_model_profile` to move to an approved stronger profile for difficult reasoning and back to reader for routine work. This applies at the next step and does not change the global default. Worker profiles also carry output limits in the profile YAML. OpenRouter, Anthropic and xAI use the existing configured API-key references; universal subscription login is not added by this fork.

Small changes run directly. Substantial assignments use a ready shared task whose description contains nonempty Markdown sections `Objective`, `Inputs`, `Scope`, `Acceptance`, `Verification`, and `Stop conditions`. Independent assignments can run concurrently; overlapping writes require coordination. The supervisor alone completes coding tasks, with verification evidence. The task board includes a live dependency graph. This is supervised delegation, not a new autonomous scheduler or a guarantee of successful worker output.

Automatic skill rules match locally without a classifier request. The first matching rule loads at most one complete, visible, model-invocable skill within the configured byte budget. Unmatched work can still use the skill tool. Edit `coding-settings.skills.rules` in the saved profile for additional task vocabulary; exact copy, spacing and icon edits do not have a broad design rule.

General memory defaults to `$DSH_HOME/memory/USER.md`; workspace memory is read only from the current working directory's `.dsh/BRIEF.md`. Agents are instructed to maintain that brief with the goal, constraints, decisions, progress, checks and next actions. Retained snapshots are deduplicated, changed files refresh, and snapshots removed by compaction are restored before the next admitted step. Missing files are optional; oversized files are omitted whole. No background memory writer is added and compaction is not lossless.

Settings → Coding also has a separate Decision advisor model, initially `typesafe/jev-1.14` on the OpenRouter Decisions API. The supervisor can batch ambiguous model/skill selection, parallel-work choices, failure triage or retained-image questions through `coding_decide`. Exact edits skip it. Advice cannot change models, permissions or task acceptance by itself. The defaults allow two requests per turn, four questions per request, a 2.5-second deadline, 12 KB of text and 2 MiB of image bytes; confidence below 0.7 returns uncertainty. Limits and the key reference remain editable in the profile configuration. See the [team tool reference](../packages/experimental/tool-agent-team/README.md#coding-policy) for failure and logging behavior.

The coding profile enables anchored editing globally for newly created tools. Agents can use `edit_lines` for repeated code and substantial replacements, while literal editing remains available for small unique changes. See the [edit tool contract](../packages/fs/tool-fs/README.md#anchored-editing) and [Oh My Pi research](oh-my-pi-research.md) for evidence and tradeoffs.

## Verification and limits

Focused tests cover worker routing, brief validation, supervisor acceptance, model changes, memory isolation and restoration, automatic skills, and repeated compaction failures. The settings save/reload flow was exercised in a real browser at desktop and mobile widths. Native TypeScript 7 checks and the Web build passed. A live Luna copy-edit smoke completed read, edit and exact verification in approximately 7.7 seconds with no workers or extra workflow. One fixture does not establish overall latency, token savings, or model quality; compare real coding tasks before making those claims. The macOS development app has been launched and checked; no standalone installer or replacement of the original app is included.
