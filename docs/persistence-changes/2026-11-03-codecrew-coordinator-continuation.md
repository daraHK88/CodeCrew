---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-03-codecrew-coordinator-continuation

English | [中文](2026-11-03-codecrew-coordinator-continuation.zh.md)

## Summary

Adds a durable bounded project checkpoint, waiting assignments for owned background jobs, and compact skill-catalog attribution.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing records remain readable. The checkpoint event is additive and uses the existing v2 Team envelope; the projection state version increases to 6 and rebuilds derived state. New waiting phases require this coordinator implementation; older strict Team readers reject unknown phases or events rather than replaying edits. The optional shortlist source flag does not change existing full-catalog records. No persisted file is rewritten and older processes must be upgraded before reading new coordinator records.

<a id="verification"></a>
## Verification

Focused tests verify checkpoint revision checks, restart replay, projection publication and restoration after compaction; independent worker startup despite a held provider; retention through real background-job completion; restrictions, deduplication and paged skill discovery. Native TypeScript 7 and focused model-facing snapshots verify the public contracts.

<a id="dev-note"></a>
## Dev Note

None.
