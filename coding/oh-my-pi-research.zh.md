# Oh My Pi 编辑调研

[English](oh-my-pi-research.md) | 中文

## 证据

作者的[编辑格式实验](https://stencil.so/blog/the-harness-problem)固定模型，只改变工具：180 个合成错误修复任务运行三次，每次使用新会话。锚点编辑在多数受测模型上优于补丁，但也存在退步。这是编辑可靠性的证据，并非普遍的编码质量或速度保证。

当前 Oh My Pi [编辑文档](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/edit.md)使用快照标签和行寻址；其[模式解析器](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/utils/edit-mode.ts)保留按模型选择的替换默认值。早期实验与当前协议不同。原生工具、LSP 支持和并行 agent 是独立功能；此实验没有单独测量它们的效果。

## CodeCrew 实现

CodeCrew 在现有文件系统提供方上独立实现可选的 `edit_lines`。它添加绑定版本的行引用、原子批次和更新后的锚点，并保留沙箱检查、观察授权和提供方比较交换。不引入 Oh My Pi 源码、依赖、额外模型或自动全项目检查。协议与限制由[工具参考](../packages/fs/tool-fs/README.zh.md#anchored-editing)维护。编码 profile 为新工具作用域全局启用此功能；局部显式设置 `false` 则保留普通读取和原有工具。

## 可复现诊断

仓库构建后运行 `node packages/fs/tool-fs/tests/edit-lines.perf.ts`。2026-11-02 的运行中，三个编辑器在三个固定合成场景里均生成完全符合预期的文件。这些数据是 UTF-8 字节数，而非分词器测量、模型评分或耗时。读取路径规范化为 `/workspace`；编辑结果包含临时测试路径。不包括 schema、提示词、模型推理、失败与后续读取。

| 场景 | 编辑器 | 编辑调用数 | 编辑参数字节 | 读取文本字节 | 编辑结果字节 |
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

40 行替换的编辑参数从 2,172 降到 1,142 字节（47.4%）。本例的锚点增加 640 个读取字节。微小唯一修改适合字面量编辑；八处小型离散修改按请求大小比较适合现有补丁工具。简短预览仅在返回区域内支持无需重读的后续编辑。这些结果支持按需选择工具，不能证明普遍节省 token 或提高基准评分。针对性回归测试覆盖过期与竞争编辑、重复内容、批处理、权限和大小限制；同模型编码质量仍需受控任务集评估。

原生桌面冒烟测试使用 `openai-codex` / `gpt-6-luna`，完成 `read → edit_lines → edit_lines → read`，两次编辑之间没有重读，最终文件精确校验通过。这是明确引导的工具集成检查，而非自主编码质量基准。
