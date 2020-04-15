// eslint-disable-next-line no-redeclare
/* global setImmediate */
import { test } from 'tape-promise/tape';
import harden from '@agoric/harden';

import { producePromise } from '@agoric/produce-promise';
import { makeLiveSlots } from '../src/kernel/liveSlots';

function capdata(body, slots = []) {
  return harden({ body, slots });
}

function capargs(args, slots = []) {
  return capdata(JSON.stringify(args), slots);
}

function buildSyscall() {
  const log = [];

  const syscall = {
    send(targetSlot, method, args, resultSlot) {
      log.push({ type: 'send', targetSlot, method, args, resultSlot });
    },
    subscribe(target) {
      log.push({ type: 'subscribe', target });
    },
    fulfillToPresence(promiseID, slot) {
      log.push({ type: 'fulfillToPresence', promiseID, slot });
    },
    fulfillToData(promiseID, data) {
      log.push({ type: 'fulfillToData', promiseID, data });
    },
    reject(promiseID, data) {
      log.push({ type: 'reject', promiseID, data });
    },
  };

  return { log, syscall };
}

function endOfCrank() {
  return new Promise(resolve => setImmediate(() => resolve()));
}

function hush(p) {
  p.then(
    () => undefined,
    () => undefined,
  );
}

// The next batch of tests exercises how liveslots handles promise
// identifiers ("vpid" strings) across various forms of resolution. Our
// current code never retires vpids, but an upcoming storage-performance
// improvement will retire them after resolution.

// legend:
//  C: vat creates promise
//  S: vat sends promise as argument
//  T: vat includes promise as result= of outbound message
//  R: vat receives promise as result= of inbound message
//  G: vat gets promise as argument
//  M: vat sends message to the promise
//  RES: vat resolves promise
//  NOT: vat receives notification of external resolution

// We start by examining cases where the vat resolves the promise (RES) and
// then uses the promise a second time, as a way to probe the liveslots
// tables and see whether they retire the vpid or not. To resolve the
// promise, the vat must be the decider, which means it must have either
// created the promise originally (and sent it as an argument), or received
// it as the result= of an inbound message. To use it a second time, it must
// either create the promise or receive it as an argument. We use the
// following sequences to try and cover lots of cases:
//
// 0: C        RES S S // TODO
// 1: C    S   RES S
// 2: R G  S M RES S M: p1=bob~.one(); bob~.two(p1)
// 3: G R  S M RES S M (liveslots can respond to this, but could not produce it)

// Then we look at cases where the kernel resolves the promise (NOT), after
// which the vat sends the promise a second time. For the kernel to be the
// decider, the promise must have arrived from the kernel, or the vat must
// have sent it as the result= of an outbound message. To use it a second
// time, the vat must have either received the promise as an argument, or
// created the promise and sent it as an argument. We use the following
// sequences:
//
// 4: G     S M NOT S M: bar~.foo(p1); p1~.foo()
// 5: CT    S M NOT S M: p1=remote~.get(); bar~.foo(p1); p1~.foo()
// 6: CT G  S M NOT S M: (liveslots can respond to this but not produce it)
// HOWEVER: we cannot actually do 5 or 6 because of the way HandledPromises
// protect against reentrant handlers. For details see
// https://github.com/Agoric/agoric-sdk/issues/886

// In addition, we want to exercise the promises being resolved in three
// different ways:
//   X: resolveToPresence, messages can be sent to resolution
//   Y: resolveToData, messages are rejected as DataIsNotCallable
//   Z: reject, messages are rejected

function resolvePR(pr, mode) {
  const target2 = harden({});
  switch (mode) {
    case 'presence':
      pr.resolve(target2);
      break;
    case 'data':
      pr.resolve(4);
      break;
    case 'reject':
      pr.reject('error');
      break;
    default:
      throw Error(`unknown mode ${mode}`);
  }
}

function resolutionOf(vpid, mode, target2) {
  switch (mode) {
    case 'presence':
      return {
        type: 'fulfillToPresence',
        promiseID: vpid,
        slot: target2,
      };
    case 'data':
      return {
        type: 'fulfillToData',
        promiseID: vpid,
        data: capargs(4, []),
      };
    case 'reject':
      return {
        type: 'reject',
        promiseID: vpid,
        data: capargs('error', []),
      };
    default:
      throw Error(`unknown mode ${mode}`);
  }
}

