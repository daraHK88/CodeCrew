---
kind: upgrade-guide
description: "选择聊天模型不再更改后续聊天的默认模型。"
---

# 聊天模型选择仅对当前聊天生效

[English](guide.md) | 中文

## 变更

`session/selectModel` 仅为当前 Session 记录提供方、模型和可选推理强度，不再在后台将该选择保存为全局默认值。现有默认设置和已记录的 Session 选择仍然有效。

## 迁移

1. 在 coding profile 中，要更改后续聊天的默认值，请打开 Settings → Coding → Default model。其他组合仍可使用 `ctx.agentDefaultModel.saveSelection()` 或 `agent-default-model` profile 配置。
2. 在现有聊天中选择另一个模型。确认该聊天的模型发生变化，而全局默认值保持不变，再打开新聊天，确认其使用配置的默认值。
