---
description: "面向模型的 skill（技能）目录与加载工具，供希望了解 agent（智能体）看到的内容或配置会话 skill 目录的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-skill

[English](README.md) | 中文

## 概述

agent 可以在会话期间发现并加载 skill。当 `skill` 工具可见时，只要存在模型可调用的 skill 或发现不完整，就会在首次请求前生成持久目录。工具加载完整指令；用户可以用 `/name` 调用用户可调用的 skill。条目、可见性和完整性变化会追加替换目录。发现不完整时会发布已确认的 skill 并附带警告，即使没有确认任何 skill。可配置 `catalogDescriptionMaxLength` 来限制描述长度。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

作用域内的 `skills/select-automatic` 瀑布事件可以调整或抑制本地规则选择；`next()` 返回匹配规则的结果，未命中时返回空列表。兜底选择器应保留非空结果。即使抑制自动工作流，显式 `/name` 调用和 `skill` 工具仍然可用。

-----

<a id="use-this-package"></a>
## 使用本包

技能发现、目录更新与显式技能调用均使用 Session 的当前工作目录。

与 skill 注册表一起挂载该插件，即可让 agent 拥有会话 skill 目录和 `skill` 加载工具。它需要 `ctx.agents`、`ctx.tools` 与 `ctx.skills`。

### 何时选择

当 agent 应在会话期间发现并加载 skill 时使用它。当 skill 加载由其他消费方处理或完全不需要时，请跳过——没有它，提供方与注册表仍可工作，但不会有任何东西为模型渲染目录或工具。

### 挂载与配置

与 skill 注册表和至少一个提供方一起加载该插件。唯一配置项限制目录中渲染的规范化描述长度。

