---
kind: upgrade-guide
description: Worker requests omit supervisor-only tools and repeated task details, and automatic skill selectors can refine local rules.
---

# Scoped worker context

English | [中文](guide.zh.md)

## Change

Agent Teams workers no longer receive Lead-only tool schemas, model-profile catalogs or the full coordinator checkpoint. Their own assignment, project instructions and permissions remain available. Automatic whole-interface design workflows run on the Lead; other local skill rules and explicit loading remain available to workers. Task creation, listing and update results omit `description` and `verification`; complete values remain available through `team_task_get`. This changes model-facing tool results, not stored task records.

The `skills/select-automatic` waterfall now runs for local-rule matches as well as misses. Its `next()` returns the local choice, or an empty list.

Dispatched assignments can now record a supervisor role and exact skill names; tasks can record immutable parent work packages. Old Team records remain valid. New records containing these optional fields are rejected by older strict Team readers, so downgrade is unsupported after hierarchical work is recorded. Projection checkpoints rebuild from the log under the new cache version. The coding overlay disables source rebuild watching while preserving plugin graph delivery; rebuilt code takes effect after a full App and Host restart.

## Migration

Set `workerTools` in the `tool-agent-team` configuration to an allowlist of loaded global tool names when workers should receive a smaller coding tool set; an empty list preserves inherited tools. Scoped Team and decision tools are unchanged.

1. Dispatch and configure model routes from the Lead. Give workers only relevant paths, interfaces, constraints and acceptance checks; load additional skills explicitly when needed.
2. Read `team_task_get` when an integration requires the full task description or verification. Use receipt IDs and revisions for updates.
3. Update automatic skill selectors to await `next()` and retain nonempty results unless intentionally overriding them. Return an empty list to suppress automatic selection in that scope.
4. Confirm a worker request contains its assignment and execution tools, while the Lead retains dispatch, model selection and checkpoint controls. Existing session and task data need no migration.

5. For hierarchical work, dispatch a package with `role: supervisor` and `isolation: shared`. Create its children with `parent_task_id`; keep each child inside the parent write paths. Omit assignment `skills` for automatic selection or supply exact permitted names. Verify that children run independently and the parent cannot report ready before accepting them.
6. Set `client-hmr.config.watchBuilds: false` in profiles updated by complete rebuilds. Quit before rebuilding and relaunch afterward; leave the default enabled for an intentional live Web development workflow.
