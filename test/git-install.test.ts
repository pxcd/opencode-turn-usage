import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, cp, access, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
const { Arborist } = createRequire(import.meta.url)("@npmcli/arborist");
const triggers = ["build", "prepare", "prepack", "preinstall", "install", "postinstall"];

test("prebuilt package installs from Git without npm preparation; old build trigger reproduces failure", async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(!manifest.workspaces);
  for (const name of triggers) assert.ok(!manifest.scripts?.[name], `Git preparation trigger: ${name}`);
  const root = await mkdtemp(join(tmpdir(), 'turn-usage-git-test-'));
  try {
    for (const broken of [true, false]) {
      const label = broken ? 'old-trigger' : 'prebuilt';
      const source = join(root, label); await mkdir(source);
      const pkg = structuredClone(manifest);
      if (broken) pkg.scripts.build = 'node scripts/build.mjs';
      await writeFile(join(source, 'package.json'), JSON.stringify(pkg));
      await cp(new URL('../dist', import.meta.url), join(source, 'dist'), { recursive: true });
      execFileSync('git', ['init', '-b', 'fixture', source], { stdio: 'pipe' });
      execFileSync('git', ['add', '.'], { cwd: source });
      execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture'], { cwd: source, stdio: 'pipe' });
      const marker = join(root, label + '-prepared');
      const npmBin = join(root, label + '-npm.js');
      await writeFile(npmBin, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected preparation');process.exit(87);`);
      const target = join(root, label + '-installed');
      const installer = new Arborist({ path: target, cache: join(root, label + '-cache'), offline: true,
        ignoreScripts: true, audit: false, progress: false, npmBin });
      const install = () => installer.reify({ add: ['git+file://' + source], save: true, saveType: 'prod' });
      if (broken) {
        await assert.rejects(install(), /git dep preparation failed/);
        await access(marker);
      } else {
        await install();
        await assert.rejects(access(marker), { code: 'ENOENT' });
        await access(join(target, 'node_modules', manifest.name, 'dist/gui-experimental.cjs'));
        const installed = JSON.parse(await readFile(join(target, 'node_modules', manifest.name, 'package.json'), 'utf8'));
        assert.equal(installed.version, manifest.version);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