```yaml
- name: '@deepseek-ai/dsh-skill'
- name: '@deepseek-ai/dsh-skill-filesystem'
- name: '@deepseek-ai/dsh-tool-skill'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `catalogDescriptionMaxLength` | `500` | 会话目录中渲染的规范化描述最大长度；最小为 3 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-skill)是每个受支持字段的穷尽式真源。

### 模型得到什么

- **会话目录。** 当 `skill` 工具可见，且存在模型可调用 skill 或发现不完整时，agent 会在首次请求前收到一条持久的用户角色消息，列出每个已确认 skill 的名称与有长度上限的描述；非空目录告诉模型在着手任务前先用工具加载 skill，且绝不能仅凭摘要推断指令。
- **加载工具。** 模型以精确的 skill 名称调用 `skill`，并收到完整指令正文以及规范的 `<skill_content>` 块中的资源指引；该结果作为普通工具历史保留。
- **用户显式调用。** 直接用户输入中的 `/name` token 若指名某个用户可调用 skill，会把该 skill 的指令注入该步骤，而无需模型自行加载。
- **实时目录更新。** 后续成员关系、描述、可见性或完整性变化会追加替换目录；删除全部 skill 时会追加空目录，停用较早的名称。

### 可观察的成功与失败

加载列出的 skill 会返回其完整指令；无论加载来自工具还是用户的显式调用，模型看到的都是同一种规范形态。无效名称会报告 `Error: invalid skill name "<name>"`，未知名称会报告该 skill 未知或已不可用，被禁用模型调用的 skill 会报告其不可用于模型调用。如果从未发布过目录，并且发现完整且不存在模型可调用 skill，或 `skill` 工具被隐藏或遮蔽，则会整体省略目录；目录发布后，无论可见性丧失——`skill` 工具被隐藏或被同名作用域工具遮蔽——还是删除全部 skill，都会改为追加空目录来停用旧名称。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释目录与调用边界如何构建；可观察行为已在[使用本包](#use-this-package)和下方模型体验章节中完整说明。

### 设计理念

本包建立在两个想法之上。第一，目录是一种持久投影，按已发布条目与完整性的 digest 而非渲染后的正文做差异比较，因此 `<system-reminder>` 包装永远不会强制重新发布，消费方也不需要重新解析 `<available_skills>` 块。第二，一条规范渲染服务两条加载路径——工具结果与用户显式注入——经由共享自 `dsh-skill` 的 `renderSkillContent`，因此无论加载由谁发起，模型看到的都是同一种 `<skill_content>` 形态。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：工具注册、目录与手势 pre-step 监听器、渲染与 digest |

### 目录生命周期

在每次符合条件的 `agent/pre-step`，插件都会快照调用会话的 skill 目录，应用 `skill` 工具的精确可见性，过滤出模型可调用的 skill，并把条目与完整性的 digest 同会话日志中最新可见的 `skill-catalog` 消息做比较。digest 变化时，它把包含替换目录的持久用户角色消息交给 `enter` 决策；空替换会显式停用较早的名称。快照不完整时仍会发布可读条目，并附带发现警告和持久化的 `incomplete: true` 来源元数据，即使已无可用条目。完整性也参与 digest，因此恢复后即使条目相同也会清除警告；不完整观测会重试而非缓存。可见性检查针对本插件所注册的精确工具定义，因此作用域内同名的遮蔽项会同时移除 schema 及其指引；该插件既可全局挂载，也可挂在单个 agent 的组合内。

### 调用边界

`/name` 手势监听器只扫描已认领的用户消息：若某个以空白为界、指名工作区目录中用户可调用 skill 的 token 出现，则把同一份 `<skill_content>` 渲染作为 `user` 角色的指令上下文注入，追加在该步骤所有其他注入之后。未知名称与用户不可调用的名称保持为普通行文。这是 `disable-model-invocation` skill 唯一的入口，目录与 `skill` 工具永不暴露这类 skill。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从目录背后的注册表词汇逐步进入精确工具 schema 与设计依据。

- [skill 子系统参考](../../../docs/subsystems/skills.zh.md)——目录背后的注册表与提供方词汇。
- [skill 包](../skill/README.zh.md)——注册表与共享的 `renderSkillContent` 渲染。
- [生成工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-skill)——模型接收的精确 `skill` schema。
- [用户显式 skill 调用 Agent Note](../../../.agents/notes/archived/feature/2026-08-08-user-explicit-skill-invocation.md)——`/name` 手势设计。

-----

## 编码策略

可选自动选择使用本地、不区分大小写的关键词规则，采用首个匹配规则，不发起分类模型请求。它处理新的用户输入或 agent 任务输入，并优先保留显式技能调用；仅在 `maxSkills` 和 `maxBytes` 范围内加入完整、可见且允许模型调用的技能。每个技能正文均以来源为 `skill-automatic` 的持久 `user/message` 记录。全局 `codingSettings.skills()` 优先于本地动态 `automatic` 策略；未匹配任务仍可手动加载技能。字节限制仅适用于自动加载，不限制显式工具结果。

本地规则未匹配时，可选的作用域内 `skills/select-automatic` waterfall 可提供候选名称。加载器仍检查当前定义、模型调用权限和完整正文预算。没有监听器时不自动选择。CodeCrew 在此边界提供可选的 Jev 后备选择；显式调用与本地规则仍然优先。 如果当前完整正文已作为自动指令保留，显式技能调用仅向模型返回简短提醒；正文变化或已被压缩移除时返回全文。结构化工具原始输出仍保留完整定义。

## 协调与路由

自动选择和候选列表仅将用户输入与 worker 已记录父级的消息视为任务分配。worker 或其他同级的报告不会替换当前任务，也不会触发新的分类器请求。

规则支持可选的忽略大小写正则 `pattern`；同时提供关键词时，两者都必须匹配。仅使用正则时设置 `keywords: []`。无效正则会阻止配置激活。最新保留的自动技能正文未变化时不会重复注入；变化、恢复旧版本或被压缩移除的正文会重新加载。有效且获准的选择触发作用域内串行事件 `skills/automatic-selected`，即使相同正文已经保留。

`catalogMaxSkills`（或全局 `skills.catalogMaxSkills`）默认为零，保留完整目录。1–50 发布确定性的本地任务候选列表，并提供 `skill_search({query?, offset?})` 分页发现全部获准技能。候选列表来源含 `shortlist: true`，与发现失败的 `incomplete` 不同。当前接收输入优先，其次使用保留的用户或分配输入，确保继续执行时的相关性。工具限制仍然有效；隐藏搜索时恢复完整获准目录。目录大小和描述限制在激活时读取，规则保持实时。候选列表减少前缀字节，不保证计费 token 节省。

<a id="model-experience"></a>
## 模型体验

### 会话目录

#### 模型看到什么

如果可见的正是这个 `skill` 工具，且存在模型可调用 skill 或发现不完整，agent 会在第一个请求之前收到下方目录模板，其中包含每个已排序 skill 的一条随数据而定的条目。该目录是一条持久的用户角色消息。后续成员关系、描述、可见性或完整性的变化会使用同一个 `<available_skills>` 信封追加替换；删除所有 skill 时，会追加一个空信封，并明确指示不得使用旧名称。模板的结尾一句是防止双重加载的规则：用户显式的手势边界（下文的 pre-step 监听器）会把同一份 `renderSkillContent` 输出（共享自 `@deepseek-ai/dsh-skill`）内联注入，目录则告诉模型遵循该块，而不是再经工具重新加载该 skill；替换目录模板的两个分支——包括清空后的目录——都携带同一条防双重加载规则。

##### 发现不完整提示

```markdown
Some skills could not be checked. Only confirmed skills are listed; a lower-priority definition of the same name may be selected when a preferred source is unavailable. Discovery will be retried on the next request.
```

##### 不完整的初始空目录

```markdown
No skills could be confirmed in this discovery attempt.
Wait for an updated catalog before calling the `skill` tool. Do not infer skill instructions from an empty catalog.
```

##### 不完整的空替换目录

```markdown
No skills could be confirmed in this discovery attempt. Do not use names from earlier skill catalogs.
```

##### Skill 目录模板

```markdown
<system-reminder>
A skill is a reusable set of task-specific instructions. The following skills are available in this session:

