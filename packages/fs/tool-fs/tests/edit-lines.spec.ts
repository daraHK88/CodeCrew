/** Anchored edits use the real registry, observation policy, and atomic local provider. */
import { Context } from '@deepseek-ai/cordis'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import CodingSettings from '@deepseek-ai/dsh-agent-default-model/coding-settings'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import * as ToolFs from '../src/index.ts'

async function fixture(content = 'function a() {\n  return false;\n}\nfunction b() {\n  return false;\n}\n', policy = true, config: ToolFs.Config = { anchoredEdits: true }, globalDefault?: boolean) {
  const dir = await mkdtemp(join(tmpdir(), 'codecrew-anchors-'))
  const fibers: Awaited<ReturnType<Context['plugin']>>[] = []
  onTestFinished(async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  const ctx = new Context()
  provideWorkingDirectoryFixture(ctx)
  fibers.push(await ctx.plugin(SystemPrompt), await ctx.plugin(ToolRuntime), await ctx.plugin(NativeExecutor))
  fibers.push(await ctx.plugin(LocalFileSystem, { cwd: dir }))
  if (policy) fibers.push(await ctx.plugin(FsPolicy))
  if (globalDefault !== undefined) fibers.push(await ctx.plugin(CodingSettings, { anchoredEdits: globalDefault }))
  fibers.push(await ctx.plugin(ToolFs, config))
  await writeFile(join(dir, 'code.txt'), content)
  const session = { header: { cwd: dir } }
  let sequence = 0
  const call = (name: string, args: unknown, owner = session) => executeToolFixture(ctx, {
    name, arguments: args, callId: ToolCallId(`anchored-${++sequence}`), signal: new AbortController().signal,
    agent: { session: owner } as never,
  })
  const read = () => call('read', { file_path: 'code.txt' })
  return { ctx, dir, call, read, contents: () => readFile(join(dir, 'code.txt'), 'utf8') }
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
}

function anchor(result: { content: { type: string; text?: string }[] }, number: number): string {
  const match = new RegExp(`(?:^|\\n)(${number}:[0-9a-f]{8})\\|`).exec(resultText(result))
  if (match === null) throw new Error(`No complete line ${number} in tool result`)
  return match[1]!
}

describe('anchored editing', () => {
  it('inherits the global setting in its tool scope and permits an explicit override', async () => {
    const enabled = await fixture('one\n', true, {}, true)
    expect(enabled.ctx.tools.get('edit_lines')).toBeDefined()
    expect(anchor(await enabled.read(), 1)).toMatch(/^1:/)
    const disabled = await fixture('one\n', true, { anchoredEdits: false }, true)
    expect(disabled.ctx.tools.get('edit_lines')).toBeUndefined()
    const absent = await fixture('one\n', true, {})
    expect(absent.ctx.tools.get('edit_lines')).toBeUndefined()
    const readOnly = await fixture('one\n', true, { edit: false, write: false }, true)
    expect(readOnly.ctx.tools.get('edit_lines')).toBeUndefined()
    expect(resultText(await readOnly.read())).not.toMatch(/1:[0-9a-f]{8}\|/)
  })

  it.each([true, false])('bounds the planning read even when provider size is unknown, known=%s', async (known) => {
    const f = await fixture('short\n'), read = await f.read()
    const originalStat = f.ctx.fs.stat.bind(f.ctx.fs)
    vi.spyOn(f.ctx.fs, 'stat').mockImplementation(async (...args) => {
      const info = await originalStat(...args)
      return info === undefined ? info : { version: info.version, type: info.type, ...(known ? { size: 3 * 1024 * 1024 } : {}) }
    })
    const stream = vi.spyOn(f.ctx.fs, 'streamText').mockImplementation(async () => (async function* () {
      yield 'x'.repeat(1024 * 1024)
      yield 'x'.repeat(1024 * 1024 + 1)
    })())
    const result = await f.call('edit_lines', { file_path: 'code.txt', edits: [{ op: 'replace', start: anchor(read, 1), text: 'new' }] })
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('2 MiB')
    expect(stream).toHaveBeenCalledTimes(known ? 0 : 1)
    expect(await f.contents()).toBe('short\n')
  })

  it('addresses duplicate code without echoing it and refreshes anchors for a second edit', async () => {
    const f = await fixture(), read = await f.read()
    expect((await f.call('edit', { file_path: 'code.txt', old_string: '  return false;', new_string: '  return true;' })).isError).toBe(true)
    expect(anchor(read, 2)).not.toBe(anchor(read, 5))
    const first = await f.call('edit_lines', { file_path: 'code.txt', edits: [{ op: 'replace', start: anchor(read, 5), text: '  return true;' }] })
    expect(first.isError, resultText(first)).toBe(false)
    expect(await f.contents()).toContain('function a() {\n  return false;')
    expect(await f.contents()).toContain('function b() {\n  return true;')
    const second = await f.call('edit_lines', { file_path: 'code.txt', edits: [{ op: 'replace', start: anchor(first, 5), text: '  return 42;' }] })
    expect(second.isError, resultText(second)).toBe(false)
    expect(await f.contents()).toContain('  return 42;')
  })

  it('applies a disjoint batch against original coordinates and preserves CRLF', async () => {
    const f = await fixture('a\r\nb\r\nc\r\nd\r\n'), read = await f.read()
    const result = await f.call('edit_lines', { file_path: 'code.txt', edits: [
      { op: 'replace', start: anchor(read, 4), text: 'D' },
      { op: 'insert_before', start: anchor(read, 1), text: 'first' },
      { op: 'replace', start: anchor(read, 2), end: anchor(read, 3), text: 'B\nC' },
    ] })
    expect(result.isError, resultText(result)).toBe(false)
    expect(await f.contents()).toBe('first\r\na\r\nB\r\nC\r\nD\r\n')
  })

  it('rejects the entire batch on overlap, leaving every byte intact', async () => {
    const f = await fixture(), before = await f.contents(), read = await f.read()
    const result = await f.call('edit_lines', { file_path: 'code.txt', edits: [
      { op: 'replace', start: anchor(read, 1), end: anchor(read, 3), text: 'first' },
      { op: 'replace', start: anchor(read, 2), text: 'second' },
    ] })
    expect(result.isError).toBe(true)
    expect(await f.contents()).toBe(before)
  })

  it('requires this session to have observed the file before its internal planning read', async () => {
    const f = await fixture(), read = await f.read()
    const result = await f.call('edit_lines', { file_path: 'code.txt', edits: [{ op: 'replace', start: anchor(read, 2), text: 'new' }] }, { header: { cwd: f.dir } })
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'FS_NOT_OBSERVED' } } })
    expect(await f.contents()).toContain('return false')
  })

  it('fails stale after an external change even outside the addressed line', async () => {
    const f = await fixture(), read = await f.read()
    const external = 'external\n' + await f.contents()
    await writeFile(join(f.dir, 'code.txt'), external)
    const result = await f.call('edit_lines', { file_path: 'code.txt', edits: [{ op: 'replace', start: anchor(read, 5), text: 'new' }] })
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'FS_STALE_VERSION' } } })
    expect(resultText(result)).toContain('re-read')
    expect(await f.contents()).toBe(external)
  })

  it.each([true, false])('guards the provider commit against a planning/write race, policy=%s', async (policy) => {
    const f = await fixture('before\n', policy), read = await f.read()
    const original = f.ctx.fs.editText.bind(f.ctx.fs)
    vi.spyOn(f.ctx.fs, 'editText').mockImplementationOnce(async (...args) => {
      await writeFile(join(f.dir, 'code.txt'), 'external edit\n')
      return original(...args)
    })
    const result = await f.call('edit_lines', { file_path: 'code.txt', edits: [{ op: 'replace', start: anchor(read, 1), text: 'new' }] })
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'FS_STALE_VERSION' } } })
    expect(await f.contents()).toBe('external edit\n')
  })

  it('does not reuse anchors from another target or expose clipped-line anchors', async () => {
    const f = await fixture('short\n'+ 'long'.repeat(20)+'\n', true, { anchoredEdits: true, readMaxLineLength: 10, readStreamMinSize: 1 })
    const read = await f.read()
    expect(resultText(read)).not.toMatch(/\n2:[0-9a-f]{8}\|/)
    await writeFile(join(f.dir,'other.txt'),'short\n')
    await f.call('read',{ file_path:'other.txt' })
    const result = await f.call('edit_lines',{ file_path:'other.txt',edits:[{ op:'replace',start:anchor(read,1),text:'wrong target' }] })
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'FS_STALE_VERSION' } } })
    expect(await readFile(join(f.dir,'other.txt'),'utf8')).toBe('short\n')
  })

  it('preserves a missing final newline and can delete every line', async () => {
    const f = await fixture('one\ntwo'), read = await f.read()
    const first=await f.call('edit_lines',{ file_path:'code.txt',edits:[{ op:'insert_after',start:anchor(read,2),text:'three\n' }] })
    expect(first.isError,resultText(first)).toBe(false)
    expect(await f.contents()).toBe('one\ntwo\nthree')
    const last=await f.call('edit_lines',{ file_path:'code.txt',edits:[{ op:'replace',start:anchor(first,3),text:'' }] })
    expect(last.isError,resultText(last)).toBe(false)
    const again=await f.read()
    const deleted=await f.call('edit_lines',{ file_path:'code.txt',edits:[{ op:'replace',start:anchor(again,1),end:anchor(again,2),text:'' }] })
    expect(deleted.isError,resultText(deleted)).toBe(false)
    expect(await f.contents()).toBe('')
  })

  it('keeps default compositions unchanged and rejects unadvertised permission arguments', async () => {
    const f=await fixture('one\n',true,{ anchoredEdits:false })
    expect(f.ctx.tools.get('edit_lines')).toBeUndefined()
    expect(resultText(await f.read())).toContain('1: one')
    expect(resultText(await f.read())).not.toMatch(/1:[0-9a-f]{8}\|/)
    const enabled=await fixture('one\n'), read=await enabled.read()
    const result=await enabled.call('edit_lines',{ file_path:'code.txt',sandbox_permissions:'danger-full-access',justification:'test',edits:[{ op:'replace',start:anchor(read,1),text:'unsafe' }] })
    expect(result.isError).toBe(true)
    expect(await enabled.contents()).toBe('one\n')
  })
})
