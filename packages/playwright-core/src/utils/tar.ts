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
import { Writable, once } from 'stream';
import path from 'path';
import assert from 'assert';

enum TarType {
  REGTYPE,
  LNKTYPE,
  SYMTYPE,
  CHRTYPE,
  BLKTYPE,
  DIRTYPE,
  FIFOTYPE,
  CONTTYPE
}

function parseHeader(buffer: Buffer) {
  if (buffer.length < 512)
    throw new Error('Invalid header: ' + buffer.toString('utf8'));

  let name = buffer.toString('utf8', 0, 100).replace(/\0/g, '');
  const prefixField = buffer.toString('utf8', 345, 500).replace(/\0/g, '');
  if (prefixField)
    name = path.join(prefixField, name);
  name = name.replace(/^\/+/, '');

  const size = parseInt(buffer.toString('utf8', 124, 136).trim(), 8);
  const type = parseInt(buffer.toString('ascii', 156, 157), 10) as TarType;
  const mode = parseInt(buffer.toString('utf8', 100, 108).trim(), 8) || 0o644;
  const linkname = buffer.toString('utf8', 157, 257).replace(/\0/g, '');

  const uid = parseInt(buffer.toString('utf8', 108, 116).trim(), 8);
  const gid = parseInt(buffer.toString('utf8', 116, 124).trim(), 8);

  return {
    name,
    size,
    type,
    mode,
    linkname,
    uid,
    gid
  };
}

type TarHeader = NonNullable<ReturnType<typeof parseHeader>>;

export class TarExtractor extends Writable {
  private queue = Promise.resolve();
  private buffer = Buffer.alloc(0);
  private currentHeader: TarHeader | null = null;
  private remainingBytes = 0;
  private currentFileStream: fs.WriteStream | null = null;

  constructor(private outputPath: (path: string) => string) {
    super();
  }

  override async _write(chunk: Buffer, _encoding: string, callback: (err?: Error) => void) {
    this.queue = this.queue.then(() => this._writeImpl(chunk)).then(callback).catch(callback);
  }

  private async _writeImpl(chunk: Buffer): Promise<undefined> {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 512) {
      if (!this.currentHeader) {
        // Check for end of archive (two consecutive zero blocks)
        if (this.buffer.subarray(0, 512).every(byte => byte === 0)) {
          this.buffer = this.buffer.subarray(512);
          continue;
        }

        const header = parseHeader(this.buffer);
        this.buffer = this.buffer.subarray(512);

        const fullPath = this.outputPath(header.name);
        switch (header.type) {
          case TarType.DIRTYPE:
            await fs.promises.mkdir(fullPath, { recursive: true, mode: 0o755 });
            break;
          case TarType.SYMTYPE:
            await fs.promises.symlink(header.linkname, fullPath);
            break;
          case TarType.REGTYPE:
            this.currentFileStream = fs.createWriteStream(fullPath, { mode: header.mode });
            await once(this.currentFileStream, 'ready');
            this.currentHeader = header;
            this.remainingBytes = header.size;
            break;
          default:
            throw new Error(`Unsupported type ${header.type} for '${header.name}'`);
        }

        continue;
      }

      assert(this.currentFileStream);
      assert(this.remainingBytes > 0);

      const dataChunk = this.buffer.subarray(0, this.remainingBytes);
      this.buffer = this.buffer.subarray(this.remainingBytes);
      this.remainingBytes -= dataChunk.length;

      this.currentFileStream.write(dataChunk);

      if (this.remainingBytes === 0) {
        this.currentFileStream.end();
        this.currentFileStream = null;

        const padding = 512 - (this.currentHeader.size % 512);
        if (padding < 512)
          this.buffer = this.buffer.subarray(padding);

        this.currentHeader = null;
      }
    }
  }
}