<available_skills>
- `<name>`: <normalized-and-capped-description>
</available_skills>

If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.
A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.
</system-reminder>
```

#### Token 影响

重复输入成本随 skill 数量和 `catalogDescriptionMaxLength` 增长；当发现完整且列表为空，或工具被隐藏或遮蔽时，不会发送初始目录 token。每次条目或完整性变化都会添加一条保留的替换消息；发现不完整时会附带警告。

#### KV Cache 影响

初始持久目录追加在现有可重用前缀之后。动态变更作为该目录之后的仅追加历史，因此较早的可重用 token 保持不变，每条新追加的目录和后续轮次都会形成新的后缀。新建或恢复的实例如果 digest 发生变化，可能会从新追加的目录位置起影响缓存重用。

### 工具 schema

#### 模型看到什么

模型会看到生成的 [`skill` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-skill)。

#### Token 影响

工具可见时，每次请求都有固定的 schema token 开销。

#### KV Cache 影响

工具定义和可见性不变时，前缀稳定。遮蔽、限制或插件生命周期变更可能从该 schema 起使重用失效。

### 工具结果

#### 模型看到什么

成功调用使用下方结果模板，以及提供方管理的资源指引、目录资源指引、URL 资源指引或不透明资源指引。

##### Skill 结果模板

```markdown
<skill_content name="<escaped-name>">
<skill_resources>
<resource-guidance>
</skill_resources>

<skill_instructions>
<provider-owned-instruction-body>
</skill_instructions>
</skill_content>
```

##### 提供方管理的资源指引

```markdown
Resources for this skill are managed by provider "<provider>".
Load referenced resources only as needed.
```

##### 目录资源指引

```markdown
Base directory for this skill: <path>
Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.
```

##### URL 资源指引

```markdown
Base URL for this skill: <url>
Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.
```

##### 不透明资源指引

```markdown
Resources for this skill: <description>
Load referenced resources only as needed.
```

#### Token 影响

已加载指令是取决于数据的工具结果 token，并在后续步骤中重新发送，直到压缩；不会制作重复的 `agent.inject()` 副本。

#### KV Cache 影响

仅追加；新可见内容位于可重用请求前缀之后，不会使现有 KV Cache 条目失效。

### 工具错误

#### 模型看到什么

无效或陈旧选择会精确返回 `Error: invalid skill name "<name>"`、`Error: skill "<name>" is unknown or no longer available` 或 `Error: skill "<name>" is not available for model invocation`。提供方抛出的查找文本取决于数据，并套用同一个 `Error: <message>` 包装层。

#### Token 影响

只有失败调用会添加这些已保留 token。

#### KV Cache 影响

仅追加；新可见内容位于可重用请求前缀之后，不会使现有 KV Cache 条目失效。

### 用户显式调用注入

#### 模型看到什么

已认领用户消息中任意位置、以空白为界、指名工作区目录中某个用户可调用 skill 的 `/name` token，会把该 skill 的完整 `<skill_content>` 渲染（与上文结果模板完全相同的形态）作为 `user` 角色的指令上下文注入，追加在该步骤所有其他注入之后——背景在前，模型要着手处理的材料在最后。只扫描直接的用户输入，检查在已加载定义上进行，未知名称和用户不可调用的名称保持为普通行文。这是 `disable-model-invocation` skill 唯一的入口，目录和 `skill` 工具永不暴露这类 skill；目录的结尾一句会告诉模型遵循注入块，而不是重新加载它。

#### Token 影响

每次手势会把一份渲染后的 skill 正文作为注入上下文加进该轮次——尺寸与同一 skill 的工具结果相同，该成本会随用户请求必然产生，而非由模型自行决定。同一步骤内对同一 skill 的重复手势只注入一次。

#### KV Cache 影响

仅追加；注入落在该步骤的消息批次中、可重用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明目录或加载器何时不合适。它们是当前包约束，不是任务积压。

- **目录省略 `whenToUse`、来源和提供方元数据**——路由只基于名称和有长度上限的描述；`whenToUse` 仍是提供方元数据，加载后的包装层也不渲染它。
- **已加载指令正文没有大小上限**——提供方可返回足以占用大量下一步上下文的 skill；只有目录描述会被截断。
- **资源是指引，而非附件**——工具报告基础目录/URL/不透明提示，但既不列举也不为模型获取引用文件。
- **加载是一次性文本**——远程提供方缓慢或 skill 正文很大时，不提供部分内容、流式输出或缓存内容句柄。
- **目录替换采用全量列表**——一个名称或描述发生变化，就会追加所有可见摘要；这样能显式停用陈旧名称，但 token 成本与目录大小成正比。
- **正文不做版本化**——仅修改正文不会改变目录 digest，也不会通知模型；后续工具调用会读取提供方的当前内容，而先前工具结果仍是历史事实。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
