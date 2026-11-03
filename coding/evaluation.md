# Coding evaluation

English | [中文](evaluation.zh.md)

This local evaluation used the actual CodeCrew desktop Host and configured model accounts, with isolated, dependency-free JavaScript fixture repositories. It checks the dispatch implementation inspired by [Super-agent](https://github.com/deepseek-ai/dsh-superagent-prototype), not DeepSeek's prototype or its benchmark results.

## Tasks and results

The small task corrected second padding in a duration formatter while preserving unbounded minutes. Luna completed it in 13.76 seconds with five tool calls, no workers and no tool errors. The existing test and ten independent boundary assertions passed.

The larger task implemented a validated JSON job parser, an ordered concurrency mapper and their runner integration. Worktree workers committed independent modules; the supervisor reviewed and integrated them, added tests and accepted the tasks with recorded evidence. Worker execution intervals overlapped in both runs.

| Observation | Initial run | Final run |
| --- | ---: | ---: |
| Elapsed time | 196.44 seconds | 122.05 seconds |
| Supervisor tool calls | 64 | 32 |
| Supervisor tool errors | 6 | 0 |
| Agent-authored repository tests passed | 10 | 20 |
| Independent additional tests passed | 15 | 15 |
| All-agent reported total tokens | 2,019,020 | 1,218,024 |
| All-agent cache-read tokens | 1,898,368 | 1,075,072 |
| All-agent reported uncached input tokens | 109,529 | 135,336 |
| All-agent output tokens | 11,123 | 7,616 |

Initially Luna supervised two Sol workers. The final configuration switched the Lead to its approved planner profile, Astra, on dispatch; the parser worker used Sol and the mapper used Luna. The Lead returned to Luna after integration. The global default stayed Luna. The first launch also exposed a missing worktree-service mount, which was corrected before the measured completed runs. Current task revisions were added to dispatch status to avoid unnecessary acceptance retries.

## Code quality and limits

Independent checks cover malformed configuration, duplicate and untrimmed IDs, non-finite values, mapper argument validation, immutable input, ordered output, bounded parallel calls, stopping admission on first failure, draining started calls, preserving falsy rejection reasons and runner validation before handler execution. All passed against the final generated code. Source review found small modules using existing project conventions and no new dependencies; the concurrency mapper uses an explicit failure flag so a falsy rejection is not mistaken for success.

This is one task pair with different model routes and uncontrolled model and cache variation. Reported total tokens include cached input and do not establish lower billing: uncached input increased and model prices differ. These results demonstrate working routing and passing targeted checks, not a general speedup, production readiness or consistently senior-level output. Actual repositories still need their own tests, type checks, integration review and relevant UI verification. Worker reports remain claims for the supervisor to verify.

## Coordinator continuation rerun

On November 3, the same dependency-free coding fixtures were run through the native app after adding goal checkpoints, complete-batch concurrent startup, background-job continuation and compact skill discovery. An exact UI copy edit completed on Luna in 7.38 seconds with four tool calls, no workers, no automatic skills and no tool errors. Independent comparison confirmed that only the requested button text changed. The formatter rerun completed in 14.07 seconds with eight tool calls and passed its original test plus ten independent assertions.

The first coordinator job-runner run took 142.54 seconds, 44 Lead tool calls and four tool errors; all 15 repository and 15 held-out tests passed. It exposed assignment-format repair overhead. The final rerun below used clearer Markdown-section tool guidance and stopped treating worker reports as new skill assignments. The two runs remain separate observations, rather than discarded attempts.

| Observation | Previous published run | Final coordinator rerun |
| --- | ---: | ---: |
| Elapsed time | 122.05 seconds | 140.20 seconds |
| Lead tool calls | 32 | 31 |
| Lead tool errors | 0 | 2 |
| Repository tests passed | 20 | 15 |
| Independent additional tests passed | 15 | 15 |
| All-agent reported total tokens | 1,218,024 | 837,812 |
| All-agent cache-read tokens | 1,075,072 | 725,376 |
| All-agent reported uncached input tokens | 135,336 | 104,764 |
| All-agent output tokens | 7,616 | 7,672 |

The final errors were a task-name lookup and an omitted initial goal; neither started an unauthorized assignment. Sol parser and Luna mapper worker execution overlapped in separate worktrees. Astra supervised integration and acceptance. Independent tests again covered invalid configuration, ordering, bounded concurrency, draining and falsy failures. The resulting modules remained small and dependency-free. The final run reduced reported token counts but took longer than the previous published run; model/cache variation and differing generated tests prevent a general speed or billing claim. The formatter and first coordinator run overlapped the end of the separate UI evaluation; the final coordinator run and exact copy edit were launched together.

## UI quality evaluation

A fresh plain HTML/CSS/JavaScript fixture supplied eight demo tasks and the local CodeCrew mark. Both versions received the same dashboard brief: derived counts, search, status filters, priority sorting, empty results, a keyboard-accessible task detail panel, no dependencies or network assets, and 390px/1440px layouts. No evaluator edited either generated implementation.

The baseline requested unnecessary design confirmation and stalled. After an explicit continuation, it completed in another 287.00 seconds; total elapsed time was 837.31 seconds including the confirmation wait. Independent browser inspection reproduced a document width of 701px at the requested mobile viewport. Its own closing message disclosed unresolved overflow and contrast concerns.

The updated UI route selected the design skill locally and used Sol for the build, Astra after delegation, and a Sol behavior worker. It completed without confirmation in 472.54 seconds. It encountered a GUI-browser launch failure, then verified with separate headless Chromium. During verification it repaired a dialog Tab-focus defect and text contrast. Independent browser checks passed search and empty results, blocked filtering, ascending priority ordering, task opening, labelled close, Escape, focus return and single-control dialog Tab containment. At 390px the document width was 375px with no offscreen visible controls; at 1440px it was 1425px. A bounded computed-style check found no visible solid-color text contrast warnings in the final desktop overview; this is not a complete accessibility audit.

| Observation | Baseline | Updated UI run |
| --- | ---: | ---: |
| Lead tool calls | 75 | 51 |
| Lead tool-result errors | 11 | 1 |
| Initial skill catalog entries | 109 | 4 |
| Initial catalog UTF-8 bytes | 13,589 | 973 |
| All-agent reported total tokens | 4,530,179 | 1,865,362 |
| All-agent cache-read tokens | 4,397,952 | 1,655,296 |
| All-agent reported uncached input tokens | 101,919 | 180,570 |
| All-agent output tokens | 30,308 | 29,496 |

Subprocess verification failures are separate from tool-result errors. The updated UI run produced a functionally better responsive result and fewer tool-result errors, but was slower than the baseline's post-confirmation execution and consumed more uncached input with more capable models. Lower cached-inclusive totals do not prove lower cost. Worker feedback also triggered an unrelated automatic review skill in this run; the final source now admits only user or recorded-parent assignments for skill routing, with regression coverage. This boundary fix was exercised by the final coding rerun, not a repeated full dashboard run.

Separately, the real skill plugin on the same 109-entry synthetic catalog produced 13,589 bytes in full mode versus 1,004 in four-entry mode, a 92.6% reduction in that block. This excludes the optional search-tool schema and measures bytes, not provider tokenization, latency or billing.

## Parallel execution regression checks

The dispatcher preserves the Lead model unless `select_supervisor` explicitly requests a phase change. Fresh worker sessions retain independent model routes and do not copy the supervisor conversation. A barrier-based test keeps one supervisor and three specialist model requests in flight simultaneously. Another test proves that a stopped blocked CSS assignment releases execution capacity for unrelated JavaScript while continuing to block conflicting CSS writes. Both the implicit Lead switch and stopped-worker capacity cases failed against the prior behavior before their fixes. Three unpinned assignments now share one decision-advisor request within the existing request budget.

These are deterministic runtime tests with a mock model adapter, not measured live-model speedups or cost savings. The affected tests run with `bun run vitest run packages/experimental/agent-team/tests/team.spec.ts packages/experimental/tool-agent-team/tests/tool-team.spec.ts`. Real dashboard timing still needs a controlled rerun with the same starting files, brief and quality checks; prior session measurements above remain historical evidence.
