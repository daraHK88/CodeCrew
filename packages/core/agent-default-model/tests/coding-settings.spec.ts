import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished } from 'vitest'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import CodingSettings from '../src/coding-settings.ts'

it('keeps skill and memory policy global and applies live configuration changes', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const live = await liveConfig(ctx, CodingSettings, {
    skills: { enabled: true, rules: [{ keywords: ['investigate'], skills: ['diagnosing-bugs'] }] },
    memory: { enabled: true, workspaceFile: '.dsh/BRIEF.md' },
  })
  expect(ctx.codingSettings.skills().enabled).toBe(true)
  expect(ctx.codingSettings.skills().catalogMaxSkills).toBe(0)
  expect(ctx.codingSettings.memory().workspaceFile).toBe('.dsh/BRIEF.md')
  await live.update({ skills: { enabled: false }, memory: { enabled: false } })
  expect(ctx.codingSettings.skills().enabled).toBe(false)
  expect(ctx.codingSettings.memory().enabled).toBe(false)
})

it('retains regex-only rules and an opt-in compact catalog', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await liveConfig(ctx, CodingSettings, { skills: { catalogMaxSkills: 4, rules: [{ pattern: '\\bbuild\\b.*\\bdashboard\\b', skills: ['design-distinctive-frontends'] }] } })
  expect(ctx.codingSettings.skills().catalogMaxSkills).toBe(4)
  expect(ctx.codingSettings.skills().rules[0]).toEqual({ keywords: [], pattern: '\\bbuild\\b.*\\bdashboard\\b', skills: ['design-distinctive-frontends'] })
})
