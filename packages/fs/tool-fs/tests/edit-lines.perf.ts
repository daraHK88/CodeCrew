/** Deterministic edit-wire diagnostic over built production tools; no model or latency claims. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import * as ObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')
const source = Array.from({ length: 80 }, (_, index) => `const setting_${index} = false;`).join('\n') + '\n'
const scenarios = [
  { name: 'tiny-unique-change', starts: [10], count: 1 },
  { name: 'forty-line-replacement', starts: [10], count: 40 },
  { name: 'eight-disjoint-edits', starts: [2, 10, 20, 30, 40, 50, 60, 70], count: 1 },
]
const report = []
for (const scenario of scenarios) {
  const arms = []
  for (const mode of ['literal', 'patch', 'anchored']) {
    const dir = await mkdtemp(join(tmpdir(), 'codecrew-edit-wire-'))
    const fibers: Awaited<ReturnType<Context['plugin']>>[] = []
    try {
      const ctx = new Context()
      provideWorkingDirectoryFixture(ctx)
      fibers.push(await ctx.plugin(SystemPrompt), await ctx.plugin(ToolRuntime), await ctx.plugin(NativeExecutor))
      fibers.push(await ctx.plugin(LocalFileSystem, { cwd: dir }), await ctx.plugin(ObservationPolicy))
      fibers.push(await ctx.plugin(ToolFs, { anchoredEdits: mode === 'anchored', applyPatch: true }))
      await writeFile(join(dir, 'fixture.ts'), source)
      const session = { header: { cwd: dir } }
      let serial = 0
      const call = (name: string, args: unknown) => executeToolFixture(ctx, {
        name, arguments: args, callId: ToolCallId(`wire-${++serial}`), signal: AbortSignal.timeout(10000),
        agent: { session } as never,
      })
      const read = await call('read', { file_path: 'fixture.ts' })
      assert(!read.isError)
      const content = read.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      const lines = source.trimEnd().split('\n')
      const expected = [...lines]
      const operations = scenario.starts.map((start) => {
        const old = lines.slice(start - 1, start - 1 + scenario.count).join('\n')
        const text = old.replaceAll('false', 'true')
        expected.splice(start - 1, scenario.count, ...text.split('\n'))
        return { start, end: start + scenario.count - 1, old, text }
      })
      let editRequestBytes = 0
      let editResultBytes = 0
      if (mode === 'anchored') {
        const anchor = (n: number): string => {
          const found = new RegExp(`(?:^|\\n)(${n}:[0-9a-f]{8})\\|`).exec(content)
          assert(found?.[1]); return found[1]
        }
        const args = { file_path: 'fixture.ts', edits: operations.map(op => ({ op: 'replace', start: anchor(op.start), ...(op.end === op.start ? {} : { end: anchor(op.end) }), text: op.text })) }
        editRequestBytes += bytes(args)
        const result = await call('edit_lines', args)
        assert(!result.isError, JSON.stringify(result.error))
        editResultBytes += bytes(result.content)
      } else if (mode === 'patch') {
        const hunks = operations.map(op => '@@\n' + op.old.split('\n').map(line => '-' + line).join('\n')
          + '\n' + op.text.split('\n').map(line => '+' + line).join('\n')).join('\n')
        const args = { input: '*** Begin Patch\n*** Update File: fixture.ts\n' + hunks + '\n*** End Patch' }
        editRequestBytes += bytes(args)
        const result = await call('apply_patch', args)
        assert(!result.isError, JSON.stringify(result.error))
        editResultBytes += bytes(result.content)
      } else {
        for (const op of operations) {
          const args = { file_path: 'fixture.ts', old_string: op.old, new_string: op.text }
          editRequestBytes += bytes(args)
          const result = await call('edit', args)
          assert(!result.isError, JSON.stringify(result.error))
          editResultBytes += bytes(result.content)
        }
      }
      assert.equal(await readFile(join(dir, 'fixture.ts'), 'utf8'), expected.join('\n')+'\n')
      arms.push({ mode, editCalls: mode === 'literal' ? operations.length : 1,
        editRequestBytes, readResponseBytes: Buffer.byteLength(content.replaceAll(dir, '/workspace')), editResultBytes })
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  }
  report.push({ scenario: scenario.name, arms })
}
console.log(JSON.stringify({ workload: 'Fixed 80-line synthetic source; exact final-file equality required for every arm.',
  measurement: 'Serialized edit-argument UTF-8 bytes; read bytes include anchors. No model, tokenizer, wall-clock, or quality claim.', results: report }, null, 2))
