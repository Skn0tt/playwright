#!/usr/bin/env node
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const BUCKET = 'https://storage.googleapis.com/chrome-for-testing-per-commit-public';
const PLATFORM = 'linux64';
const GOOD = Number(process.env.GOOD || 1639810);
const BAD = Number(process.env.BAD || 1654411);
const WORKERS = process.env.WORKERS || '32';
const ROUNDS = Number(process.env.ROUNDS || 5);
const EACH = process.env.EACH || '50';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CACHE = process.env.CACHE || path.join(os.tmpdir(), 'cft-bisect-cache');
fs.mkdirSync(CACHE, { recursive: true });

async function listRevisions(good, bad) {
  const revisions = [];
  let marker = `${PLATFORM}/r${good - 1}`;
  while (true) {
    const url = `${BUCKET}/?delimiter=/&prefix=${PLATFORM}/r&marker=${encodeURIComponent(marker)}`;
    const text = await (await fetch(url)).text();
    for (const m of text.matchAll(new RegExp(`<Prefix>${PLATFORM}/r(\\d+)/</Prefix>`, 'g'))) {
      const rev = Number(m[1]);
      if (rev >= good && rev <= bad) revisions.push(rev);
    }
    const next = text.match(/<NextMarker>([^<]+)<\/NextMarker>/);
    if (!next) break;
    marker = next[1];
    const nextRev = Number(marker.match(/r(\d+)/)?.[1] ?? NaN);
    if (nextRev > bad) break;
  }
  return [...new Set(revisions)].sort((a, b) => a - b);
}

function prepareBuild(rev) {
  const dir = path.join(CACHE, `r${rev}`);
  const marker = path.join(dir, '.ready');
  if (!fs.existsSync(marker)) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const zip = path.join(dir, 'build.zip');
    const url = `${BUCKET}/${PLATFORM}/r${rev}/chrome-headless-shell-${PLATFORM}.zip`;
    console.log(`  downloading ${url}`);
    execFileSync('curl', ['-sfL', '-o', zip, url], { stdio: 'inherit' });
    execFileSync('unzip', ['-q', zip, '-d', dir]);
    fs.rmSync(zip);
    fs.writeFileSync(marker, '');
  }
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const entry of fs.readdirSync(d)) {
      const p = path.join(d, entry);
      if (entry === 'chrome-headless-shell' && fs.statSync(p).isFile()) return p;
      if (fs.statSync(p).isDirectory()) stack.push(p);
    }
  }
  throw new Error(`no exe in ${dir}`);
}

function isGood(rev) {
  const exe = prepareBuild(rev);
  let version = '';
  try { version = execFileSync(exe, ['--version'], { encoding: 'utf8' }).trim(); } catch {}
  console.log(`  testing r${rev} (${version}) workers=${WORKERS} rounds=${ROUNDS} each=${EACH}`);
  let tf = 0, tp = 0;
  for (let r = 1; r <= ROUNDS; r++) {
    const result = spawnSync('npx', ['playwright', 'test', `--repeat-each=${EACH}`, `--workers=${WORKERS}`, '--reporter=line'], {
      cwd: ROOT,
      env: { ...process.env, CRPATH: exe, PLAYWRIGHT_HTML_OPEN: 'never' },
      encoding: 'utf8',
      shell: false,
    });
    const out = `${result.stdout || ''}\n${result.stderr || ''}`;
    const failM = out.match(/(\d+) failed/g);
    const passM = out.match(/(\d+) passed/g);
    const fail = failM ? Number(failM[failM.length - 1].split(' ')[0]) : (result.status === 0 ? 0 : 1);
    const pass = passM ? Number(passM[passM.length - 1].split(' ')[0]) : 0;
    console.log(`    round ${r}: fail=${fail} pass=${pass} status=${result.status}`);
    if (pass === 0 && fail === 0) {
      console.log(out.split('\n').slice(-40).join('\n'));
    }
    tf += fail; tp += pass;
    if (fail > 0 || result.status !== 0) {
      console.log(`  r${rev}: BAD (fail=${tf} pass=${tp})`);
      return false;
    }
  }
  console.log(`  r${rev}: GOOD (fail=${tf} pass=${tp})`);
  return true;
}

const revisions = await listRevisions(GOOD, BAD);
console.log(`Found ${revisions.length} ${PLATFORM} builds in [${GOOD}, ${BAD}]`);
if (revisions.length < 2) throw new Error('not enough builds');

console.log('Verifying endpoints...');
if (!isGood(revisions[0])) throw new Error(`good endpoint r${revisions[0]} failed`);
console.log('endpoint good OK');
if (isGood(revisions[revisions.length - 1])) throw new Error(`bad endpoint r${revisions[revisions.length - 1]} passed`);
console.log('endpoint bad OK');

let lo = 0, hi = revisions.length - 1;
while (hi - lo > 1) {
  const mid = Math.floor((lo + hi) / 2);
  const rev = revisions[mid];
  console.log(`BISECT lo=${lo}(r${revisions[lo]}) mid=${mid}(r${rev}) hi=${hi}(r${revisions[hi]})`);
  if (isGood(rev)) lo = mid; else hi = mid;
}

const result = {
  lastGood: revisions[lo],
  firstBad: revisions[hi],
  goodUrl: `https://crrev.com/${revisions[lo]}`,
  badUrl: `https://crrev.com/${revisions[hi]}`,
  logUrl: `https://chromium.googlesource.com/chromium/src/+log/${revisions[lo]}..${revisions[hi]}`,
};
console.log('==============================');
console.log(JSON.stringify(result, null, 2));
console.log('==============================');
fs.writeFileSync(path.join(ROOT, 'bisect-result.json'), JSON.stringify(result, null, 2));
