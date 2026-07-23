/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'fs';

export function startupTrace(phase: string, data: Record<string, unknown> = {}): void {
  const traceFile = process.env.PWTEST_MCP_STARTUP_TRACE;
  if (!traceFile)
    return;
  const entry = {
    timestamp: new Date().toISOString(),
    monotonicTime: Number(process.hrtime.bigint() / 1_000_000n),
    pid: process.pid,
    ppid: process.ppid,
    phase,
    ...data,
  };
  fs.appendFileSync(traceFile, JSON.stringify(entry) + '\n');
}
