import fs from 'fs';
import process from 'process';
import bundleSource from '@agoric/bundle-source';

import url from 'url';
import path from 'path';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const { source, sourceMap } = await bundleSource(
    `${__dirname}/../src/kernel/index.js`,
  );
  const actualSource = `export default ${source}\n${sourceMap}`;
  const f = await fs.promises.open('src/bundles/kernel', 'w', 0o644);
  await f.write(actualSource);
  await f.close();
}

main().then(
  _ => process.exit(0),
  err => {
    console.log('error creating src/bundles/kernel:');
    console.log(err);
    process.exit(1);
  },
);
