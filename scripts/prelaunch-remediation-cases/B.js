'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const root = path.resolve(__dirname, '../..');
function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mall-setup-test-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(root, 'scripts/setup.sh'), path.join(dir, 'scripts/setup.sh'));
  fs.mkdirSync(path.join(dir, 'miniprogram'));
  fs.writeFileSync(path.join(dir, 'project.config.json'), JSON.stringify({ appid: options.badConfig ? '' : 'wx0000000000000001' }));
  fs.writeFileSync(path.join(dir, 'cloudbaserc.json'), JSON.stringify({ envId: 'fixture-env', functions: [{ name: 'fixture' }] }));
  fs.writeFileSync(path.join(dir, 'miniprogram/app.js'), "const config = { envId: 'fixture-env' };\n");
  const fn = path.join(dir, 'cloudfunctions/fixture');
  fs.mkdirSync(fn, { recursive: true });
  const dependencies = { 'wx-server-sdk': '2.6.3', 'fixture-extra': '1.0.0' };
  fs.writeFileSync(path.join(fn, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies, ...(options.overrideMismatch ? { overrides: { 'fixture-extra': '9.0.0' } } : {}) }));
  const packages = { '': { name: 'fixture', version: '1.0.0', dependencies: { ...dependencies } } };
  for (const [name, version] of Object.entries(dependencies)) {
    packages['node_modules/' + name] = { version };
    if (options.missing === name) continue;
    const pkg = path.join(fn, 'node_modules', name);
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name, version: options.wrong === name ? '9.0.0' : version, main: 'index.js' }));
    if (options.missingEntry !== name) fs.writeFileSync(path.join(pkg, 'index.js'), 'module.exports = {};\n');
  }
  if (options.requiredMarker === 'dev') packages['node_modules/wx-server-sdk'].dev = true;
  if (options.requiredMarker === 'foreign-optional') Object.assign(packages['node_modules/wx-server-sdk'], { optional: true, os: [process.platform === 'linux' ? 'darwin' : 'linux'] });
  if (options.optionalPlatform) packages['node_modules/optional-fixture'] = { version: '1.0.0', optional: true, os: [options.optionalPlatform === 'other' ? (process.platform === 'linux' ? 'darwin' : 'linux') : process.platform], cpu: [process.arch] };
  if (options.lockMismatch) packages[''].dependencies['wx-server-sdk'] = '3.0.4';
  fs.writeFileSync(path.join(fn, 'package-lock.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, packages }));
  if (options.missingLock) fs.unlinkSync(path.join(fn, 'package-lock.json'));
  if (options.malformedLock) fs.writeFileSync(path.join(fn, 'package-lock.json'), '{invalid');
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\necho invoked > "' + path.join(dir, 'npm-called') + '"\nexit 73\n', { mode: 0o755 });
  function snapshot() {
    const entries = [];
    function walk(base) { for (const name of fs.readdirSync(base).sort()) { const p = path.join(base, name); const s = fs.statSync(p); if (s.isDirectory()) walk(p); else entries.push([path.relative(dir, p), fs.readFileSync(p).toString('base64')]); } }
    walk(dir); return JSON.stringify(entries);
  }
  return { dir, snapshot, run(check = true) { return cp.spawnSync('bash', [path.join(dir, 'scripts/setup.sh'), ...(check ? ['--check'] : []), '--root', dir], { cwd: dir, encoding: 'utf8', timeout: 30000, env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } }); }, cleanup() { fs.rmSync(dir, { recursive: true, force: true }); } };
}
function setupCase(id, options, pass, install = false) {
  return { id, issue: 'R4-D02', run: async () => { const f = fixture(options); try { const before = f.snapshot(); const r = f.run(!install); assert.ifError(r.error); if (pass) assert.equal(r.status, 0, r.stdout + r.stderr); else assert.notEqual(r.status, 0, r.stdout + r.stderr); if (!install) assert.equal(f.snapshot(), before, '--check must not change files or invoke npm'); else assert.ok(fs.existsSync(path.join(f.dir, 'npm-called')), 'controlled npm install failure executed'); } finally { f.cleanup(); } } };
}
module.exports = [
  { id: 'R4-D01-all-function-locks-exact', issue: 'R4-D01', run: async () => {
    for (const name of fs.readdirSync(path.join(root, 'cloudfunctions'))) {
      const dir = path.join(root, 'cloudfunctions', name);
      if (!fs.existsSync(path.join(dir, 'package.json'))) continue;
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json')));
      assert.equal(pkg.dependencies['wx-server-sdk'], '2.6.3', name);
      const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json')));
      assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies, name);
      assert.deepEqual(pkg.overrides, { typescript: '5.9.3' }, name);
      assert.equal(lock.packages['node_modules/typescript'].version, '5.9.3', name);
      for (const [dep, version] of Object.entries(pkg.dependencies)) { assert.match(version, /^\d+\.\d+\.\d+$/, name + ':' + dep); assert.equal(lock.packages['node_modules/' + dep].version, version, name + ':' + dep); }
    }
  } },
  setupCase('R4-D02-valid', {}, true),
  setupCase('R4-D02-missing-sdk', { missing: 'wx-server-sdk' }, false),
  setupCase('R4-D02-missing-other-direct-dependency', { missing: 'fixture-extra' }, false),
  setupCase('R4-D02-wrong-installed-version', { wrong: 'wx-server-sdk' }, false),
  setupCase('R4-D02-required-wrong-version-marked-dev', { wrong: 'wx-server-sdk', requiredMarker: 'dev' }, false),
  setupCase('R4-D02-required-wrong-version-marked-foreign-optional', { wrong: 'wx-server-sdk', requiredMarker: 'foreign-optional' }, false),
  setupCase('R4-D02-lock-conflict', { lockMismatch: true }, false),
  setupCase('R4-D02-foreign-optional-platform', { optionalPlatform: 'other' }, true),
  setupCase('R4-D02-missing-current-platform-optional', { optionalPlatform: 'current' }, false),
  setupCase('R4-D02-missing-entry', { missingEntry: 'fixture-extra' }, false),
  setupCase('R4-D02-missing-lock', { missingLock: true }, false),
  setupCase('R4-D02-malformed-lock', { malformedLock: true }, false),
  setupCase('R4-D02-override-lock-mismatch', { overrideMismatch: true }, false),
  setupCase('R4-D02-invalid-config', { badConfig: true }, false),
  setupCase('R4-D02-controlled-install-failure', { missing: 'wx-server-sdk' }, false, true)
];
