---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-03-specialist-work-packages

English | [中文](2026-11-03-specialist-work-packages.zh.md)

## Summary

Records immutable parent task identities, delegated supervisor roles and scoped assignment skill names.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing v2 Team task and dispatch records omit these optional fields and remain valid. New records are rejected by older strict Team readers rather than interpreted as flat workers; downgrade after recording hierarchical work is unsupported. The current reader validates ancestry and contained paths, immutable dispatch authority and skills. Session format remains unchanged; agentTeam stateVersion 7 rebuilds incompatible projection checkpoints from the authoritative log.

<a id="verification"></a>
## Verification

Affected team, persistence, projection, tool-skill and HMR suites passed 224 tests. The ten-specialist test covers simultaneous independent routes, parent ancestry replay, self/peer acceptance denial and contained scopes. The idle-supervisor test covers capacity release, cold-resume notifications and subtree cancellation.

<a id="dev-note"></a>
## Dev Note

None.
