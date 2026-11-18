import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] ?? path.join(root, 'release'));
if (output === root) throw new Error('The release destination must not be the repository root.');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const frontend = path.join(root, 'packages/frontend/dist');
const backend = path.join(root, 'packages/backend/dist');
const identity = JSON.parse(await readFile(path.join(frontend, 'version.json'), 'utf8'));
if (identity.version !== commit)
  throw new Error('Frontend build does not match HEAD. Build with VITE_APP_COMMIT_HASH set to git rev-parse HEAD.');
await readFile(path.join(backend, 'app.js'));
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error('Use an empty release destination to prevent stale build files.');
await cp(frontend, path.join(output, 'frontend-dist'), { recursive: true });
await cp(backend, path.join(output, 'backend-dist'), { recursive: true });
await cp(path.join(root, 'packages/backend/src/migrations'), path.join(output, 'backend-migrations'), {
  recursive: true,
});
for (const name of ['Dockerfile.backend', 'Dockerfile.frontend']) {
  await cp(path.join(root, 'self-hosting/chinese', name), path.join(output, name));
}
const digest = (data) => createHash('sha256').update(data).digest('hex');
const files = {};
async function inventory(dir) {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await inventory(full);
    else if (entry.isFile())
      files[path.relative(output, full).split(path.sep).join('/')] = digest(await readFile(full));
    else throw new Error('Release files must not contain symbolic links.');
  }
}
await inventory(output);
const manifest = {
  application: 'MoneyMatter',
  commit,
  builtAt: identity.builtAt,
  packagedAt: new Date().toISOString(),
  packageLockSha256: digest(await readFile(path.join(root, 'package-lock.json'))),
  files,
};
await writeFile(path.join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Packaged ${Object.keys(files).length} files for ${commit} at ${output}`);