async function doVatResolveCase1(t, mode) {
  // case 1
  const { log, syscall } = buildSyscall();

  function build(E) {
    const pr = producePromise();
    return harden({
      async run(target1) {
        const p1 = pr.promise;
        E(target1).one(p1);
        resolvePR(pr, mode);
        // TODO: this stall shouldn't be necessary, but if I omit it, the
        // fulfillToPresence happens *after* two() is sent
        await Promise.resolve();
        E(target1).two(p1);
      },
    });
  }
  const dispatch = makeLiveSlots(syscall, {}, build, 'vatA');
  t.deepEqual(log, []);

  const slot0arg = { '@qclass': 'slot', index: 0 };
  const rootA = 'o+0';
  const target1 = 'o-1';
  const expectedP1 = 'p+5';
  const expectedP2 = 'p+6';
  const expectedP3 = 'p+7';
  const expectedP4 = 'p+8';
  const target2 = 'o+1';

  dispatch.deliver(rootA, 'run', capargs([slot0arg], [target1]));
  await endOfCrank();

  // The vat should send 'one' and subscribe to the result promise
  t.deepEqual(log.shift(), {
    type: 'send',
    targetSlot: target1,
    method: 'one',
    args: capargs([slot0arg], [expectedP1]),
    resultSlot: expectedP2,
  });
  t.deepEqual(log.shift(), { type: 'subscribe', target: expectedP2 });

  // next the vat should resolve the promise it created
  t.deepEqual(log.shift(), resolutionOf(expectedP1, mode, target2));

  // then it should send 'two'. For now it should cite the same promise ID,
  // but in the future that vpid will have been retired, and we should see a
  // different one
  t.deepEqual(log.shift(), {
    type: 'send',
    targetSlot: target1,
    method: 'two',
    args: capargs([slot0arg], [expectedP3]),
    resultSlot: expectedP4,
  });
  t.deepEqual(log.shift(), { type: 'subscribe', target: expectedP4 });
  t.deepEqual(log.shift(), resolutionOf(expectedP3, mode, target2));
  t.deepEqual(log, []);

  t.end();
}

test('liveslots vpid handling case1 presence', async t => {
  await doVatResolveCase1(t, 'presence');
});

test('liveslots vpid handling case1 data', async t => {
  await doVatResolveCase1(t, 'data');
});

test('liveslots vpid handling case1 reject', async t => {
  await doVatResolveCase1(t, 'reject');
});

async function doVatResolveCase23(t, which, mode) {
  // case 2 and 3
  const { log, syscall } = buildSyscall();

  function build(E) {
    let p1;
    const pr = producePromise();
    return harden({
      async promise(p) {
        p1 = p;
      },
      async result() {
        return pr.promise;
      },
      async run(target1) {
        const p2 = E(target1).one(p1);
        hush(p2);
        const p3 = E(p1).two();
        hush(p3);
        resolvePR(pr, mode);
        // TODO: even worse, we need two stalls here to get the resolution
        // into the kernel before the subsequent message sends. why??
        await Promise.resolve();
        await Promise.resolve();
        const p4 = E(target1).three(p1);
        hush(p4);
        const p5 = E(p1).four();
        hush(p5);
      },
    });
  }
  const dispatch = makeLiveSlots(syscall, {}, build, 'vatA');
  t.deepEqual(log, []);

  const slot0arg = { '@qclass': 'slot', index: 0 };
  const rootA = 'o+0';
  const target1 = 'o-1';
  const p1 = 'p-8';
  const expectedP2 = 'p+5';
  const expectedP3 = 'p+6';
  const expectedP4 = 'p+7';
  const expectedP5 = 'p+8';
  const expectedP6 = 'p+9';
  const target2 = 'o+1';

  if (which === 2) {
    dispatch.deliver(rootA, 'result', capargs([], []), p1);
    dispatch.deliver(rootA, 'promise', capargs([slot0arg], [p1]));
  } else if (which === 3) {
    dispatch.deliver(rootA, 'promise', capargs([slot0arg], [p1]));
    dispatch.deliver(rootA, 'result', capargs([], []), p1);
  } else {
    throw Error(`bad which=${which}`);
  }
  await endOfCrank();
  t.deepEqual(log.shift(), { type: 'subscribe', target: p1 });
  t.deepEqual(log, []);

  dispatch.deliver(rootA, 'run', capargs([slot0arg], [target1]));
  await endOfCrank();

  // first the vat sends one() with the promise
  t.deepEqual(log.shift(), {
    type: 'send',
    targetSlot: target1,
    method: 'one',
    args: capargs([slot0arg], [p1]),
    resultSlot: expectedP2,
  });
  t.deepEqual(log.shift(), { type: 'subscribe', target: expectedP2 });

  // then the vat pipelines 'two' to the promise we gave them
  t.deepEqual(log.shift(), {
    type: 'send',
    targetSlot: p1,
    method: 'two',
    args: capargs([], []),
    resultSlot: expectedP3,
  });
  t.deepEqual(log.shift(), { type: 'subscribe', target: expectedP3 });

  // then it resolves p1, which was used as the result of rootA~.result()
  t.deepEqual(log.shift(), resolutionOf(p1, mode, target2));

  // now it sends three() with the promise. For now, we expect the same vpid
  // as before.

  t.deepEqual(log.shift(), {
    type: 'send',
    targetSlot: target1,
    method: 'three',
    args: capargs([slot0arg], [expectedP4]),
    resultSlot: expectedP5,
  });
  t.deepEqual(log.shift(), { type: 'subscribe', target: expectedP5 });

  t.deepEqual(log.shift(), {
    type: 'send',
    targetSlot: p1,
    method: 'four',
    args: capargs([], []),
    resultSlot: expectedP6,
  });
  t.deepEqual(log.shift(), { type: 'subscribe', target: expectedP6 });
  t.deepEqual(log.shift(), resolutionOf(expectedP4, mode, target2));

  // that should be the last of the syscalls
  t.deepEqual(log, []);

  t.end();
}

