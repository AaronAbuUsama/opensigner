import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const sampleRoot = fileURLToPath(new URL('../../../iframe/sample/', import.meta.url));
const result = await build({
  absWorkingDir: packageRoot, entryPoints: ['src/index.ts'], bundle: true,
  format: 'iife', globalName: 'StellarSigner', platform: 'browser', target: 'es2022',
  outfile: resolve(sampleRoot, 'stellar-signer.js'), metafile: true,
});
mkdirSync(resolve(sampleRoot, 'licenses'), { recursive: true });
const roots = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const filename = resolve(packageRoot, input);
  const marker = filename.lastIndexOf(`${sep}node_modules${sep}`);
  if (marker < 0) continue;
  const prefix = filename.slice(0, marker + '/node_modules/'.length);
  const parts = filename.slice(prefix.length).split(sep);
  const name = parts.slice(0, parts[0].startsWith('@') ? 2 : 1).join(sep);
  const root = resolve(prefix, name);
  if (roots.has(root)) continue;
  roots.add(root);
  for (const file of readdirSync(root).filter(file => /^(licen[sc]e|notice)(\..*)?$/i.test(file))) {
    copyFileSync(resolve(root, file), resolve(sampleRoot, 'licenses', `${name.replaceAll(sep, '-')}-${file}`));
  }
}
copyFileSync(fileURLToPath(new URL('../../../LICENSE', import.meta.url)), resolve(sampleRoot, 'LICENSE'));
