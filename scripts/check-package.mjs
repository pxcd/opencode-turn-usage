import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const root = resolve('.artifacts');
mkdirSync(root, { recursive: true });
const [packed] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], { encoding: 'utf8' }));
const files = packed.files.map(f => f.path);
for (const entry of ['dist/gui-experimental.cjs', 'dist/tui.js', 'dist/accounting.js', 'README.md']) assert.ok(files.includes(entry), `Missing ${entry}`);
assert.ok(!files.some(p => /^(src|test|node_modules|\.artifacts)\//.test(p)));
const prefix = resolve(root, 'installed');
execFileSync('npm', ['install', '--prefix', prefix, resolve(root, packed.filename), '--ignore-scripts', '--omit=dev', '--offline', '--no-audit', '--no-fund', '--cache', resolve(root, 'npm-cache')], { stdio: 'inherit' });
const installed = resolve(prefix, 'node_modules/opencode-turn-usage');
const api = await import(pathToFileURL(resolve(installed, 'dist/accounting.js')).href);
assert.equal(typeof api.summarize, 'function');
// Host-supplied modules resolve from the development SDK for this isolated package test only.
// No plugin registration, running OpenCode server, or model is involved.
execFileSync(process.execPath, ['--conditions=browser', '--import', 'tsx', '--test', 'test/gui.test.ts', 'test/tui.test.ts'], { stdio: 'inherit', env: { ...process.env, OPENCODE_TURN_USAGE_PACKAGE_ROOT: installed } });
const evidence = { package: packed.filename, files, sha256: createHash('sha256').update(readFileSync(resolve(root, packed.filename))).digest('hex'), installed, status: 'offline package installation passed' };
writeFileSync(resolve(root, 'package-check.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
