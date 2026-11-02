---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-02-codecrew-context

[English](2026-11-02-codecrew-context.md) | 中文

## 概述

将 coding-memory 快照和自动加载的技能指令加入持久化用户消息上下文。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-02-codecrew-context
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "e54d6d0f8f8232a212428db2fa83a008da03c8f0f21e2405c15c16a1b9129e4c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "e7267bdf16befbb6497c0e8edc91ead872e02d17052b83b3e03c9547a4c5e1b2"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "e01cd8aea47596e79c1edab58a8dceb6cdfc6ecdff05862c7648744c3ff34e4c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "d4ad36b4c99798f87f095e9df55e9766ced8069b9ef839127263425601661d1a"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有 V4 记录仍然有效。新的 source kind 为普通文本消息附加来源元数据。可扩展的 MessageSource 契约要求消费方忽略未知来源种类，保留文本与元数据，不将它们视为权限或任务完成证据。当前读取方仍接受旧来源；缺少 coding-memory 快照时，受预算限制的加载器会在下一获准步骤前读取当前配置文件。没有删除或重命名事件判别值或已有来源。

<a id="verification"></a>
## 验证

上下文、自动技能和 Session 格式专项测试共 6 个文件、72 个测试通过，覆盖记忆隔离与恢复、技能可见性与大小限制，以及无损 Session JSON 和编码行为。完整应用构建中的原生 TypeScript 7 聚合检查通过。

<a id="dev-note"></a>
## 开发备注

无。
