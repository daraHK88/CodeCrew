---
description: "十个让模型创建、发消息与协调 teammate 的工具，供挂载实验性 Team 插件的组合使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-agent-team

[English](README.md) | 中文

## 概述

本包让模型创建具名 teammate、向它们发送消息、查看可用状态、等待进展、中断卡住的工作，并通过共享任务板协调。每个团队成员都会获得相同的十个工具，以及在共享工作区协调的指引。它会取代同名的旧版 subagent 控件，因此同时需要两者的组合必须禁用旧定义。本包以实验性名称公开发布，但不提供稳定性保证。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

工作成员接收简短的执行规则、自己的任务和与任务相关的消息。成员请求不包含仅限 Lead 的工具或完整的协调器检查点；旧版控制工具也不能恢复 Lead 操作。整个界面的自动设计工作流由 Lead 执行。其他本地技能规则仍适用于成员，成员也可显式加载所需指导。项目指令、权限和修订检查仍然有效。创建、列出和更新任务的回执省略重复的描述和验证文本；`team_task_get` 返回完整的当前任务。

可选 `workerTools` 白名单限制成员继承的全局工具模式及执行；空列表保留部署默认值。角色拥有的 Team 与决策工具仍按作用域提供。编码覆盖配置开放文件编辑、搜索、技能查找、文档获取与任务结果收集，将调度、插件管理和进一步委派留给 Lead。

-----

<a id="use-this-package"></a>
## 使用本包

当模型应该通过工具运行一支团队时，在 `@deepseek-ai/dsh-experimental-agent-team` 之上挂载本包。挂载后，每个团队成员——Lead 与每个 teammate——都会获得相同的十个工具，以及相同的协作策略。`spawn_teammate` 发送初始任务，并可加入必需的任务描述；每个成员通过必需的 runtime context 接收当前角色和名字。

### 何时选择

当模型应该自行创建与协调 teammate、而不是由人来操作 subagent 控件时，选择它。当同名的旧全局 subagent 工具必须继续可用时，请不要选择：团队工具会为团队成员取代它们，因此想同时使用两者的组合必须禁用旧定义。

### 最小工作示例