test('liveslots vpid handling case2 presence', async t => {
  await doVatResolveCase23(t, 2, 'presence');
});

test('liveslots vpid handling case2 data', async t => {
  await doVatResolveCase23(t, 2, 'data');
});

test('liveslots vpid handling case2 reject', async t => {
  await doVatResolveCase23(t, 2, 'reject');
});

test('liveslots vpid handling case3 presence', async t => {
  await doVatResolveCase23(t, 3, 'presence');
});

test('liveslots vpid handling case3 data', async t => {
  await doVatResolveCase23(t, 3, 'data');
});

test('liveslots vpid handling case3 reject', async t => {
  await doVatResolveCase23(t, 3, 'reject');
});

async function doVatResolveCase4(t, mode) {
  const { log, syscall } = buildSyscall();

  function build(E) {
    let p1;
    return harden({
      async get(p) {
        p1 = p;
      },
      async first(target1) {
        const p2 = E(target1).one(p1);
        hush(p2);
        const p3 = E(p1).two();
        hush(p3);
      },
      async second(target1) {
        const p4 = E(target1).three(p1);
        hush(p4);
        const p5 = E(p1).four();
        hush(p5);
      },
    });
  }
  const dispatch = makeLiveSlots(syscall, {}, build, 'vatA');
  t.deepEqual(log, []);

  const slot0arg = { '@qclass': 'slot', index: 0 };
  const rootA = 'o+0';
  const target1 = 'o-1';
  const p1 = 'p-8';
  let nextPnum = 5;
  function nextP() {
    const p = `p+${nextPnum}`;
    nextPnum += 1;
    return p;
  }
  const target2 = 'o-2';

  dispatch.deliver(rootA, 'get', capargs([slot0arg], [p1]));
  await endOfCrank();
  t.deepEqual(log.shift(), { type: 'subscribe', target: p1 });
  t.deepEqual(log, []);

  dispatch.deliver(rootA, 'first', capargs([slot0arg], [target1]));
  await endOfCrank();

  const expectedP2 = nextP();
  t.deepEqual(log.shift(), {
    type: 'send',
    targetSlot: target1,
    method: 'one',
    args: capargs([slot0arg], [p1]),
    resultSlot: expectedP2,
  });
  t.deepEqual(log.shift(), { type: 'subscribe', target: expectedP2 });

  const expectedP3 = nextP();
  t.deepEqual(log.shift(), {
    type: 'send',
    targetSlot: p1,
    method: 'two',
    args: capargs([], []),
    resultSlot: expectedP3,
  });
  t.deepEqual(log.shift(), { type: 'subscribe', target: expectedP3 });
  t.deepEqual(log, []);

  if (mode === 'presence') {
    dispatch.notifyFulfillToPresence(p1, target2);
  } else if (mode === 'data') {
    dispatch.notifyFulfillToData(p1, capargs(4, []));
  } else if (mode === 'reject') {
    dispatch.notifyReject(p1, capargs('error', []));
  } else {
    throw Error(`unknown mode ${mode}`);
  }
  await endOfCrank();
  t.deepEqual(log, []);

  dispatch.deliver(rootA, 'second', capargs([slot0arg], [target1]));
  await endOfCrank();

  const expectedP4 = nextP();
  const expectedP5 = nextP();
  t.deepEqual(log.shift(), {
    type: 'send',
    targetSlot: target1,
    method: 'three',
    args: capargs([slot0arg], [expectedP4]),
    resultSlot: expectedP5,
  });
  t.deepEqual(log.shift(), { type: 'subscribe', target: expectedP5 });

  if (mode === 'presence') {
    const expectedP6 = nextP();
    t.deepEqual(log.shift(), {
      type: 'send',
      targetSlot: target2,
      method: 'four',
      args: capargs([], []),
      resultSlot: expectedP6,
    });
    t.deepEqual(log.shift(), { type: 'subscribe', target: expectedP6 });
  }
  t.deepEqual(log.shift(), resolutionOf(expectedP4, mode, target2));
  t.deepEqual(log, []);

  t.end();
}

test('liveslots vpid handling case4 presence', async t => {
  await doVatResolveCase4(t, 'presence');
});

test('liveslots vpid handling case4 data', async t => {
  await doVatResolveCase4(t, 'data');
});

test('liveslots vpid handling case4 reject', async t => {
  await doVatResolveCase4(t, 'reject');
});

// cases 5 and 6 are not implemented due to #886
