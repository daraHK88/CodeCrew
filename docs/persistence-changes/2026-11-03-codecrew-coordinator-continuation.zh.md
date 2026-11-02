---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-03-codecrew-coordinator-continuation

[English](2026-11-03-codecrew-coordinator-continuation.md) | 中文

## 概述

新增持久化有界项目检查点、后台任务等待状态以及紧凑技能目录来源标记。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-03-codecrew-coordinator-continuation
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-02-codecrew-context"
    after: "e61eef5b1c7687d209b7d0e5daf9d15ee446f0665c872d18e481fadf87be259c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-02-codecrew-context"
    after: "5b9b40edbe72eb1ee4f6964233566e3af1606f8d3b41becb1fcb116ecaf99faf"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-02-codecrew-context"
    after: "08067e3c797991b4628450522cbf93be3775ef26e1d9ef6d169aaa5958907cf6"
    decision: same-version
  - root: "event:team/checkpoint"
    previous: null
    after: "e4128cc2af63d1ed10af43bc82e031d8a1c6d308eab1f941d158af2f7dc64dde"
    decision: same-version
  - root: "event:team/dispatch"
    previous: "2026-11-03-codecrew-supervised-dispatch"
    after: "0193db2197e4ca2a348cef9f3da39de87a1576e6adef76ba170d6eaea86c2206"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-02-codecrew-context"
    after: "17aa5baad0f8579cead222c84f23e23586ba5bc6e62aee1dc33b80d6cb38ffe6"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

现有记录仍可读取。检查点事件为增量扩展，沿用 v2 Team 封装；投影状态版本提升为 6 并重建派生状态。新的 waiting 阶段需要新版协调器；旧版严格 Team 读取器会拒绝未知阶段或事件，而不会重放编辑。可选 shortlist 标记不改变现有完整目录记录。不重写持久化文件，旧进程须升级后才能读取新的协调器记录。

<a id="verification"></a>
## 验证

定向测试验证检查点修订检查、重启回放、投影发布和压缩后恢复；在一个提供方暂停时独立 worker 仍可启动；真实后台任务完成期间保留 worker；技能权限、去重和分页发现。原生 TypeScript 7 与定向模型快照验证公开契约。

<a id="dev-note"></a>
## 开发备注

无。
