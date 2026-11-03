import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { workspaceInvocation, workspaceManager } from './workspace-invocation.ts'

describe('workspace package manager', () => {
  it.each(['/opt/tools/bun', String.raw`C:\Program Files\Bun\bun.exe`])('launches Bun directly without passing its binary to Node: %s', (entrypoint) => {
    expect(workspaceInvocation(['exec', 'vitest', 'run'], { npm_execpath: entrypoint })).toEqual({
      command: entrypoint, args: ['run', 'vitest', 'run'],
    })
  })

  it('preserves forwarded arguments rather than rewriting a script payload', () => {
    expect(workspaceInvocation(['run', 'task', 'exec', '--name=with spaces'], { npm_execpath: '/tools/bun' }).args)
      .toEqual(['run', 'task', 'exec', '--name=with spaces'])
    expect(workspaceManager({})).toBe('bun')
  })

  it('puts the run command before Bun workspace filters', () => {
    expect(workspaceInvocation(['--filter', '@fixture/app', 'run', 'build'], { npm_execpath: '/tools/bun' }))
      .toEqual({ command: '/tools/bun', args: ['run', '--filter', '@fixture/app', 'build'] })
  })

  it('retains shell-free JavaScript pnpm entrypoints for legacy artifact jobs', () => {
    expect(workspaceInvocation(['exec', 'vitest'], { npm_execpath: '/tools/pnpm.cjs' })).toEqual({
      command: process.execPath, args: ['/tools/pnpm.cjs', 'exec', 'vitest'],
    })
  })

  it('runs a Node executable through Bun while retaining the required Node runtime and environment', () => {
    const invocation = workspaceInvocation(['exec', process.execPath, '-e', 'console.log(JSON.stringify({bun:!!process.versions.bun,value:process.env.DSH_BUN_INVOCATION_TEST}))'], {})
    const result = spawnSync(invocation.command, invocation.args, {
      encoding: 'utf8', env: { ...process.env, DSH_BUN_INVOCATION_TEST: 'value with spaces' },
    })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ bun: false, value: 'value with spaces' })
  })
})
