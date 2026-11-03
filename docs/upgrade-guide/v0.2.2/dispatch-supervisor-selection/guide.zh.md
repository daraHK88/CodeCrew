---
kind: upgrade-guide
description: 团队分派保留 Lead 模型，除非调用方显式请求配置的主管 profile。
---

# 显式选择主管模型

[English](guide.md) | 中文

## 变更

配置 `coding.supervisorProfile` 后，`team_dispatch` 不再自动改变 Lead 模型。Worker profile 仍保持独立。此变更影响依赖分派自动选择主管下一步模型的 agent 或集成。既有设置和会话数据仍可读取。

## 迁移

1. 普通分派调用保持不变，以保留当前 Lead 模型及其上下文缓存。
2. 如需有意改变主管阶段，在分派参数中加入 `"select_supervisor": true`，或在该阶段前显式调用 `select_model_profile`。路由来自既有 `coding.supervisorProfile` 设置。
3. 分别检查 Lead 当前模型和各 worker 分配的模型。状态检查和最终回复保持 Lead 模型稳定；有用时将独立低成本工作交给限定上下文的 reader。
