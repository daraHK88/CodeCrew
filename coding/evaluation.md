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
