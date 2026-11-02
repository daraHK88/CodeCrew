/** Real provider reads preserve containment, freshness and read-before-edit boundaries. */
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdtemp, rm, writeFile, symlink, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { inspectDecisionFiles } from '../src/decision-files.ts'
import { decisionDefaults, type DecisionInput } from '../src/decisions.ts'

const input: DecisionInput = { context: 'Which supplied source owns access checks?', questions: [
  { id: 'owns_access', type: 'noul', question: 'Does this source enforce access control?' },
] }
const policy = { ...decisionDefaults, enabled: true, inspectFiles: true }

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'codecrew-jev-files-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) })
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  await ctx.plugin(FsPolicy)
  const agent = { session: { header: { cwd: dir } } } as Agent
  await writeFile(join(dir, 'source.ts'), 'export const canRead = (role) => role === "admin";\n')
  return { ctx, dir, agent }
}

it('binds evidence to actual versions without granting permission to edit', async () => {
  const { ctx, dir, agent } = await fixture()
  const result = await inspectDecisionFiles(ctx, agent, ['source.ts', 'source.ts'], input, policy, AbortSignal.timeout(5000))
  expect(result.sources).toHaveLength(1)
  expect(result.context).toContain('canRead')
  expect(JSON.stringify(result.sources)).not.toContain('canRead')
  const target = await ctx.fs.resolve('source.ts', { cwd: dir })
  await expect(ctx.waterfall('fs/edit-intent', target, { agent }, () => undefined)).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  expect(result.sources[0]?.version).toBe((await ctx.fs.stat(target))?.version)
})

it('refuses paths outside the canonical workspace, including symlink aliases', async () => {
  const { ctx, dir, agent } = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'codecrew-jev-outside-'))
  onTestFinished(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, 'private.ts'), 'private data')
  await symlink(join(outside, 'private.ts'), join(dir, 'alias.ts'))
  for (const path of [join(outside, 'private.ts'), 'alias.ts']) {
    await expect(inspectDecisionFiles(ctx, agent, [path], input, policy, AbortSignal.timeout(5000)))
      .rejects.toMatchObject({ code: 'DECISION_FILE_SCOPE' })
  }
})

it('refuses credential paths and recognizable key material before egress', async () => {
  const { ctx, dir, agent } = await fixture()
  await writeFile(join(dir, '.env.local'), 'fixture credential')
  await writeFile(join(dir, 'source.ts'), '-----BEGIN PRIVATE KEY-----\nsynthetic fixture\n')
  for (const path of ['.env.local', 'source.ts']) {
    await expect(inspectDecisionFiles(ctx, agent, [path], input, policy, AbortSignal.timeout(5000)))
      .rejects.toMatchObject({ code: 'DECISION_FILE_SENSITIVE' })
  }
})

it('counts escaped JSON, wrappers and Unicode in the complete input budget', async () => {
  const { ctx, dir, agent } = await fixture()
  await writeFile(join(dir, 'source.ts'), '"\\你好\n'.repeat(30))
  await expect(inspectDecisionFiles(ctx, agent, ['source.ts'], input, { ...policy, maxTextBytes: 600 }, AbortSignal.timeout(5000)))
    .rejects.toMatchObject({ code: 'DECISION_INPUT_LIMIT' })
})

it('bounds streams of unknown size and rejects files changed during the read', async () => {
  const { ctx, dir, agent } = await fixture()
  const originalStat = ctx.fs.stat.bind(ctx.fs)
  vi.spyOn(ctx.fs, 'stat').mockImplementation(async (...args) => {
    const info = await originalStat(...args)
    return info === undefined ? undefined : { version: info.version, type: info.type }
  })
  const stream = vi.spyOn(ctx.fs, 'streamText').mockImplementation(async () => (async function* () { yield 'x'.repeat(12001) })())
  await expect(inspectDecisionFiles(ctx, agent, ['source.ts'], input, policy, AbortSignal.timeout(5000)))
    .rejects.toMatchObject({ code: 'DECISION_INPUT_LIMIT' })
  stream.mockImplementationOnce(async () => (async function* () {
    yield 'original content'
    await writeFile(join(dir, 'source.ts'), 'changed externally')
  })())
  await expect(inspectDecisionFiles(ctx, agent, ['source.ts'], input, policy, AbortSignal.timeout(5000)))
    .rejects.toMatchObject({ code: 'DECISION_FILE_STALE' })
  expect(await readFile(join(dir, 'source.ts'), 'utf8')).toBe('changed externally')
})
