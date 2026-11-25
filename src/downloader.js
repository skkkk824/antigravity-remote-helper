'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const tls = require('tls');

const MAX_REDIRECTS = 8;

/**
 * Fetch text/JSON from a URL (following redirects and optional HTTP proxy).
 * @param {string} targetUrl
 * @param {{proxyUrl?: string, signal?: AbortSignal, timeoutMs?: number}} [opts]
 * @returns {Promise<{statusCode: number, body: string}>}
 */
async function fetchText(targetUrl, opts = {}, redirectCount = 0) {
  if (redirectCount > MAX_REDIRECTS) {
    throw new Error(`Too many redirects (${redirectCount})`);
  }
  const res = await openHttpStream(targetUrl, opts.proxyUrl, opts.signal, opts.timeoutMs || 15000);
  if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
    res.resume();
    const nextUrl = new URL(res.headers.location, targetUrl).toString();
    return fetchText(nextUrl, opts, redirectCount + 1);
  }
  const chunks = [];
  await new Promise((resolve, reject) => {
    res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    res.on('error', reject);
    res.on('end', resolve);
  });
  return {
    statusCode: res.statusCode || 0,
    body: Buffer.concat(chunks).toString('utf8'),
  };
}

/**
 * Download a file from the first succeeding URL in `urls` to `destPath`.
 * Writes atomically via a `.tmp` file.
 * @param {string[]} urls
 * @param {string} destPath
 * @param {{proxyUrl?: string, expectGzip?: boolean, expectedSha512?: string, expectedSha256?: string, onProgress?: (info: {downloaded: number, total: number|null, url: string}) => void, log?: (msg: string) => void, signal?: AbortSignal}} [opts]
 * @returns {Promise<{url: string, size: number}>}
 */
async function downloadFromMirrors(urls, destPath, opts = {}) {
  const log = opts.log || (() => {});
  const errors = [];

  for (const url of urls) {
    if (opts.signal && opts.signal.aborted) {
      throw new Error('Download cancelled');
    }
    try {
      log(`Attempting local download: ${url}`);
      const result = await downloadSingleUrl(url, destPath, opts);
      return result;
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      errors.push(`${url} -> ${message}`);
      log(`Download failed (${url}): ${message}`);
      if (opts.signal && opts.signal.aborted) {
        throw err;
      }
    }
  }

  throw new Error(`All download mirrors failed:\n${errors.join('\n')}`);
}

