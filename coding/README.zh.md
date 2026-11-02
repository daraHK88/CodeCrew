# CodeCrew

[English](README.md) | 中文

此 profile 从源码目录运行，将设置和会话隔离保存在 `.coding-home`。它禁用 DeepSeek 账号和推理插件。凭据保存在已忽略的本地 home 中。

## 运行

使用 Node 24.9 或更新版本及项目声明的 pnpm。类型检查使用本地稳定版原生 TypeScript 7；工具生成器保留旧编译器 API 兼容包。

```sh
pnpm install --frozen-lockfile
pnpm run build
node coding/setup.mjs
DSH_HOME="$PWD/.coding-home" node --import tsx/esm apps/cli/src/bin.ts coding --no-open --port 3088
```

打开启动器打印的认证网址，并对该网址保密。源码变化后须重新构建。设置脚本链接当前目录的构建包，为 coding 和 desktop 创建 profile；重复运行会保留已有配置。`coding/cordis.patch.yml` 是初始模板；保存的设置位于 `.coding-home/profiles/<profile>/cordis.patch.yml`。

运行桌面开发应用：

```sh
DSH_HOME="$PWD/.coding-home" DSH_DESKTOP_USER_DATA_DIR="$PWD/.coding-home/electron-user-data" DSH_DESKTOP_OPEN_DEVTOOLS=0 pnpm run start:desktop
```

启动器准备运行时并创建本地开发应用。macOS 应用位于 `apps/desktop/.desktop-build/development/CodeCrew.app`，须保留源码目录。原生编码 profile 直接打开工作区，通过 Settings 配置提供方。不提供独立安装器。

## 配置

Settings → Coding 控制全局默认模型、reader、implementer、planner、reviewer 配置、任务范围要求、自动技能、记忆和每个 agent 的并行工具调用数。聊天内选择的模型仅对该聊天生效。模型来自现有提供方目录，执行前须有可用认证。

初始默认模型和 reader 使用 Luna，其他角色使用 Sol，均可修改。主管可调用 `select_model_profile` 在需要复杂推理时切换至获准的更强配置，再返回 reader 执行常规工作。切换从下一步生效，不改变全局默认值。Worker 输出限制也可在 profile YAML 中配置。OpenRouter、Anthropic 和 xAI 使用现有 API key 引用；本 fork 未添加通用订阅登录。

小改动直接执行。复杂任务使用就绪的共享任务，描述须包含非空 Markdown 节 `Objective`、`Inputs`、`Scope`、`Acceptance`、`Verification` 和 `Stop conditions`。独立任务可并行执行，重叠文件写入须协调。只有主管可凭验证证据完成编码任务。面板显示实时依赖图。此功能属于主管协调委派，不是新的自动调度器，也不保证 worker 输出成功。

自动技能通过本地规则匹配，无需分类模型请求。首个匹配规则最多加载一个完整、可见且允许模型调用的技能，并受字节预算约束。未匹配任务仍可使用技能工具。在保存的 profile 中编辑 `coding-settings.skills.rules` 可增加任务词汇；精确文案、间距和图标修改没有宽泛设计规则。

通用记忆默认读取 `$DSH_HOME/memory/USER.md`；工作区记忆只读取当前工作目录的 `.dsh/BRIEF.md`。Agent 指令要求在摘要中维护目标、约束、决策、进度、验证和下一步。保留的快照去重，文件变化后刷新；快照被压缩移除时，在下一获准步骤前恢复。缺失文件可忽略，超大文件整体省略。未添加后台记忆写入器，压缩也不是无损的。

Settings → Coding 还提供独立 Decision advisor 模型，初始为 OpenRouter Decisions API 上的 `typesafe/jev-1.14`。主管可通过 `coding_decide` 批量处理有歧义的模型或技能选择、并行工作安排、失败分类或保留图像问题。精确修改跳过此步骤。建议本身不能更改模型、权限或任务验收。默认每轮最多两次请求，每次四个问题，超时 2.5 秒，文本上限 12 KB、图像字节上限 2 MiB；置信度低于 0.7 时返回不确定结果。上限和密钥引用可在 profile 配置中修改。失败和日志行为见[团队工具参考](../packages/experimental/tool-agent-team/README.zh.md#coding-policy)。

编码 profile 为新创建的工具全局启用锚点编辑。agent 可用 `edit_lines` 处理重复代码和较大替换，小型唯一修改仍可使用字面量编辑。证据和权衡见[编辑工具约定](../packages/fs/tool-fs/README.zh.md#anchored-editing)和 [Oh My Pi 调研](oh-my-pi-research.md)。

## 验证和限制

专项测试覆盖 worker 路由、任务描述校验、主管验收、模型切换、记忆隔离和恢复、自动技能以及重复压缩失败。设置保存和刷新流程已在真实浏览器的桌面与手机宽度下验证。原生 TypeScript 7 检查和 Web 构建通过。一次真实 Luna 文案编辑测试完成了读取、修改和验证，但单一样例不能证明整体延迟、token 节省或模型质量；需通过真实编码任务比较后才能作出这些结论。macOS 开发应用已启动并检查；未提供独立安装器，也未替换原应用。
