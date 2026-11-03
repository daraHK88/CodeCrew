# CodeCrew

[English](README.md) | 中文

此 profile 从源码目录运行，将设置和会话隔离保存在 `.coding-home`。它禁用 DeepSeek 账号和推理插件。凭据保存在已忽略的本地 home 中。

## 运行

使用最新稳定版 Bun 及 Node 24.9 或更新版本。Bun 管理安装与脚本，应用保留 Node/Electron 以兼容原生扩展。类型检查使用本地稳定版原生 TypeScript 7；工具生成器保留旧编译器 API 兼容包。

```sh
bun install --frozen-lockfile
bun run build
node coding/setup.mjs
DSH_HOME="$PWD/.coding-home" node --import tsx/esm apps/cli/src/bin.ts coding --no-open --port 3088
```

打开启动器打印的认证网址，并对该网址保密。源码变化后须重新构建。设置脚本链接当前目录的构建包，为 coding 和 desktop 创建 profile；重复运行会保留已有配置。`coding/cordis.patch.yml` 是初始模板；保存的设置位于 `.coding-home/profiles/<profile>/cordis.patch.yml`。

运行桌面开发应用：

```sh
DSH_HOME="$PWD/.coding-home" DSH_DESKTOP_USER_DATA_DIR="$PWD/.coding-home/electron-user-data" DSH_DESKTOP_OPEN_DEVTOOLS=0 bun run start:desktop
```

启动器准备运行时并创建本地开发应用。macOS 应用位于 `apps/desktop/.desktop-build/development/CodeCrew.app`，须保留源码目录。原生编码 profile 直接打开工作区，通过 Settings 配置提供方。不提供独立安装器。

## 配置

Lead 在实质性 UI 工作前读取简短的 [UI 验收清单](UI-CRITERIA.md)，并根据集成结果验证适用标准。[完整偏好](UI-PREFERENCES.md) 涵盖相关技术栈、字体、落地页和动画选择。Setup 在全局指令旁创建这两个文件，并将工作流链接解析为绝对路径。Worker 只接收相关验收检查和参考路径，不重复项目探索或整个设计工作流。重复运行 setup 会保留已有指令和偏好，因此后续工作流更新需明确合并。当前请求和既有项目要求优先。

该配置还提供带许可证的本地 Phosphor sprite 和[可复用的本地浏览器检查](check-ui.mjs)。检查器使用仓库固定的 Playwright 运行时和已安装的 Chrome，采用隔离配置并等待清理完成；不会下载浏览器。这些 UI 标准适用时，使用 `--hide-scrollbars --contrast`；要求的布局或有界纯色文本检查失败时返回非零退出码。对比度阈值采用 [WCAG 2.2 最低对比度](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)。截图和有界报告不能替代任务相关的交互、无障碍或设计检查。

Settings → Coding 提供可选的主管阶段 profile。分派默认保留 Lead 模型，仅在显式传入 `select_supervisor: true` 时选择该配置。每个 worker 使用独立分配的模型和新的限定上下文。主管在同一阶段保持模型稳定，不要为状态检查或最终回复把整个历史切换到 reader。

Settings → Coding 控制全局默认模型、reader、implementer、planner、reviewer 配置、任务范围要求、自动技能、记忆和每个 agent 的并行工具调用数。聊天内选择的模型仅对该聊天生效。模型来自现有提供方目录，执行前须有可用认证。

初始默认模型和 reader 使用 Luna，其他角色使用 Sol，均可修改。主管可调用 `select_model_profile` 在需要复杂推理时切换至获准的更强配置，并在该阶段保持稳定；独立常规工作可交给新的 reader。切换从下一步生效，不改变全局默认值。Worker 输出限制也可在 profile YAML 中配置。OpenRouter、Anthropic 和 xAI 使用现有 API key 引用；本 fork 未添加通用订阅登录。

小改动直接执行。复杂任务使用就绪的共享任务，描述须包含非空 Markdown 节 `Objective`、`Inputs`、`Scope`、`Acceptance`、`Verification` 和 `Stop conditions`。独立任务可并行执行，重叠文件写入须协调。只有主管可凭验证证据完成编码任务。面板显示实时依赖图。复杂任务可通过 `team_dispatch` 持久排队授权分派，在并发限额内启动就绪 worker，并在待审查或失败时唤醒主管。写入任务默认使用保留的 worktree；主管须先整合和验证提交再验收依赖。小改动仍直接执行，不保证代码质量。

自动技能通过本地规则匹配，无需分类模型请求。首个匹配规则最多加载一个完整、可见且允许模型调用的技能，并受字节预算约束。未匹配任务仍可使用技能工具。在保存的 profile 中编辑 `coding-settings.skills.rules` 可增加任务词汇；精确文案、间距和图标修改没有宽泛设计规则。

