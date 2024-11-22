/**
 * Copyright 2017 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { existsAsync } from '../../utils/fileUtils';
import { debugLogger } from '../../utils/debugLogger';
import { httpRequest } from '../../utils/network';
import { colors, progress as ProgressBar } from '../../utilsBundle';
import { extract } from '../../zipBundle';
import { browserDirectoryToMarkerFilePath } from '.';
import { getUserAgent } from '../../utils/userAgent';
import { Readable } from 'stream';
import { finished } from 'stream/promises';

export async function downloadBrowserWithProgressBar(title: string, browserDirectory: string, executablePath: string | undefined, downloadURLs: string[], downloadFileName: string, downloadConnectionTimeout: number): Promise<boolean> {
  if (await existsAsync(browserDirectoryToMarkerFilePath(browserDirectory))) {
    // Already downloaded.
    debugLogger.log('install', `${title} is already downloaded.`);
    return false;
  }

  const zipPath = path.join(os.tmpdir(), downloadFileName);
  try {
    const retryCount = 5;
    for (let attempt = 1; attempt <= retryCount; ++attempt) {
      debugLogger.log('install', `downloading ${title} - attempt #${attempt}`);
      const url = downloadURLs[(attempt - 1) % downloadURLs.length];
      logPolitely(`Downloading ${title}` + colors.dim(` from ${url}`));
      const { error } = await downloadBrowserWithProgressBarInProcess(title, browserDirectory, url, zipPath, executablePath, downloadConnectionTimeout);
      if (!error) {
        debugLogger.log('install', `SUCCESS installing ${title}`);
        break;
      }
      if (await existsAsync(zipPath))
        await fs.promises.unlink(zipPath);
      if (await existsAsync(browserDirectory))
        await fs.promises.rmdir(browserDirectory, { recursive: true });
      const errorMessage = error?.message || '';
      debugLogger.log('install', `attempt #${attempt} - ERROR: ${errorMessage}`);
      if (attempt >= retryCount)
        throw error;
    }
  } catch (e) {
    debugLogger.log('install', `FAILED installation ${title} with error: ${e}`);
    process.exitCode = 1;
    throw e;
  } finally {
    if (await existsAsync(zipPath))
      await fs.promises.unlink(zipPath);
  }
  return true;
}

async function downloadFile(options: DownloadParams): Promise<void> {
  const response = await fetch(options.url, {
    headers: { 'User-Agent': options.userAgent },
    signal: AbortSignal.timeout(options.connectionTimeout)
  });

  try {
    if (!response.ok || !response.body)
      throw new Error(`Download failed: server returned code ${response.status} body '${await response.text()}'. URL: ${options.url}`);

    const progress = getDownloadProgress();
    const totalBytes = parseInt(response.headers.get('content-length') ?? '0', 10);
    let downloadedBytes = 0;
    const trackedDownload = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        downloadedBytes += chunk.length;
        progress(downloadedBytes, totalBytes);
        controller.enqueue(chunk);
      }
    }));
    const file = fs.createWriteStream(options.zipPath);

    try {
      // @ts-expect-error - mismatch between ReadableStream types in node and web
      await finished(Readable.fromWeb(trackedDownload).pipe(file));
      if (downloadedBytes !== totalBytes) {
        debugLogger.log('install', `-- download failed, size mismatch: ${downloadedBytes} != ${totalBytes}`);
        throw new Error(`Download failed: size mismatch, file size: ${downloadedBytes}, expected size: ${totalBytes} URL: ${options.url}`);
      }
    } catch (error) {
      file.close();
      throw error;
    }


    debugLogger.log('install', `-- download complete, size: ${downloadedBytes}`);
  } catch (error) {
    response.body?.cancel();

    if (error?.code === 'ECONNRESET') {
      debugLogger.log('install', `-- download failed, server closed connection`);
      throw new Error(`Download failed: server closed connection. URL: ${options.url}`);
    }

    debugLogger.log('install', `-- download failed, unexpected error`);
    throw new Error(`Download failed: ${error?.message ?? error}. URL: ${options.url}`);
  }
}

type DownloadParams = {
  title: string;
  browserDirectory: string;
  url: string;
  zipPath: string;
  executablePath: string | undefined;
  connectionTimeout: number;
  userAgent: string;
};

// one download and one extraction at a time to max out CPU and network
let downloadQueue = Promise.resolve();
let extractQueue = Promise.resolve();

async function downloadBrowserWithProgressBarInProcess(title: string, browserDirectory: string, url: string, zipPath: string, executablePath: string | undefined, connectionTimeout: number): Promise<{ error: Error | null }> {
  try {
    const options: DownloadParams = {
      title,
      browserDirectory,
      url,
      zipPath,
      executablePath,
      connectionTimeout,
      userAgent: getUserAgent(),
    };

    debugLogger.log('install', `running download:`);
    debugLogger.log('install', `-- from url: ${url}`);
    debugLogger.log('install', `-- to location: ${zipPath}`);


    downloadQueue = downloadQueue.then(() => downloadFile(options));
    await downloadQueue;
    logPolitely(`${title} downloaded to ${browserDirectory}`);

    debugLogger.log('install', `SUCCESS downloading ${options.title}`);
    debugLogger.log('install', `extracting archive`);

    extractQueue = extractQueue.then(() => extract(options.zipPath, { dir: options.browserDirectory }));
    await extractQueue;

    if (options.executablePath) {
      debugLogger.log('install', `fixing permissions at ${options.executablePath}`);
      await fs.promises.chmod(options.executablePath, 0o755);
    }
    await fs.promises.writeFile(browserDirectoryToMarkerFilePath(options.browserDirectory), '');

    if (!fs.existsSync(browserDirectoryToMarkerFilePath(browserDirectory)))
      return { error: new Error(`Download failure, ${browserDirectoryToMarkerFilePath(browserDirectory)} does not exist`) };

    return { error: null };
  } catch (error) {
    return { error };
  }
}

export function logPolitely(toBeLogged: string) {
  const logLevel = process.env.npm_config_loglevel;
  const logLevelDisplay = ['silent', 'error', 'warn'].indexOf(logLevel || '') > -1;

  if (!logLevelDisplay)
    console.log(toBeLogged);  // eslint-disable-line no-console
}

type OnProgressCallback = (downloadedBytes: number, totalBytes: number) => void;

function getDownloadProgress(): OnProgressCallback {
  if (process.stdout.isTTY)
    return getAnimatedDownloadProgress();
  return getBasicDownloadProgress();
}

function getAnimatedDownloadProgress(): OnProgressCallback {
  let progressBar: ProgressBar;
  let lastDownloadedBytes = 0;

  return (downloadedBytes: number, totalBytes: number) => {
    if (!progressBar) {
      progressBar = new ProgressBar(
          `${toMegabytes(
              totalBytes
          )} [:bar] :percent :etas`,
          {
            complete: '=',
            incomplete: ' ',
            width: 20,
            total: totalBytes,
          }
      );
    }
    const delta = downloadedBytes - lastDownloadedBytes;
    lastDownloadedBytes = downloadedBytes;
    progressBar.tick(delta);
  };
}

function getBasicDownloadProgress(): OnProgressCallback {
  const totalRows = 10;
  const stepWidth = 8;
  let lastRow = -1;
  return (downloadedBytes: number, totalBytes: number) => {
    const percentage = downloadedBytes / totalBytes;
    const row = Math.floor(totalRows * percentage);
    if (row > lastRow) {
      lastRow = row;
      const percentageString = String(percentage * 100 | 0).padStart(3);
      // eslint-disable-next-line no-console
      console.log(`|${'■'.repeat(row * stepWidth)}${' '.repeat((totalRows - row) * stepWidth)}| ${percentageString}% of ${toMegabytes(totalBytes)}`);
    }
  };
}

function toMegabytes(bytes: number) {
  const mb = bytes / 1024 / 1024;
  return `${Math.round(mb * 10) / 10} MiB`;
}
