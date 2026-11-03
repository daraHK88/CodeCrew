---
kind: upgrade-guide
description: Team dispatch retains the Lead model unless the caller explicitly requests the configured supervisor profile.
---

# Explicit supervisor model selection

English | [中文](guide.zh.md)

## Change

`team_dispatch` no longer automatically changes the Lead model when `coding.supervisorProfile` is configured. Worker profiles remain independent. This affects agents or integrations relying on dispatch to select the supervisor's next-step model. Existing settings and session data remain readable.

## Migration

1. Keep ordinary dispatch calls unchanged to retain the current Lead model and its context cache.
2. For an intentional supervisor phase change, include `"select_supervisor": true` in the dispatch arguments, or call `select_model_profile` explicitly before that phase. The route comes from the existing `coding.supervisorProfile` setting.
3. Check the Lead's current model and each worker's assigned model independently. Keep the Lead stable for status checks and the final reply; use scoped reader assignments for independent inexpensive work when useful.
