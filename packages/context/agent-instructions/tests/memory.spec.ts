import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { readMemory } from '../src/memory.ts'

const contexts: Context[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'coding-memory-'))
  dirs.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await mkdir(join(root, 'one'))
  await mkdir(join(root, 'two'))
  const globalFile = join(root, 'general.md')
  await writeFile(globalFile, 'Use existing project conventions.')
  await writeFile(join(root, 'one', 'MEMORY.md'), 'Goal: fix the login redirect.')
  await writeFile(join(root, 'two', 'MEMORY.md'), 'Other workspace private state.')
  return { root, ctx, settings: { enabled: true, globalFile, workspaceFile: 'MEMORY.md', maxBytes: 2048 } }
}
it('combines general memory with only the selected workspace', async () => {
  const { ctx, root, settings } = await fixture()
  const sections = await readMemory(ctx, join(root, 'one'), settings, new AbortController().signal)
  expect(sections.map(section => section.name)).toEqual(['General memory', 'Workspace memory'])
  expect(JSON.stringify(sections)).toContain('fix the login redirect')
  expect(JSON.stringify(sections)).not.toContain('Other workspace')
})
it('does not follow workspace memory outside its workspace, including symlinks', async () => {
  const { ctx, root, settings } = await fixture()
  await symlink(join(root, 'two', 'MEMORY.md'), join(root, 'one', 'LINK.md'))
  const sections = await readMemory(ctx, join(root, 'one'), { ...settings, workspaceFile: 'LINK.md' }, new AbortController().signal)
  expect(sections.map(section => section.name)).toEqual(['General memory'])
})
it('keeps oversized memory on disk and omits it rather than emitting a partial goal', async () => {
  const { ctx, root, settings } = await fixture()
  await writeFile(join(root, 'one', 'MEMORY.md'), 'x'.repeat(3000))
  const sections = await readMemory(ctx, join(root, 'one'), settings, new AbortController().signal)
  expect(sections.map(section => section.name)).toEqual(['General memory'])
})
it('propagates cancellation', async () => {
  const { ctx, root, settings } = await fixture()
  await expect(readMemory(ctx, root, settings, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled')
})
