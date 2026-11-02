---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-02-codecrew-context

English | [中文](2026-11-02-codecrew-context.zh.md)

## Summary

Adds coding-memory snapshots and automatically loaded skill instructions to durable user-message context.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing V4 records remain valid. The new source kinds attach producer metadata to ordinary text messages. The merge-extensible MessageSource contract requires consumers to fall through unfamiliar kinds, preserving the text and metadata without treating them as permissions or successful task completion. Current readers still accept older source variants; absence of a coding-memory snapshot causes the bounded memory loader to read the current configured files before the next admitted step. No event discriminator or existing source variant is removed or renamed.

<a id="verification"></a>
## Verification

Focused context, automatic-skill, and Session-format suites passed: 6 files, 72 tests. They cover memory isolation and restoration, skill visibility and size bounds, and lossless Session JSON/codec behavior. Native TypeScript 7 aggregate checks passed in the full application build.

<a id="dev-note"></a>
## Dev Note

None.
