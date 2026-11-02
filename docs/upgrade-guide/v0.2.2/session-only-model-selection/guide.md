---
kind: upgrade-guide
description: "Selecting a chat model no longer changes the default model for later chats."
---

# Chat model choices stay in their chat

English | [中文](guide.zh.md)

## Change

`session/selectModel` records the selected provider, model and optional reasoning effort for that Session only. It no longer saves the selection as the global default in the background. Existing saved defaults and recorded Session choices remain valid.

## Migration

1. To change the default for later chats in the coding profile, open Settings → Coding → Default model. Other compositions can continue using `ctx.agentDefaultModel.saveSelection()` or the `agent-default-model` profile configuration.
2. Choose a different model inside an existing chat. Confirm the chat changes while the global default remains unchanged, then open a new chat to confirm it uses the configured default.