async function downloadSingleUrl(targetUrl, destPath, opts = {}, redirectCount = 0) {
  if (redirectCount > MAX_REDIRECTS) {
    throw new Error(`Too many redirects (${redirectCount})`);
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tempPath = `${destPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;

  try {
    const res = await openHttpStream(targetUrl, opts.proxyUrl, opts.signal, 30000);

    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      const nextUrl = new URL(res.headers.location, targetUrl).toString();
      return await downloadSingleUrl(nextUrl, destPath, opts, redirectCount + 1);
    }

    if (res.statusCode !== 200) {
      res.resume();
      throw new Error(`HTTP ${res.statusCode} ${res.statusMessage || ''}`.trim());
    }

    const total = res.headers['content-length'] ? parseInt(res.headers['content-length'], 10) : null;
    let downloaded = 0;

    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tempPath);
      const onAbort = () => {
        res.destroy(new Error('Download cancelled'));
        out.destroy();
        reject(new Error('Download cancelled'));
      };
      if (opts.signal) {
        if (opts.signal.aborted) return onAbort();
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (opts.onProgress) {
          opts.onProgress({ downloaded, total, url: targetUrl });
        }
      });

      res.on('error', (err) => {
        out.destroy();
        reject(err);
      });

      out.on('error', (err) => {
        res.destroy();
        reject(err);
      });

      out.on('finish', () => {
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
        resolve();
      });

      res.pipe(out);
    });

    if (opts.expectGzip !== false) {
      verifyGzipFile(tempPath);
    }
    if (opts.expectedSha512) {
      verifyChecksum(tempPath, 'sha512', opts.expectedSha512);
    } else if (opts.expectedSha256) {
      verifyChecksum(tempPath, 'sha256', opts.expectedSha256);
    }

    if (fs.existsSync(destPath)) {
      fs.unlinkSync(destPath);
    }
    fs.renameSync(tempPath, destPath);
    const stat = fs.statSync(destPath);
    return { url: targetUrl, size: stat.size };
  } catch (err) {
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {}
    }
    throw err;
  }
}

function verifyGzipFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(2);
    const bytesRead = fs.readSync(fd, header, 0, 2, 0);
    if (bytesRead < 2 || header[0] !== 0x1f || header[1] !== 0x8b) {
      throw new Error('Downloaded file is not a valid gzip archive');
    }
  } finally {
    fs.closeSync(fd);
  }
}

function verifyChecksum(filePath, algorithm, expectedHex) {
  const hash = crypto.createHash(algorithm);
  hash.update(fs.readFileSync(filePath));
  const actual = hash.digest('hex');
  if (actual.toLowerCase() !== expectedHex.trim().toLowerCase()) {
    throw new Error(
      `${algorithm.toUpperCase()} checksum mismatch: expected ${expectedHex}, got ${actual}`
    );
  }
}

function openHttpStream(targetUrl, proxyUrl, signal, timeoutMs = 30000) {
  const urlObj = new URL(targetUrl);
  const effectiveProxy = (proxyUrl || '').trim();

  if (!effectiveProxy) {
    const lib = urlObj.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = lib.get(
        targetUrl,
        {
          headers: { 'User-Agent': 'antigravity-remote-helper/0.3.0' },
          timeout: timeoutMs,
        },
        resolve
      );
      req.on('timeout', () => req.destroy(new Error('Request timeout')));
      req.on('error', reject);
      if (signal) {
        if (signal.aborted) req.destroy(new Error('Download cancelled'));
        else signal.addEventListener('abort', () => req.destroy(new Error('Download cancelled')), { once: true });
      }
    });
  }

  const proxyObj = new URL(effectiveProxy);
  const proxyHost = proxyObj.hostname;
  const proxyPort = parseInt(proxyObj.port || (proxyObj.protocol === 'https:' ? '443' : '80'), 10);

  if (urlObj.protocol === 'http:') {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: proxyHost,
          port: proxyPort,
          method: 'GET',
          path: targetUrl,
          headers: {
            Host: urlObj.host,
            'User-Agent': 'antigravity-remote-helper/0.3.0',
          },
          timeout: timeoutMs,
        },
        resolve
      );
      req.on('timeout', () => req.destroy(new Error('Proxy request timeout')));
      req.on('error', reject);
      req.end();
    });
  }

  return new Promise((resolve, reject) => {
    const targetPort = parseInt(urlObj.port || '443', 10);
    const socket = net.connect(proxyPort, proxyHost, () => {
      const connectHeaders = [
        `CONNECT ${urlObj.hostname}:${targetPort} HTTP/1.1`,
        `Host: ${urlObj.hostname}:${targetPort}`,
      ];
      if (proxyObj.username || proxyObj.password) {
        const auth = Buffer.from(
          `${decodeURIComponent(proxyObj.username)}:${decodeURIComponent(proxyObj.password)}`
        ).toString('base64');
        connectHeaders.push(`Proxy-Authorization: Basic ${auth}`);
      }
      connectHeaders.push('', '');
      socket.write(connectHeaders.join('\r\n'));
    });

    let headerBuf = '';
    const onData = (chunk) => {
      headerBuf += chunk.toString('latin1');
      const idx = headerBuf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      socket.removeListener('data', onData);
      const statusLine = headerBuf.slice(0, headerBuf.indexOf('\r\n'));
      if (!/^HTTP\/\d\.\d\s+200\b/.test(statusLine)) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed: ${statusLine}`));
        return;
      }

      const tlsSocket = tls.connect({
        socket,
        servername: urlObj.hostname,
      });

      const req = https.request(
        {
          host: urlObj.hostname,
          port: targetPort,
          path: `${urlObj.pathname}${urlObj.search}`,
          method: 'GET',
          createConnection: () => tlsSocket,
          headers: {
            Host: urlObj.host,
            'User-Agent': 'antigravity-remote-helper/0.3.0',
          },
          timeout: timeoutMs,
        },
        resolve
      );
      req.on('timeout', () => req.destroy(new Error('Request timeout')));
      req.on('error', reject);
      req.end();
    };

    socket.on('data', onData);
    socket.on('error', reject);
    if (signal) {
      if (signal.aborted) {
        socket.destroy();
        reject(new Error('Download cancelled'));
      } else {
        signal.addEventListener(
          'abort',
          () => {
            socket.destroy();
            reject(new Error('Download cancelled'));
          },
          { once: true }
        );
      }
    }
  });
}

module.exports = {
  fetchText,
  downloadFromMirrors,
  verifyGzipFile,
  verifyChecksum,
};
