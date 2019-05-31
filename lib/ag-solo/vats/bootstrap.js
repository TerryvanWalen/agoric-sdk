import harden from '@agoric/harden';

// this will fail until `ag-solo set-gci-ingress` has been run to update
// gci.js
import { GCI } from './gci';

console.log(`loading bootstrap.js`);

export default function setup(syscall, state, helpers) {
  return helpers.makeLiveSlots(
    syscall,
    state,
    (E, D) =>
      harden({
        async bootstrap(argv, vats, devices) {
          console.log('bootstrap() called');
          D(devices.mailbox).registerInboundHandler(vats.vattp);
          await E(vats.vattp).registerMailboxDevice(devices.mailbox);
          await E(vats.comms).init(vats.vattp);

          const h = await E(vats.http).getInboundHandler();
          await E(vats.comms).addEgress('http', 1, h);
          const hp = await E(vats.comms).addIngress('http', 10);
          await E(vats.http).setHTTPPresence(hp);

          if (GCI) {
            E(vats.comms).addIngress(GCI, 1)
              .then(p => E(vats.http).setChainPresence(p));
          }

          const m = await E(vats.mint).makeMint();
          const purse1 = await E(m).mint(100, 'purse1');
          const home = harden({ mint: m, purse: purse1 });
          await E(vats.http).setHomeObjects(home);

          /*
          const purse1 = await E(vats.comms).addIngress(GCI, 1);
          console.log('all vats initialized, sending getBalance');
          const balance = await E(purse1).getBalance();
          console.log(`balance was ${balance}`);
          console.log(`++ DONE`);
          */
        },
      }),
    helpers.vatID,
  );
}