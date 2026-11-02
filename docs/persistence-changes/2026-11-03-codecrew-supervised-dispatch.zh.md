---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-03-codecrew-supervised-dispatch

[English](2026-11-03-codecrew-supervised-dispatch.md) | 中文

## 概述

新增持久的主管授权任务分派及可选任务验证证据。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-03-codecrew-supervised-dispatch
baseline: false
changes:
  - root: "event:team/dispatch"
    previous: null
    after: "ae14c062747e2e01422f1fbba41b1b315fa228f21f7eca7e4f6056f4837acb37"
    decision: same-version
  - root: "event:team/task"
    previous: "2026-09-11-initial"
    after: "22b01bdd320415f51db9465b3cb654fb989b79963ade2b203acbee0b0806af00"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

现有 Team v2 记录仍可读取，分派队列初始为空。新增 team/dispatch 事件具有独立类型；不支持该功能的读取器不会执行排队任务。较旧的严格 Team 任务投影可能拒绝带 verification 的快照并报告投影失败，不会改写 Session 日志。checkpoint stateVersion 增加，当前读取器从事件重建状态。不移动或修改已发布的 Session 文件。

<a id="verification"></a>
## 验证

定向 Agent Teams、Team 工具和 worktree 测试覆盖当前任务授权、依赖验收、worker 报告、仅主管完成、取消等待退出及重启恢复。

<a id="dev-note"></a>
## 开发备注

无。
