'use strict';

require('./lib/payment-test-network');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { AsyncLocalStorage } = require('async_hooks');

// Child Node processes must receive the same preload before loading any SDK.
const guardPath = require.resolve('./lib/payment-test-network');
const inheritedOptions = process.env.NODE_OPTIONS || '';
if (!inheritedOptions.includes(guardPath)) {
  process.env.NODE_OPTIONS = (inheritedOptions + ' --require=' + JSON.stringify(guardPath)).trim();
}

// Count executed assertions rather than author-declared counts or case labels.
// Cases use assert/strict member methods; a callable assert() alone is not counted.
const assertionContext = new AsyncLocalStorage();
for (const api of [require('assert'), assert]) {
  for (const key of ['ok', 'equal', 'notEqual', 'deepEqual', 'notDeepEqual', 'strictEqual',
    'notStrictEqual', 'deepStrictEqual', 'notDeepStrictEqual', 'throws', 'doesNotThrow',
    'rejects', 'doesNotReject', 'match', 'doesNotMatch', 'ifError', 'fail']) {
    const original = api[key];
    if (typeof original !== 'function') continue;
    api[key] = function (...args) {
      const context = assertionContext.getStore();
      if (context) context.assertions++;
      return original.apply(this, args);
    };
  }
}

const registry = {
  A: { batch: 'P1', issues: ['R1-001', 'R4-S01', 'R4-S02', 'R4-S03', 'R4-S05'] },
  B: { batch: 'P6', issues: ['R4-D01', 'R4-D02'] },
  C: { batch: 'P5', issues: ['R4-C04', 'R4-C05'] },
  D: { batch: 'P4', issues: ['R3-003'] },
  E: { batch: 'P2', issues: ['R1-005', 'R2-001', 'R4-S06', 'R4-C01', 'R4-C02'] },
  F: { batch: 'P3', issues: ['R1-002', 'R1-003', 'R1-004', 'R1-006', 'R1-007'] },
  G: { batch: 'P5', issues: ['R2-002', 'R4-S04', 'R4-S07'], contractIssues: ['R1-002'] },
  H: { batch: 'P4', issues: ['R3-001', 'R3-002'], contractIssues: ['R3-003'] }
};

