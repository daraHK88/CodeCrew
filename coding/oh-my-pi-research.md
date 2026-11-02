# Oh My Pi editing research

English | [中文](oh-my-pi-research.zh.md)

## Evidence

The author's [edit-format experiment](https://stencil.so/blog/the-harness-problem) changes tools while holding models fixed: three runs of 180 synthetic bug-fix tasks, with fresh sessions. Anchored edits outperform patches for most tested models, with regressions too. This is evidence about editing reliability, not a universal coding-quality or speed guarantee.

Current Oh My Pi [edit documentation](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/edit.md) uses snapshot tags and line addressing; its [mode resolver](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/utils/edit-mode.ts) retains model-specific replacement defaults. The older experiment and current protocol differ. Its native tools, LSP support and parallel agents are separate features; this experiment does not isolate their effects.

## CodeCrew implementation

CodeCrew independently implements optional `edit_lines` over its existing filesystem provider. It adds version-bound line references, atomic batches and refreshed anchors while retaining sandbox checks, observation authorization and provider compare-and-swap. No Oh My Pi source, dependency, extra model or automatic full-project check is added. The [tool reference](../packages/fs/tool-fs/README.md#anchored-editing) owns the protocol and limits. The coding profile enables it globally for new tool scopes; explicit local `false` keeps plain reads and the original tools.

## Reproducible diagnostic

After the repository build, run `node packages/fs/tool-fs/tests/edit-lines.perf.ts`. On 2026-11-02, all three editors produced the exact expected file in all three fixed synthetic scenarios. These are UTF-8 byte counts, not tokenizer measurements, model scores or wall-clock timings. Read paths are normalized to `/workspace`; edit results include their temporary fixture paths. Schemas, prompts, model reasoning, failures and follow-up reads are excluded.

| Scenario | Editor | Edit calls | Edit argument bytes | Read text bytes | Edit result bytes |
|---|---|---|---|---|---|
| tiny-unique-change | literal | 1 | 105 | 2494 | 160 |
| tiny-unique-change | patch | 1 | 128 | 2494 | 153 |
| tiny-unique-change | anchored | 1 | 108 | 3134 | 197 |
| forty-line-replacement | literal | 1 | 2172 | 2494 | 160 |
| forty-line-replacement | patch | 1 | 2273 | 2494 | 153 |
| forty-line-replacement | anchored | 1 | 1142 | 3134 | 463 |
| eight-disjoint-edits | literal | 8 | 852 | 2494 | 1280 |
| eight-disjoint-edits | patch | 1 | 539 | 2494 | 153 |
| eight-disjoint-edits | anchored | 1 | 617 | 3134 | 196 |

The 40-line replacement reduces edit arguments from 2,172 to 1,142 bytes (47.4%). Anchors add 640 read bytes in this fixture. Tiny unique changes favor literal editing; eight small disjoint changes favor the existing patch tool by request size. A short preview supports subsequent edits without a reread only inside its returned region. These results justify tool choice, not a claim of general token savings or a benchmark-score improvement. Focused regression tests cover stale/racing edits, duplicates, batching, permissions and size limits; same-model coding quality still requires a controlled task-suite evaluation.

The native desktop smoke used `openai-codex` / `gpt-6-luna` and completed `read → edit_lines → edit_lines → read`, with no reread between edits and exact final-file verification. This was an explicitly guided tool-integration check, not an autonomous quality benchmark.
