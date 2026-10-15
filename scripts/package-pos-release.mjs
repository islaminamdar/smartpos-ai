import { cp, mkdir, readFile, readdir, realpath, lstat, writeFile } from 'node:fs/promises'
import { resolve, relative, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = resolve(new URL('..', import.meta.url).pathname)
const destination = resolve(process.argv[2] || '')
if (!process.argv[2] || destination === root || destination.startsWith(root + '/')) throw new Error('Provide a fresh release directory outside the repository.')
await mkdir(destination, { recursive: false })
await cp(join(root, '.next/standalone'), destination, { recursive: true, dereference: false, verbatimSymlinks: true })
await cp(join(root, '.next/static'), join(destination, '.next/static'), { recursive: true })
await cp(join(root, 'public'), join(destination, 'public'), { recursive: true })
let files = 0
async function verify(directory) {
  for (const name of await readdir(directory)) {
    const path = join(directory, name)
    if (name === '.env' || name.startsWith('.env.') || name.endsWith('.pem') || name.endsWith('.key')) throw new Error(`Private configuration must not be in a release: ${relative(destination, path)}`)
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) {
      const target = await realpath(path)
      if (target !== destination && !target.startsWith(destination + '/')) throw new Error(`Release symlink escapes artifact: ${relative(destination, path)}`)
    } else if (stat.isDirectory()) await verify(path)
    else files++
  }
}
await verify(destination)
await readFile(join(destination, 'server.js'))
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const dirty = !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()
if (dirty) throw new Error('Commit reviewed source before packaging a deployable release.')
const metadata = { sourceCommit, buildId: (await readFile(join(root, '.next/BUILD_ID'), 'utf8')).trim(), preparedAt: new Date().toISOString(), mode: 'training_only', liveSalesEnabled: false, files }
await writeFile(join(destination, 'release.json'), JSON.stringify(metadata, null, 2) + '\n')
console.log(JSON.stringify({ destination, ...metadata }))
