'use strict';

const { fetchText } = require('./downloader');

const DEFAULT_AGY_RELEASE_BASE_URL =
  'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app';

/**
 * Map remote `uname -s` / `uname -m` to Antigravity CLI manifest naming (`nodePlatform`, `nodeArch`, `manifestSuffix`).
 * Mirrors `xc` and `tc` in `extensions/agy/vscode/extension.js`.
 * @param {string} unameKernel
 * @param {string} unameMachine
 * @returns {{nodePlatform: string, nodeArch: string, manifestKey: string}}
 */
function mapAgyPlatform(unameKernel, unameMachine) {
  const kernel = (unameKernel || '').trim();
  const machine = (unameMachine || '').trim();

  let nodePlatform;
  if (kernel === 'Linux') nodePlatform = 'linux';
  else if (kernel === 'Darwin') nodePlatform = 'darwin';
  else throw new Error(`Unsupported OS for agy CLI: ${kernel}`);

  let nodeArch;
  if (machine === 'x86_64' || machine === 'amd64') nodeArch = 'x64';
  else if (machine === 'arm64' || machine === 'aarch64') nodeArch = 'arm64';
  else throw new Error(`Unsupported architecture for agy CLI: ${machine}`);

  const manifestArch = nodeArch === 'x64' ? 'amd64' : nodeArch;
  return {
    nodePlatform,
    nodeArch,
    manifestKey: `${nodePlatform}_${manifestArch}`,
  };
}

function isValidManifestShape(obj) {
  if (!obj || typeof obj !== 'object' || typeof obj.version !== 'string' || !obj.version.trim()) {
    return false;
  }
  return (
    typeof obj.url === 'string' ||
    (obj.binaries && typeof obj.binaries === 'object') ||
    (obj.platforms && typeof obj.platforms === 'object')
  );
}

/**
 * Extract `{ url, sha512, sha256, isTarGz, version }` from a fetched release manifest.
 * Mirrors `tc` and `Rc` in `extensions/agy/vscode/extension.js`.
 */
function resolveAgyBinaryFromManifest(manifest, nodePlatform, nodeArch) {
  let info;
  if (typeof manifest.url === 'string') {
    info = { url: manifest.url, sha512: manifest.sha512, sha256: manifest.sha256 };
  } else {
    const directKey = `${nodePlatform}-${nodeArch}`;
    const altKey = `${nodePlatform}-${nodeArch === 'arm64' ? 'arm' : nodeArch}`;
    info =
      (manifest.binaries && manifest.binaries[directKey]) ||
      (manifest.platforms && manifest.platforms[altKey]) ||
      (manifest.binaries && manifest.binaries[altKey]);
  }

  if (!info || !info.url) {
    throw new Error(
      `No compatible agy CLI binary found in manifest for ${nodePlatform}-${nodeArch}`
    );
  }

  const pathname = new URL(info.url).pathname.toLowerCase();
  const isTarGz = pathname.endsWith('.tar.gz') || pathname.endsWith('.tgz');
  return {
    version: manifest.version.trim(),
    url: info.url,
    sha512: info.sha512,
    sha256: info.sha256,
    isTarGz,
  };
}

/**
 * Fetch the Antigravity CLI release manifest locally (using local internet / proxy).
 */
async function fetchAgyReleaseManifest(baseUrl, manifestKey, opts = {}) {
  const base = (baseUrl || DEFAULT_AGY_RELEASE_BASE_URL).trim().replace(/\/+$/, '');
  const candidates = [
    `${base}/manifests/${manifestKey}.json`,
    `${base}/releases/latest/manifest.json`,
  ];
  const errors = [];

  for (const url of candidates) {
    try {
      const res = await fetchText(url, opts);
      if (res.statusCode === 200) {
        const parsed = JSON.parse(res.body);
        if (isValidManifestShape(parsed)) {
          return parsed;
        }
      }
      errors.push(`${url} -> HTTP ${res.statusCode}`);
    } catch (err) {
      errors.push(`${url} -> ${err.message || err}`);
    }
  }

  // Fallback: `/latest` returning version string -> `/<version>/manifest.json`
  try {
    const latestRes = await fetchText(`${base}/latest`, opts);
    if (latestRes.statusCode === 200) {
      const match = latestRes.body.match(/(\d+\.\d+\.\d+[^ \t\n\r]*)/);
      const ver = match ? match[1] : latestRes.body.trim();
      if (ver) {
        const verRes = await fetchText(`${base}/${ver}/manifest.json`, opts);
        if (verRes.statusCode === 200) {
          const parsed = JSON.parse(verRes.body);
          if (isValidManifestShape(parsed)) return parsed;
        }
      }
    }
  } catch (err) {
    errors.push(`${base}/latest -> ${err.message || err}`);
  }

  throw new Error(`Failed to fetch agy release manifest:\n${errors.join('\n')}`);
}

module.exports = {
  DEFAULT_AGY_RELEASE_BASE_URL,
  mapAgyPlatform,
  resolveAgyBinaryFromManifest,
  fetchAgyReleaseManifest,
};
