---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-03-specialist-work-packages

[English](2026-11-03-specialist-work-packages.md) | 中文

## 概述

记录不可变的父任务标识、委派主管角色及各任务的技能名称。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-03-specialist-work-packages
baseline: false
changes:
  - root: "event:team/dispatch"
    previous: "2026-11-03-codecrew-coordinator-continuation"
    after: "3f9a3dd36e44adf9d19f843528038299ae8e6afdbdfb759483488a1ec53a51c9"
    decision: same-version
  - root: "event:team/task"
    previous: "2026-11-03-codecrew-supervised-dispatch"
    after: "0ec3c0c4e904ed9c3419f9cd0a0c137e85a3c72d92f61a1bf715b12f15d3976b"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

现有 v2 Team 任务与分派记录省略这些可选字段，仍可读取。旧版严格读取器会拒绝新字段，而不会将分层工作误解为扁平 worker；记录分层工作后不支持降级。当前读取器验证层级、包含路径以及分派权限和技能的不可变性。Session 格式不变；agentTeam 的 stateVersion 7 从权威日志重建不兼容的投影检查点。

<a id="verification"></a>
## 验证

相关 Team、持久化、投影、tool-skill 和 HMR 测试共 224 项通过。十专员测试覆盖并行独立路由、父任务回放、自我及同级验收拒绝和范围包含。空闲主管测试覆盖执行槽释放、通知冷恢复与后代取消。

<a id="dev-note"></a>
## 开发备注

无。