function validateCases(stream, items, ids = new Set()) {
  const entry = registry[stream];
  assert.ok(entry, 'Unknown stream');
  assert.ok(Array.isArray(items) && items.length > 0, 'Empty required test module: ' + stream);
  const cases = [];
  for (const item of items) {
    assert.ok(item && typeof item.id === 'string' && typeof item.run === 'function', 'Invalid case');
    assert.ok(!ids.has(item.id), 'Duplicate case: ' + item.id);
    ids.add(item.id);
    assert.ok(item.contractOnly === undefined || typeof item.contractOnly === 'boolean', 'Invalid contractOnly flag');
    const issues = Array.isArray(item.issues) ? item.issues : [item.issue];
    const allowed = item.contractOnly === true ? (entry.contractIssues || []) : entry.issues;
    assert.ok(issues.length && issues.every(issue => allowed.includes(issue)), 'Case issue outside stream');
    cases.push({ ...item, stream, issues, contractOnly: item.contractOnly === true });
  }
  for (const issue of entry.issues) {
    assert.ok(cases.some(item => !item.contractOnly && item.issues.includes(issue)), 'Missing issue cases: ' + issue);
  }
  return cases;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--self-check') {
    const { createHarness } = require('./lib/prelaunch-remediation-fixture');
    const h = createHarness();
    assert.throws(() => require('https').request('https://fixture.invalid'), { code: 'TEST_NETWORK_FORBIDDEN' });
    h.tables().products.push({ _id: 'fixture-product', stock: 1 });
    await assert.rejects(h.db.runTransaction(async tx => {
      await tx.collection('products').doc('fixture-product').update({ data: { stock: 9 } });
      throw new Error('fixture rollback');
    }), /fixture rollback/);
    assert.equal(h.tables().products[0].stock, 1);
    h.tables().products[0].oldRole = 'owner';
    await h.db.collection('products').doc('fixture-product').set({ data: { stock: 2 } });
    assert.equal(h.tables().products[0].oldRole, undefined, 'doc.set replaces old fields');
    assert.equal(h.tables().products[0]._id, 'fixture-product');
    const child = require('child_process').execFileSync(process.execPath, ['-e',
      "const request=require('https').request; if(request.name!=='deny')process.exit(3); try { request('https://fixture.invalid'); process.exitCode=1; } catch (e) { if(e.code!=='TEST_NETWORK_FORBIDDEN') process.exitCode=2; }"], { encoding: 'utf8' });
    assert.equal(child, '');
    h.tables().orders = [{ _id: 'array-order', items: [
      { productId: 'product-a', spec: 'small' }, { productId: 'product-b', spec: 'large' }
    ] }, { _id: 'empty-order', items: [] }];
    const dotted = await h.db.collection('orders').where({ 'items.productId': 'product-b' }).get();
    assert.deepEqual(dotted.data.map(row => row._id), ['array-order']);
    const crossElement = await h.db.collection('orders').where({
      items: h.db.command.elemMatch({ productId: 'product-a', spec: 'large' })
    }).get();
    assert.equal(crossElement.data.length, 0, 'elemMatch binds both fields to the same item');
    const sameElement = await h.db.collection('orders').where({
      items: h.db.command.elemMatch({ productId: 'product-b', spec: 'large' })
    }).get();
    assert.equal(sameElement.data.length, 1);
    const primaryIssues = Object.values(registry).flatMap(x => x.issues);
    assert.equal(primaryIssues.length, 25);
    assert.equal(new Set(primaryIssues).size, 25, 'Primary issue ownership must remain unique');
    const validG = registry.G.issues.map((issue, i) => ({ id: 'primary-' + i, issue, run() {} }));
    const contract = { id: 'contract', issue: 'R1-002', contractOnly: true, run() {} };
    assert.equal(validateCases('G', [...validG, contract]).filter(item => item.contractOnly).length, 1);
    assert.throws(() => validateCases('G', [contract]), /Missing issue cases/);
    assert.throws(() => validateCases('G', [...validG, { ...contract, contractOnly: false }]), /outside stream/);
    assert.throws(() => validateCases('G', [...validG, { ...contract, issue: 'R3-003' }]), /outside stream/);
    assert.throws(() => validateCases('G', [...validG, { ...contract, contractOnly: 'true' }]), /Invalid contractOnly/);
    let injectedCalls = 0;
    const injected = createHarness({ transferClient: {
      getTransferClientConfig: () => ({ mchId: 'test-merchant', appId: 'test-app' }),
      genOutBillNo: () => 'TEST-INJECTED-BILL',
      isBillNotExistError: () => false,
      initiateTransfer: async params => {
        injectedCalls++;
        return { state: 'WAIT_USER_CONFIRM', outBillNo: params.outBillNo };
      },
      queryBill: async () => { throw new Error('Unexpected injected query'); }
    } });
    const application = await injected.apply();
    assert.equal(application.success, true);
    assert.equal((await injected.approve(application.withdrawalId)).transferInitiated, true);
    assert.equal(injectedCalls, 1, 'Explicit client reaches actual admin withdrawal service');
    assert.equal(injected.transferCalls.length, 0, 'Default transfer fake was not used');
    console.log('PASS foundation: network denied, serial transaction rollback, 25 issue registry');
    return;
  }
  let streams;
  if (args.length === 1 && args[0] === '--all') streams = Object.keys(registry);
  else if (args.length === 2 && args[0] === '--batch') {
    streams = Object.keys(registry).filter(key => registry[key].batch === args[1]);
  } else if (args.length === 2 && args[0] === '--stream' && registry[args[1]]) streams = [args[1]];
  else throw new Error('Usage: --all | --batch P1/P2/P3/P4/P5/P6 | --stream A..H | --self-check');
  assert.ok(streams.length, 'Unknown or empty batch');
  const cases = [];
  const ids = new Set();
  for (const stream of streams) {
    const filename = path.join(__dirname, 'prelaunch-remediation-cases', stream + '.js');
    assert.ok(fs.existsSync(filename), 'Missing required test module: ' + stream);
    const items = require(filename);
    cases.push(...validateCases(stream, items, ids));
  }
  const results = [];
  for (const item of cases) {
    const context = { assertions: 0 };
    try {
      await assertionContext.run(context, () => item.run());
      assert.ok(context.assertions > 0, 'Case executed no counted assert/strict member assertions');
      results.push({ id: item.id, issues: item.issues, stream: item.stream, contractOnly: item.contractOnly,
        status: 'PASS', assertions: context.assertions });
      console.log('PASS', item.id);
    } catch (error) {
      results.push({ id: item.id, issues: item.issues, stream: item.stream, contractOnly: item.contractOnly, status: 'FAIL',
        assertions: context.assertions, assertionFailure: error.code === 'ERR_ASSERTION', error: error.stack });
      console.error('FAIL', item.id, error.stack);
    }
  }
  const summary = { total: results.length, case_total: results.length,
    assertions: results.reduce((sum, item) => sum + item.assertions, 0),
    passed: results.filter(x => x.status === 'PASS').length,
    failed: results.filter(x => x.status === 'FAIL').length,
    toolErrors: results.filter(x => x.status === 'FAIL' && !x.assertionFailure).length, results };
  console.log(JSON.stringify(summary, null, 2));
  if (summary.failed) process.exitCode = 1;
}

if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { registry, main, validateCases };
