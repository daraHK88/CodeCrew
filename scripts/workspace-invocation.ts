/** Shell-free workspace commands for Bun development and retained pnpm release jobs. */
import { basename, isAbsolute } from 'node:path'
import { pnpmInvocation } from './pnpm-invocation.ts'

/**
 * Identify the lifecycle package manager, defaulting to Bun for direct script execution.
 * @param environment - Package-script environment, including npm_execpath.
 * @returns The manager used for nested workspace commands.
 */
export function workspaceManager(environment: NodeJS.ProcessEnv = process.env): 'bun' | 'pnpm' {
  const entry = environment.npm_execpath
  return entry === undefined || entry === '' || /^bun(?:\.exe)?$/iu.test(basename(entry.replaceAll('\\', '/'))) ? 'bun' : 'pnpm'
}

/**
 * Resolve run/exec workspace commands without a shell or implicit package downloads.
 * @param args - Workspace run/exec arguments; Bun uses run for installed binaries too.
 * @param environment - Lifecycle executable; direct invocations use Bun from PATH.
 * @returns An executable and arguments suitable for spawn on each supported platform.
 */
export function workspaceInvocation(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  if (workspaceManager(environment) === 'pnpm') return pnpmInvocation(args, environment)
  const command = environment.npm_execpath || (process.platform === 'win32' ? 'bun.exe' : 'bun')
  if (args[0] === 'exec' && args[1] !== undefined && isAbsolute(args[1])) return { command: args[1], args: args.slice(2) }
  if (args[0] === '--filter' && args[1] !== undefined && args[2] === 'run') {
    return { command, args: ['run', '--filter', args[1], ...args.slice(3)] }
  }
  return { command, args: args[0] === 'exec' ? ['run', ...args.slice(1)] : [...args] }
}
