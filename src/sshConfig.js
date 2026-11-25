'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Expand leading `~` to the current user's home directory.
 * @param {string} filePath
 * @returns {string}
 */
function expandHome(filePath) {
  if (!filePath) return filePath;
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

/**
 * Resolve effective SSH config file path.
 * @param {string} [configuredPath]
 * @param {string} [fallbackConfiguredPath]
 * @returns {string}
 */
function resolveSshConfigPath(configuredPath, fallbackConfiguredPath) {
  const candidate = (configuredPath || fallbackConfiguredPath || '').trim();
  if (candidate) {
    return expandHome(candidate);
  }
  return path.join(os.homedir(), '.ssh', 'config');
}

/**
 * Parse an SSH config file (including Include files) into concrete Host entries.
 * Skips wildcard/negated patterns like "*" or "*.example.com".
 * @param {string} filePath
 * @param {Set<string>} [visited]
 * @returns {Array<{alias: string, hostName?: string, user?: string, port?: string}>}
 */
function parseSshConfigFile(filePath, visited = new Set()) {
  const resolved = path.resolve(expandHome(filePath));
  if (visited.has(resolved) || !fs.existsSync(resolved)) {
    return [];
  }
  visited.add(resolved);

  const content = fs.readFileSync(resolved, 'utf8');
  const lines = content.split(/\r?\n/);
  const hosts = [];
  let currentEntries = [];

  for (const rawLine of lines) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;

    const match = line.match(/^(\S+)(?:\s*=\s*|\s+)(.+)$/);
    if (!match) continue;

    const key = match[1].toLowerCase();
    const value = unquote(match[2].trim());

    if (key === 'include') {
      const patterns = splitArgs(match[2].trim());
      for (const pattern of patterns) {
        for (const includedFile of expandIncludePattern(pattern)) {
          hosts.push(...parseSshConfigFile(includedFile, visited));
        }
      }
      continue;
    }

    if (key === 'host') {
      const aliases = splitArgs(match[2].trim()).filter(
        (alias) => alias && !alias.includes('*') && !alias.includes('?') && !alias.startsWith('!')
      );
      currentEntries = aliases.map((alias) => {
        const entry = { alias };
        hosts.push(entry);
        return entry;
      });
      continue;
    }

    if (key === 'match') {
      currentEntries = [];
      continue;
    }

    if (currentEntries.length === 0) continue;

    if (key === 'hostname') {
      for (const entry of currentEntries) entry.hostName = value;
    } else if (key === 'user') {
      for (const entry of currentEntries) entry.user = value;
    } else if (key === 'port') {
      for (const entry of currentEntries) entry.port = value;
    }
  }

  const seen = new Set();
  return hosts.filter((h) => {
    if (seen.has(h.alias)) return false;
    seen.add(h.alias);
    return true;
  });
}

function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

function unquote(val) {
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    return val.slice(1, -1);
  }
  return val;
}

function splitArgs(raw) {
  const out = [];
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = regex.exec(raw)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

function expandIncludePattern(pattern) {
  const expanded = expandHome(pattern);
  const full = path.isAbsolute(expanded)
    ? expanded
    : path.join(os.homedir(), '.ssh', expanded);
  if (!full.includes('*')) {
    return fs.existsSync(full) ? [full] : [];
  }
  const dir = path.dirname(full);
  const filePattern = path.basename(full);
  if (!fs.existsSync(dir)) return [];
  const regex = new RegExp(
    '^' + filePattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
  );
  return fs
    .readdirSync(dir)
    .filter((name) => regex.test(name))
    .map((name) => path.join(dir, name));
}

/**
 * Parse an SSH target like "root@10.1.130.53:2222" or "ubuntu@[::1]:2222".
 * @param {string} target
 * @returns {{hostName: string, user?: string, port?: number}}
 */
function parseSshTarget(target) {
  const trimmed = String(target || '').trim();
  const atIdx = trimmed.lastIndexOf('@');
  const user = atIdx !== -1 ? trimmed.slice(0, atIdx) : undefined;
  const hostAndPort = atIdx !== -1 ? trimmed.slice(atIdx + 1) : trimmed;

  let hostName = hostAndPort;
  let port;
  const bracketMatch = hostAndPort.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketMatch) {
    hostName = bracketMatch[1];
    if (bracketMatch[2]) port = parseInt(bracketMatch[2], 10);
  } else {
    const colonIdx = hostAndPort.lastIndexOf(':');
    if (colonIdx !== -1 && hostAndPort.indexOf(':') === colonIdx) {
      const parsedPort = parseInt(hostAndPort.slice(colonIdx + 1), 10);
      if (!Number.isNaN(parsedPort)) {
        hostName = hostAndPort.slice(0, colonIdx);
        port = parsedPort;
      }
    }
  }

  return { hostName, user, port };
}

/**
 * Encode SSH target into Antigravity's `ssh-remote+<hex>` authority format.
 * @param {string} target
 * @returns {string}
 */
function encodeRemoteAuthority(target) {
  const parsed = parseSshTarget(target);
  const payload = { hostName: parsed.hostName };
  if (parsed.user) payload.user = parsed.user;
  if (parsed.port !== undefined) payload.port = parsed.port;
  const hex = Buffer.from(JSON.stringify(payload), 'utf8').toString('hex');
  return `ssh-remote+${hex}`;
}

/**
 * Decode an `ssh-remote+<hex>` authority back into a target string (`user@host:port` or `host`).
 * @param {string} authority
 * @returns {string|undefined}
 */
function decodeRemoteAuthority(authority) {
  if (!authority || !authority.startsWith('ssh-remote+')) return undefined;
  const hex = authority.slice('ssh-remote+'.length);
  try {
    const obj = JSON.parse(Buffer.from(hex, 'hex').toString('utf8'));
    if (!obj || !obj.hostName) return undefined;
    let out = obj.user ? `${obj.user}@${obj.hostName}` : obj.hostName;
    if (obj.port !== undefined) out += `:${obj.port}`;
    return out;
  } catch {
    return undefined;
  }
}

module.exports = {
  resolveSshConfigPath,
  parseSshConfigFile,
  parseSshTarget,
  encodeRemoteAuthority,
  decodeRemoteAuthority,
};
