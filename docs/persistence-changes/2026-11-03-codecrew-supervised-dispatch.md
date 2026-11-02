---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-03-codecrew-supervised-dispatch

English | [中文](2026-11-03-codecrew-supervised-dispatch.zh.md)

## Summary

Adds durable supervisor-authorized task dispatch and optional task verification evidence.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing Team v2 records remain readable with an empty dispatch queue. New team/dispatch events use a new event discriminant; readers without the feature do not execute queued work. Older strict Team task projections may reject task snapshots containing verification and report a projection failure without rewriting the Session log. Checkpoint stateVersion increases so current readers rebuild from events. No released Session generation is moved or changed.

<a id="verification"></a>
## Verification

Focused Agent Teams, Team tool and worktree tests verify current-task authorization, dependency acceptance, worker reporting, supervisor-only completion, cancellation settlement and restart recovery.

<a id="dev-note"></a>
## Dev Note

None.