对现有组合的最小增量是 [agent-team README](../agent-team/README.zh.md#smallest-working-setup) 中的两包片段：持久会话存储、团队领域包与本包。插件本身只有两个可选设置：

```yaml
- id: tool-agent-team
  name: '@deepseek-ai/dsh-experimental-tool-agent-team'
  config:
    freshProvider: spawn
    forkProvider: fork
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `freshProvider` | `spawn` | 启动 fresh teammate 的提供方 |
| `forkProvider` | `fork` | 启动 fork teammate 的提供方 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-tool-agent-team)是每个受支持字段及其 JSDoc 的穷尽式真源。

试试这样要求 Lead 模型：「创建一个名为 reviewer 的 teammate 检查 diff，再把变更摘要发给 reviewer」。模型会调用创建工具，然后调用消息工具。

### 模型能做什么

工具提供模型选择、委派、消息、任务管理和主管分派：

- **选择模型**——`select_model_profile` 为调用 agent 的下一步选择获准路由。
- **创建 teammate**——`spawn_teammate` 接收名字、描述与初始任务；只有 Lead 可以调用它。
- **发送消息**——`send_message` 在最近的步骤边界对运行中的成员进行 steering（中途引导）、启动或恢复非活动成员。
- **查看与等待**——`list_agents` 返回各成员的 `target` 与可用状态；`wait_agent` 等待下一次团队变化；`interrupt_agent` 停止 teammate 的当前轮次（仅限 Lead）。
- **分派与审查**——`team_dispatch` 按当前任务版本批量排队；`team_dispatch_status` 分页返回状态（指定 `task_id` 返回完整报告）；`team_task_report` 提交 worker 证据；`team_dispatch_cancel` 等待任务退出后释放归属。
- **管理任务板**——`team_task_create`、`team_task_list`、`team_task_get` 与 `team_task_update` 添加、浏览、读取与更新共享任务。

创建和列表结果使用 `target` 标识成员，不包含成员 Session ID。可将该值用于消息和中断调用，或任务工具的 `owner` 参数；任务的 `ownerName` 使用相同值。`inactive` 表示没有轮次在执行，包括已加载和需要恢复的成员；它不表示任务完成或结果。`provisioning` 与 `failed` 描述成员创建状态。任何成员都可以给任何其他成员发消息并使用任务板；只有 Lead 可以创建与中断 teammate。任务更新保留领域的 owner 与 revision 校验，因此过期的编辑会被拒绝，而不是覆盖更新的成果。

### 成功与失败的表现

`send_message` 在收件箱接收消息后返回 `{ "sent": true }`，不暴露消息 ID。成功不表示接收方已处理消息，也不保证同步刷新到存储；发送失败会作为工具错误报告。当没有其他成员 running 或 provisioning 时，`wait_agent` 会立即返回 `noProgress`，提示调用方先唤醒 teammate；否则它会等待下一次变化，调用方随后重新读取状态。基于过期 revision 的任务编辑会被拒绝，而不是覆盖更新的成果。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释适配器背后的设计决策并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

适配器建立在三项承诺之上：

- **按作用域，而非全局。** 每个注册都位于成员 Agent（智能体）自己的 `ctx` 上；安装依据 Agent 发布时可用的成员身份。
- **声明式结果，紧凑 JSON。** 每个工具都声明完整结果 schema，并把该值渲染为紧凑 JSON，因此编译器会对照向模型承诺的结果检查 `execute`，任何结果都不会在缩进上消耗 token。
- **领域掌握裁决权。** 工具委托给 `ctx.agentTeams`，后者强制执行 Lead 权限与 revision 校验；适配器不添加更弱的路径。

[Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md)负责模型侧与 scoping 决策。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置、固定策略文本与十个 scoped 工具注册 |

### 策略与工具

member scope 上的一个 `team:policy` 段落说明共享的协作规则；固定文本与十个工具注册都声明在 [`src/index.ts`](src/index.ts)。十个工具 schema 注册在发布时被识别为 Team member 的 scope 中。与旧全局 continuable-subagent 控件同名的 scoped 注册只会为团队成员覆盖这些全局控件。

### 按作用域注册与拆除

`maybeInstall` 对每个 live Agent 运行，并订阅 `agent/created`；它跳过没有 Team 成员关系的 Agent。Agent 的 dispose（资源释放）会运行已安装的 disposer，插件 HMR（热模块替换）会在重新安装前对每个已安装的 scope 执行 dispose。每个 disposer 按逆序撤销注册，因此失败的安装不会留下残缺 scope。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从领域服务逐步进入精确 schema 与设计背后的决策。

- [agent-team 包](../agent-team/README.zh.md)——这些工具背后的 `ctx.agentTeams` 领域服务。
- [Agent Teams 子系统](../../../docs/subsystems/agent-team.zh.md)——持久 Team 类型与服务 API。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-tool-agent-team)——模型接收的每个工具 schema。
- [Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md)——模型侧、scoping 与隔离决策。

-----

<a id="coding-policy"></a>

## 编码策略

`team_dispatch` 默认保留 Lead 模型。显式传入 `select_supervisor: true` 才会选择 `coding.supervisorProfile` 指定的获准路由；排队前验证，下一步生效，不改变全局聊天默认值。空值保留 Lead 模型。Worker 路由独立固定，不改变 Lead。未指定模型的 worker brief 按配置的问题数量上限合并请求，并共享既有字节、超时及每轮请求预算；显式模型跳过建议。常规任务保留确定性快速路径，不确定或失败的建议保留默认 worker 配置。

启用 `coding.decisions.enabled` 后，`coding_decide` 提供有界的 OpenRouter 决策建议，与聊天模型分离。它批量处理 Choice、Noul（是非概率）和 Score（有序量表）问题。低于阈值的答案保持不确定；无效或自相矛盾的响应返回脱敏错误码。置信度不超过由概率分布计算的值；Choice/Score 缺少置信度时不作选择，Noul 使用 `abs(2p-1)`。置信度是分布统计量，不是正确性证明。超时、完整文本字节上限和共享的每轮请求预算限制开销。不自动重试或执行工作流动作。仍支持显式选择保留的图像；拒绝远程图像 URL。不返回凭据或提供方错误正文。工具建议单独报告模型、用量和耗时，不混入聊天模型统计。

动态 `coding` 配置可要求 `spawn_teammate` 指定就绪的 `task_id`，且任务须包含非空 Markdown 节：Objective、Inputs、Scope、Acceptance、Verification 和 Stop conditions。任务描述加入 worker 提示词。`model_profile` 选择获准的 `workerProfiles` 路由，否则采用可选自动路由或 `defaultWorkerProfile`；提供方、模型、推理强度和输出上限通过原生 subagent 选项传入。启用 `requireTaskBrief` 时，仅 Lead 能完成任务，并须提供非空验证证据。`select_model_profile` 经 LLM 配置验证后，在下一步为调用 agent 选择获准路由，不保存全局默认值；worker 输出限制不改变调用者的输出限制。`team_dispatch` 提供持久的就绪任务调度；主管仍须独立验证证据。即使手动委派不要求 brief，分派也始终要求完整 brief。写入任务默认使用 worktree；明确只读的任务可共享 checkout，Scope 须以 `None` 开头。获准模型路由在排队时固定，全局设置变化不会暗中改写已授权任务。并发上限由 Team 服务配置。失败或取消后须先检查，再以新的 worker 名字重新授权。

<a id="automatic-routing-and-bounded-evidence"></a>
### 自动路由与有界证据

插件中的 `autoSelectSkills`、`autoRouteWorkers` 和 `inspectFiles` 默认为 `false`；CodeCrew profile 启用它们。Settings → Coding 提供各自的开关。本地技能规则和显式调用优先。对符合条件但未匹配规则的任务，Jev 从本地词法短名单中选择一个允许的技能或不选；技能加载器仍执行可见性与指令预算限制。机械查询和精确 UI 修改不增加选择请求。明确限定为样式修复的任务，即使较长的验证说明超过短任务长度限制，也会跳过建议模型；架构、迁移与安全工作仍保留实质任务路径。完整技能目录仍可用。

未指定模型的较大 worker 任务可让 Jev 选择获准配置；保留显式 `model_profile`。不确定、缺少凭据、预算耗尽或服务失败时保留配置的默认值。任务就绪与简报验证在路由前执行。派生结果保留简短路由记录。路由不改变主管选择的聊天模型。自动技能选择、worker 路由和显式工具建议共享 `maxCallsPerTurn`；默认值为二。

`coding_decide.files` 接受当前工作区内的显式文件短名单，并检查规范化路径包含关系。默认允许十一份文件，且完整文本预算不超过 12 KB；包装、问题、转义文本和大小未知的数据流均计入预算。拒绝凭据路径和可识别的密钥内容。读取通过 `ctx.fs` 执行，保留其权限，拒绝版本变化，且不发送 `fs/observed`，因此不能授权编辑。主模型只收到答案及源路径、版本、字节数；文件正文发送给配置的决策提供方。编辑或引用代码前使用普通 `read`，精确字符串查询使用 grep。这些过滤规则并非通用秘密检测器。

| 模板 | 建议 |
|---|---|
| `rank_files` | 一次请求按目标对所选文件排序；不自主遍历 |
| `review` | 七项风险问题；全部明确无风险才建议快速审查，否则完整审查 |
| `coverage` | 所给测试是否覆盖所给需求，明确提供未知结果 |
| `rules` | 拟议变更是否违背所给规则；仅提供建议，不作为编辑门禁 |
| `browser` | 可见进展与阻碍；可批量添加针对已观察控件的自定义下一步选择 |
| `compaction` | 工作边界、检查点完整性与进行中操作检查 |

模板可在 `maxQuestions`（默认八）内附加自定义类型问题。审查出错时需要完整审查。浏览器建议不执行交互；压缩建议不删减历史、不覆盖原生自动压缩，也不替代工作区摘要。Jev 不授予权限、不验收任务，也不替代测试和主管验证。

## 协调与路由

`team_checkpoint` 使用当前检查点修订号保存 Lead 的目标、约束和后续行动。`team_dispatch` 可同时携带初始 `goal`、`constraints` 和 `next_actions`，无需额外调用；要求完整任务简报时，首批分配必须包含目标。`team_dispatch_status` 返回检查点。必需的运行时上下文在压缩后恢复此有界检查点，并要求模型读取最新任务修订、服从最新用户请求。

自动选择 `design-distinctive-frontends` 或 `impeccable` 后，可通过 `coding.uiProfile` 选择已批准的 Lead 路由。验证后于下一模型步骤生效，无需分类器调用。空值保留当前路由；worker 继续使用各自分配的模型。CodeCrew 的本地规则面向实质性 UI 工作，精确小改保持直接执行。拥有后台检查的分配保持 `waiting` 并占用槽位；提交 ready 前须收集真实结果。

<a id="model-experience"></a>
## 模型体验

### Team 策略与工具

#### 模型看到什么

共享系统 policy 覆盖 Team 可用性、共享 cwd 安全、任务协调、Steer 投递、inbox 接收和 Lead 等待责任。Lead 与 teammate 使用相同的十个 schema；执行时落实 Lead-only 操作。必需的 runtime context 声明 `You are the Team Lead named "lead".`，或 `You are teammate "<name>".` 与 `Your Team Lead is named "lead".`，并提供 roster 和消息操作说明。身份来自当前 Team membership，关闭可选 context 时仍保留，压缩移除快照后会恢复。从 teammate 创建的普通 fork 会收到当前 Lead 身份。

#### Token 影响

每次 Team member 请求都有固定策略与 schema 成本。身份是完整 runtime-context 快照的一部分。保留的快照未变化时不追加消息；context 变化或被移除时，loop 追加包含身份的完整快照。工具调用会增加紧凑 JSON roster、task、wait 或 receipt 结果。Peer 内容由 Team 领域保留在 target 历史中。

#### KV Cache 影响

provider／model、共享 system 策略和工具 schema 相同时，fork 保留父请求前缀并追加任务与当前 runtime context。工具结果与 peer 消息追加在可复用请求前缀之后。原先在 system prompt 中记录身份的 Session，首次使用此布局请求时可能改变该前缀；提供方实际缓存命中仍为尽力而为。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明策略与工具无法为一支团队保证什么。它们是当前包约束，不是与其他协作方式的对比。

- **提示词策略只负责协调，不负责 confinement**——它无法阻止 Bash 或外部进程写入重叠文件。
- **没有 Web 控制功能**——浏览器 roster 与任务板呈现不属于该运行时包。
- **实验原型，无稳定性承诺**——本包公开发布，但孵化期间 schema 仍可自由变更。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
