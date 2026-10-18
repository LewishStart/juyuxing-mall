#!/bin/bash
set -eu

# Deployment prerequisites. --check is strictly read-only; --root permits an
# explicitly selected checkout/fixture. Default root is this script's project.
MODE="install"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --root) [ "$#" -ge 2 ] || { echo "--root requires a directory" >&2; exit 2; }; ROOT="$2"; shift 2 ;;
    *) echo "Usage: setup.sh [--check] [--root directory]" >&2; exit 2 ;;
  esac
done
node - "$ROOT" "$MODE" <<'NODE'
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const root = fs.realpathSync(path.resolve(process.argv[2]));
const mode = process.argv[3];
function json(filename) { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
function fail(message) { throw new Error(message); }
function plan(dir) {
  const pkg = json(path.join(dir, 'package.json'));
  const lock = json(path.join(dir, 'package-lock.json'));
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages || !lock.packages['']) fail('Missing supported package lock');
  const deps = pkg.dependencies || {};
  const lockedDeps = lock.packages[''].dependencies || {};
  if (!Object.keys(deps).length) fail('No runtime dependencies declared');
  if (JSON.stringify(Object.entries(deps).sort()) !== JSON.stringify(Object.entries(lockedDeps).sort())) fail('Manifest/lock root dependency mismatch');
  if (pkg.name !== lock.name || pkg.version !== lock.version) fail('Manifest/lock identity mismatch');
  for (const [name, version] of Object.entries(deps)) {
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) fail('Runtime dependency must be pinned: ' + name);
    if (!lock.packages['node_modules/' + name] || lock.packages['node_modules/' + name].version !== version) fail('Locked dependency version mismatch: ' + name);
  }
  for (const [name, version] of Object.entries(pkg.overrides || {})) {
    if (!/^(?:@[A-Za-z0-9_-]+\/)?[A-Za-z0-9_.-]+$/.test(name) || !/^\d+\.\d+\.\d+$/.test(version)) fail('Only exact simple package overrides are supported');
    const matches = Object.entries(lock.packages).filter(([rel]) => rel === 'node_modules/' + name || rel.endsWith('/node_modules/' + name));
    if (!matches.length || matches.some(([, entry]) => entry.version !== version)) fail('Override/lock mismatch: ' + name);
  }
  return { pkg, lock };
}
function installed(dir, data) {
  for (const [rel, entry] of Object.entries(data.lock.packages)) {
    if (!rel || entry.dev) continue;
    if (entry.link || !rel.startsWith('node_modules/') || rel.split('/').includes('..')) fail('Unsupported lock entry: ' + rel);
    const matches = (list, value) => !list || (!list.includes('!' + value) && (list.every(item => item.startsWith('!')) || list.includes(value)));
    if (entry.optional && (!matches(entry.os, process.platform) || !matches(entry.cpu, process.arch))) continue;
    const meta = json(path.join(dir, rel, 'package.json'));
    if (meta.version !== entry.version) fail('Installed version differs from lock: ' + rel);
  }
  // Root production dependencies are mandatory regardless of misleading
  // dev/optional/platform flags in a damaged lock entry.
  for (const [name, version] of Object.entries(data.pkg.dependencies)) {
    const packageDir = path.join(dir, 'node_modules', name);
    if (fs.realpathSync(packageDir) !== packageDir) fail('Direct dependency path differs from function package: ' + name);
    const metadataFile = path.join(packageDir, 'package.json');
    if (fs.realpathSync(metadataFile) !== metadataFile) fail('Direct dependency metadata outside package: ' + name);
    const metadata = json(metadataFile);
    const locked = data.lock.packages['node_modules/' + name];
    if (metadata.name !== name || metadata.version !== version || metadata.version !== locked.version) fail('Direct dependency metadata differs from declaration/lock: ' + name);
    const actual = require.resolve(name, { paths: [dir] });
    if (!actual.startsWith(packageDir + path.sep)) fail('Dependency resolved outside function: ' + name);
  }
}
try {
  const project = json(path.join(root, 'project.config.json'));
  const config = json(path.join(root, 'cloudbaserc.json'));
  const app = fs.readFileSync(path.join(root, 'miniprogram/app.js'), 'utf8');
  const appEnv = app.match(/envId:\s*['"]([^'"]+)/);
  if (!/^wx[0-9a-f]{16}$/i.test(project.appid || '')) fail('Invalid AppID');
  if (!config.envId || config.envId === 'your-env-id' || !appEnv || appEnv[1] !== config.envId) fail('CloudBase environment mismatch');
  if (!Array.isArray(config.functions) || !config.functions.length) fail('No functions configured');
  const configured = config.functions.map(item => item.name);
  if (configured.some(name => !/^[A-Za-z0-9_-]+$/.test(name)) || new Set(configured).size !== configured.length) fail('Invalid/duplicate function names');
  const base = path.join(root, 'cloudfunctions');
  const names = fs.readdirSync(base).filter(name => fs.existsSync(path.join(base, name, 'package.json')));
  for (const name of configured) if (!names.includes(name)) fail('Configured function missing: ' + name);
  // Validate every lock before any install; malformed configuration cannot
  // cause a partial installation. Include undeployed local function packages.
  const plans = names.sort().map(name => ({ name, dir: path.join(base, name), data: plan(path.join(base, name)) }));
  let failed = false;
  for (const item of plans) {
    try { installed(item.dir, item.data); console.log('OK ' + item.name); }
    catch (error) {
      console.error('NOT READY ' + item.name + ': ' + error.message);
      if (mode === 'check') { failed = true; continue; }
      console.log('INSTALL ' + item.name + ': npm ci --omit=dev --ignore-scripts --no-audit --no-fund');
      const result = cp.spawnSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: item.dir, stdio: 'inherit', timeout: 300000 });
      if (result.error || result.status !== 0) { failed = true; console.error('Installation failed: ' + item.name); continue; }
      try { installed(item.dir, item.data); } catch (checkError) { failed = true; console.error('Installed tree invalid: ' + checkError.message); }
    }
  }
  if (failed) process.exitCode = 1;
  else console.log('Local configuration and locked runtime dependencies verified. No cloud deployment performed.');
} catch (error) { console.error('Setup failed: ' + error.message); process.exitCode = 1; }
NODE
