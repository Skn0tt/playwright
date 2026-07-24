#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const traceRoot = path.resolve('test-results/mcp-chromium-traces');
const retryDeadline = Date.now() + 10_000;

async function recoverTrace(source) {
  const target = path.join(path.dirname(source), `recovered-${crypto.randomUUID()}.pftrace`);
  while (true) {
    let size;
    try {
      size = (await fs.promises.stat(source)).size;
    } catch (error) {
      if (error.code === 'ENOENT')
        return;
      throw error;
    }

    if (size) {
      try {
        await fs.promises.rename(source, target);
        console.log(`Recovered Chromium startup trace: ${target}`);
        return;
      } catch (error) {
        if (error.code === 'ENOENT')
          return;
        if (error.code !== 'EACCES' && error.code !== 'EPERM')
          throw error;
      }
    }

    if (Date.now() >= retryDeadline) {
      console.warn(`Chromium startup trace has no recoverable data: ${source}`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

let traceDirectories;
try {
  traceDirectories = await fs.promises.readdir(traceRoot, { withFileTypes: true });
} catch (error) {
  if (error.code === 'ENOENT')
    process.exit(0);
  throw error;
}

const pending = [];
for (const directory of traceDirectories) {
  if (!directory.isDirectory())
    continue;
  const traceDirectory = path.join(traceRoot, directory.name);
  for (const file of await fs.promises.readdir(traceDirectory)) {
    if (!file.endsWith('.pftrace'))
      pending.push(recoverTrace(path.join(traceDirectory, file)));
  }
}
await Promise.all(pending);
