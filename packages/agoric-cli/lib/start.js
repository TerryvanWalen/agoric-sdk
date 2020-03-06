import parseArgs from 'minimist';
import path from 'path';
import chalk from 'chalk';

const FAKE_CHAIN_DELAY =
  process.env.FAKE_CHAIN_DELAY === undefined
    ? 0
    : Number(process.env.FAKE_CHAIN_DELAY);
const PORT = process.env.PORT || 8000;
const HOST_PORT = process.env.HOST_PORT || PORT;

export default async function startMain(progname, rawArgs, priv, opts) {
  const { console, error, fs, spawn, os, process } = priv;

  const pspawn = (cmd, cargs, ...rest) => {
    console.log(chalk.blueBright(cmd, ...cargs));
    return new Promise((resolve, _reject) => {
      const cp = spawn(cmd, cargs, ...rest);
      cp.on('exit', resolve);
      cp.on('error', () => resolve(-1));
    });
  };

  const exists = async file => {
    try {
      await fs.stat(file);
      return true;
    } catch (e) {
      return false;
    }
  };

  const linkHtml = async name => {
    console.log(chalk.green('linking html directories'));
    // const dappHtml = `_agstate/agoric-servers/${name}/dapp-html`;
    const htmlWallet = `_agstate/agoric-servers/${name}/html/wallet`;
    // await Promise.all([fs.unlink(dappHtml).catch(() => {}), fs.unlink(htmlWallet).catch(() => {})]);
    await Promise.all([
      // fs.symlink('../../../ui/build', dappHtml).catch(() => {}),
      fs
        .unlink(htmlWallet)
        .catch(_ => {})
        .then(_ =>
          fs.symlink('../../../../_agstate/agoric-wallet', htmlWallet),
        ),
    ]);
  };

  let agSolo;
  let agSetupSolo;
  let agServer;
  if (opts.sdk) {
    agSolo = path.resolve(__dirname, '../../cosmic-swingset/bin/ag-solo');
    agSetupSolo = path.resolve(__dirname, '../../cosmic-swingset/setup-solo');
  } else {
    agSolo = `${process.cwd()}/node_modules/@agoric/cosmic-swingset/bin/ag-solo`;
  }

  async function startFakeChain(profileName, _startArgs, popts) {
    const fakeDelay =
      popts.delay === undefined ? FAKE_CHAIN_DELAY : Number(popts.delay);
    if (!opts.sdk) {
      if (!(await exists('_agstate/agoric-servers/node_modules'))) {
        return error(`you must first run '${progname} install'`);
      }
    }

    const fakeGCI = 'myFakeGCI';
    if (!(await exists(agServer))) {
      console.log(chalk.yellow(`initializing ${profileName}`));
      await pspawn(agSolo, ['init', profileName, '--egresses=fake'], {
        stdio: 'inherit',
        cwd: '_agstate/agoric-servers',
      });
    }

    console.log(
      chalk.yellow(`setting fake chain with ${fakeDelay} second delay`),
    );
    await pspawn(
      agSolo,
      ['set-fake-chain', '--role=two_chain', `--delay=${fakeDelay}`, fakeGCI],
      {
        stdio: 'inherit',
        cwd: agServer,
      },
    );
    await linkHtml(profileName);

    if (!popts['restart']) {
      // Don't actually run the chain.
      return 0;
    }

    return pspawn(agSolo, ['start', '--role=two_client'], {
      stdio: 'inherit',
      cwd: agServer,
    });
  }

  async function startTestnetDocker(profileName, startArgs, popts) {
    const IMAGE = `agoric/cosmic-swingset-setup-solo`;

    if (popts.pull) {
      const status = await pspawn('docker', ['pull', IMAGE], {
        stdio: 'inherit',
      });
      if (status) {
        return status;
      }
    }

    const setupRun = (...bonusArgs) =>
      pspawn(
        'docker',
        [
          'run',
          `-p127.0.0.1:${HOST_PORT}:${PORT}`,
          `--volume=${process.cwd()}:/usr/src/dapp`,
          `-eAG_SOLO_BASEDIR=/usr/src/dapp/_agstate/agoric-servers/${profileName}`,
          `--rm`,
          `-it`,
          IMAGE,
          `--webport=${PORT}`,
          `--webhost=0.0.0.0`,
          ...bonusArgs,
          ...startArgs,
        ],
        {
          stdio: 'inherit',
        },
      );

    if (!(await exists(agServer))) {
      const status =
        (await setupRun('--no-restart')) || (await linkHtml(profileName));
      if (status) {
        return status;
      }
    }

    return setupRun();
  }

  async function startTestnetSdk(profileName, startArgs) {
    const virtEnv = path.resolve(
      `_agstate/agoric-servers/ve3-${os.platform()}-${os.arch()}`,
    );
    if (!(await exists(`${virtEnv}/bin/pip`))) {
      const status = await pspawn('python3', ['-mvenv', virtEnv], {
        stdio: 'inherit',
        cwd: agSetupSolo,
      });
      if (status) {
        return status;
      }
    }

    const pipRun = (...bonusArgs) =>
      pspawn(`${virtEnv}/bin/pip`, bonusArgs, {
        stdio: 'inherit',
        cwd: agSetupSolo,
      });

    if (!(await exists(`${virtEnv}/bin/wheel`))) {
      const status = await pipRun('install', 'wheel');
      if (status) {
        return status;
      }
    }

    if (!(await exists(`${virtEnv}/bin/ag-setup-solo`))) {
      const status = await pipRun('install', `--editable`, '.');
      if (status) {
        return status;
      }
    }

    const setupRun = (...bonusArgs) =>
      pspawn(
        `${virtEnv}/bin/ag-setup-solo`,
        [`--webport=${PORT}`, ...bonusArgs, ...startArgs],
        {
          stdio: 'inherit',
          env: { ...process.env, AG_SOLO_BASEDIR: agServer },
        },
      );

    if (!(await exists(agServer))) {
      const status =
        (await setupRun('--no-restart')) || (await linkHtml(profileName));
      if (status) {
        return status;
      }
    }

    return setupRun();
  }

  const profiles = {
    dev: startFakeChain,
    testnet: opts.sdk ? startTestnetSdk : startTestnetDocker,
  };

  const { _: args, ...popts } = parseArgs(rawArgs, {
    boolean: ['reset', 'restart', 'pull'],
    default: { restart: true },
  });

  const profileName = args[0] || 'dev';
  const startFn = profiles[profileName];
  if (!startFn) {
    return error(
      `unrecognized profile name ${profileName}; use one of: ${Object.keys(
        profiles,
      )
        .sort()
        .join(', ')}`,
    );
  }

  agServer = `_agstate/agoric-servers/${profileName}`;

  if (popts.reset) {
    console.log(chalk.green(`removing ${agServer}`));
    // rm is available on all the unix-likes, so use it for speed.
    await pspawn('rm', ['-rf', agServer], { stdio: 'inherit' });
  }

  return startFn(profileName, args[0] ? args.slice(1) : args, popts);
}
