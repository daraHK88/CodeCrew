#!/usr/bin/env node
/** Prepare an isolated coding profile using this checkout's built workspace packages. */
import { mkdir, readFile, writeFile, symlink, lstat, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const home = join(root, '.coding-home')
await mkdir(home, { recursive: true, mode: 0o700 })
const create = async (path, value) => {
  try { await writeFile(path, value, { flag: 'wx', mode: 0o600 }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
}
const uiAssets = join(home, 'ui-assets', 'phosphor')
await mkdir(uiAssets, { recursive: true, mode: 0o700 })
for (const file of ['icons.svg', 'LICENSE', 'README.md', 'README.zh.md', 'README.i18n.yaml']) {
  await create(join(uiAssets, file), await readFile(join(root, 'coding', 'assets', 'phosphor', file)))
}
const criteria = (await readFile(join(root, 'coding', 'UI-CRITERIA.md'), 'utf8'))
  .replace('(assets/phosphor/README.md)', `(<${join(uiAssets, 'README.md')}>)`)
  .replace('(check-ui.mjs)', `(<${join(root, 'coding', 'check-ui.mjs')}>)`)
await create(join(home, 'UI-CRITERIA.md'), criteria)
await create(join(home, 'UI-PREFERENCES.md'), await readFile(join(root, 'coding', 'UI-PREFERENCES.md')))
const workflow = (await readFile(join(root, 'coding', 'AGENTS.md'), 'utf8'))
  .replace('(UI-CRITERIA.md)', `(<${join(home, 'UI-CRITERIA.md')}>)`)
  .replace('(UI-PREFERENCES.md)', `(<${join(home, 'UI-PREFERENCES.md')}>)`)
await create(join(home, 'AGENTS.md'), workflow)
const packages = []
for (const group of await readdir(join(root, 'packages'), { withFileTypes: true })) {
  if (!group.isDirectory()) continue
  for (const pkg of await readdir(join(root, 'packages', group.name), { withFileTypes: true })) if (pkg.isDirectory()) packages.push(join(root, 'packages', group.name, pkg.name))
}
for (const entry of await readdir(join(root, 'vendor'), { withFileTypes: true })) if (entry.isDirectory()) packages.push(join(root, 'vendor', entry.name))
for (const name of ['coding', 'desktop']) {
  const profile = join(home, 'profiles', name)
  await mkdir(profile, { recursive: true, mode: 0o700 })
  await create(join(profile, 'package.json'), JSON.stringify({ name: 'codecrew-' + name + '-local', private: true, type: 'module', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-experimental-agent-team-profile'] } } }, null, 2) + '\n')
  await create(join(profile, 'cordis.yml'), '[]\n')
  await create(join(profile, 'cordis.patch.yml'), await readFile(join(root, 'coding', 'cordis.patch.yml')))
  for (const path of packages) {
    let manifest
    try { manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (!manifest.name) continue
    const link = join(profile, 'node_modules', manifest.name)
    await mkdir(dirname(link), { recursive: true })
    try { await lstat(link) }
    catch (error) { if (error.code !== 'ENOENT') throw error; await symlink(path, link, 'dir') }
  }
}
console.log('Prepared isolated coding profile at ' + home)
console.log('Existing app sessions and configuration were not changed.')
console.log('Run from the checkout:')
console.log('DSH_HOME="' + home + '" node --import tsx/esm apps/cli/src/bin.ts coding --no-open')
