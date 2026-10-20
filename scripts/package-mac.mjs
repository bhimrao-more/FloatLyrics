// Builds dist/FloatLyrics-darwin-<arch>/FloatLyrics.app with the CD icon, ad-hoc signed so it runs locally.
//   npm run package            then drag the app into /Applications (or: npm run package -- --install)
import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const [out] = await packager({
  dir: ROOT,
  name: 'FloatLyrics',
  platform: 'darwin',
  arch: process.arch,
  out: path.join(ROOT, 'dist'),
  overwrite: true,
  asar: false, // the Now Playing adapter is run by /usr/bin/perl, which needs real files on disk
  icon: path.join(ROOT, 'app', 'assets', 'icon.icns'),
  appBundleId: 'io.github.bhimrao-more.floatlyrics',
  appCategoryType: 'public.app-category.music',
  appVersion: pkg.version,
  appCopyright: 'Copyright © 2026 Bhimrao More. MIT License.',
  ignore: [/^\/(dist|test|docs|scripts)(\/|$)/, /^\/\.git/, /^\/extension\/(manifest\.json|probe\.js|content\.js|background\.js)$/],
});
const appPath = path.join(out, 'FloatLyrics.app');

// Packaging edits the bundle, so re-seal it with an ad-hoc signature (enough to run on this Mac).
execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
console.log(`built ${appPath}`);

if (process.argv.includes('--install')) {
  const dest = '/Applications/FloatLyrics.app';
  fs.rmSync(dest, { recursive: true, force: true });
  execFileSync('ditto', [appPath, dest]);
  console.log(`installed ${dest}`);
}