通用记忆默认读取 `$DSH_HOME/memory/USER.md`；工作区记忆只读取当前工作目录的 `.dsh/BRIEF.md`。Agent 指令要求在摘要中维护目标、约束、决策、进度、验证和下一步。保留的快照去重，文件变化后刷新；快照被压缩移除时，在下一获准步骤前恢复。缺失文件可忽略，超大文件整体省略。未添加后台记忆写入器，压缩也不是无损的。

Settings → Coding 还提供独立 Decision advisor 模型，初始为 OpenRouter Decisions API 上的 `typesafe/jev-1.14`。主管可通过 `coding_decide` 批量处理有歧义的模型或技能选择、并行工作安排、失败分类或保留图像问题。精确修改跳过此步骤。建议本身不能更改模型、权限或任务验收。默认每轮最多两次请求，每次八个问题，超时 2.5 秒，文本上限 12 KB、图像字节上限 2 MiB；置信度低于 0.7 时返回不确定结果。上限和密钥引用可在 profile 配置中修改。失败和日志行为见[团队工具参考](../packages/experimental/tool-agent-team/README.zh.md#coding-policy)。

Jev 还提供可选的自动技能后备选择、未指定模型的 worker 路由和有界文件判断。三个全局开关位于 Settings → Coding，此 profile 默认启用。内置模板支持文件排序、审查深度、需求与测试检查、项目规则、浏览器进展和检查点就绪判断。本地快速路径优先，所有决策共享每轮预算。来源、验证和限制见 [Jev 集成调研](jev-research.md)。

编码 profile 为新创建的工具全局启用锚点编辑。agent 可用 `edit_lines` 处理重复代码和较大替换，小型唯一修改仍可使用字面量编辑。证据和权衡见[编辑工具约定](../packages/fs/tool-fs/README.zh.md#anchored-editing)和 [Oh My Pi 调研](oh-my-pi-research.md)。

## 会话速度诊断

离线运行[会话分析器](profile-session.mjs)，分析指定的当前 v4 记录，也可比较上一次会话：

```sh
node coding/profile-session.mjs --session session-id --compare previous-session-id --home .coding-home --out .artifacts/session-profile
```

将示例 ID 替换为目标会话。生成的 `report.html` 展示每步模型与工具耗时、worker 重叠、排队与启动时间、后台任务生命周期及 token/缓存计数；`profile.json` 保存相同测量。读取范围仅限所选会话及其记录的子会话；无法读取子会话时，会标明总计不完整。读取器选择最新记录版本，拒绝不支持的格式，排除 fork 继承历史并保留普通重启历史。

活跃时间不含轮次间隔，墙钟时间保留间隔。并行工具按时间区间并集计时，worker 与后台任务另列重叠时间线。首个数据块前的时间包含本地请求准备、网络及提供方延迟；流式时间来自已接收的数据块，现有日志无法进一步拆分。分类仅表示动作意图，是否有用需结合需求与实际结果判断。报告保留文件基本名和模型名，不导出原始提示词、推理文本、shell 命令或工具与源码正文。分析器离线运行，不增加模型调用。验证命令为 `node --test coding/profile-session.test.mjs`。

## 验证和限制

专项测试覆盖 worker 路由、任务描述校验、主管验收、模型切换、记忆隔离和恢复、自动技能以及重复压缩失败。设置保存和刷新流程已在真实浏览器的桌面与手机宽度下验证。原生 TypeScript 7 检查和 Web 构建通过。一次真实 Luna 文案编辑测试完成了读取、修改和验证，但单一样例不能证明整体延迟、token 节省或模型质量；需通过真实编码任务比较后才能作出这些结论。macOS 开发应用已启动并检查；未提供独立安装器，也未替换原应用。

## 协调与路由

此配置使用四项本地技能候选列表、完整分页发现、自动正文去重和确定性的实质性 UI 规则。Settings → Coding 可独立选择 UI 设计与构建配置，初始角色为 implementer。小型读取和精确编辑保持低成本直接路由。完整 UI 简报授权常规可逆设计选择，无需确认仪式。

监督者通过 `team_checkpoint` 或首次分配保存目标。就绪且独立的分配同时启动；后台任务让 worker 保持 `waiting`，完成后继续。任务与检查点跨中断和历史压缩保留；重启后不确定的分配须先检查。工作树集成与最终验收由监督者控制。测量结果和剩余限制见[评估](evaluation.md)。

编码覆盖配置允许十二个并发任务、十六个活跃 subagent，成员生命周期上限为 128。这些资源界限允许十个独立专员加主管，并不要求每次组建同等规模团队。工作包使用分层主管与各 worker 的专门技能。源码客户端重建监听已禁用；重建前退出，再完整启动 App 和 Host，以使用一致的产物。决策建议每 turn 最多四次。
