'use strict';

const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { parseSshTarget } = require('./sshConfig');

const NO_PROXY_DEFAULT = 'localhost,127.0.0.1,::1';
const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
];

function resolveSshTools(configuredSsh, fallbackSsh, configuredScp) {
  const sshPath = (configuredSsh || fallbackSsh || '').trim() || 'ssh';
  let scpPath = (configuredScp || '').trim();
  if (!scpPath) {
    if (sshPath !== 'ssh' && (sshPath.includes('\\') || sshPath.includes('/'))) {
      const dir = path.dirname(sshPath);
      const ext = path.extname(sshPath);
      const candidate = path.join(dir, `scp${ext}`);
      scpPath = fs.existsSync(candidate) ? candidate : 'scp';
    } else {
      scpPath = 'scp';
    }
  }
  return { sshPath, scpPath };
}

async function createAskpassContext(promptFn) {
  const token = crypto.randomBytes(16).toString('hex');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-offline-ssh-'));

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.headers['x-askpass-token'] !== token) {
      res.writeHead(403);
      res.end();
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c.toString('utf8')));
    req.on('end', async () => {
      try {
        const promptText = JSON.parse(body || '{}').prompt || 'SSH authentication';
        const answer = await promptFn(promptText);
        if (answer === undefined) {
          res.writeHead(204);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ answer }));
      } catch {
        res.writeHead(500);
        res.end();
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const clientJs = path.join(tmpDir, 'askpass-client.js');
  fs.writeFileSync(
    clientJs,
    [
      "'use strict';",
      "const http = require('http');",
      'const prompt = process.argv.slice(2).join(" ");',
      'const payload = JSON.stringify({ prompt });',
      `const req = http.request({ host: '127.0.0.1', port: ${port}, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Askpass-Token': '${token}' } }, (res) => {`,
      '  if (res.statusCode !== 200) process.exit(1);',
      '  let data = "";',
      '  res.on("data", (c) => (data += c));',
      '  res.on("end", () => { try { process.stdout.write(JSON.parse(data).answer); } catch { process.exit(1); } });',
      '});',
      'req.on("error", () => process.exit(1));',
      'req.write(payload);',
      'req.end();',
    ].join('\n'),
    'utf8'
  );

  let askpassPath;
  if (process.platform === 'win32') {
    askpassPath = path.join(tmpDir, 'askpass.bat');
    fs.writeFileSync(
      askpassPath,
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${clientJs}" %*\r\n`,
      'utf8'
    );
  } else {
    askpassPath = path.join(tmpDir, 'askpass.sh');
    fs.writeFileSync(
      askpassPath,
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${clientJs}" "$@"\n`,
      { encoding: 'utf8', mode: 0o700 }
    );
  }

  return {
    env: {
      ...process.env,
      SSH_ASKPASS: askpassPath,
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: process.env.DISPLAY || 'antigravity-offline-ssh:0',
    },
    dispose() {
      try {
        server.close();
      } catch {}
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

function execBinary(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(bin, args, {
      env: opts.env || process.env,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));

    if (opts.stdinData !== undefined) {
      child.stdin.write(opts.stdinData);
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function buildSshCommonArgs(configFile, timeoutSeconds) {
  const args = [];
  if (configFile && configFile.trim()) {
    args.push('-F', configFile.trim());
  }
  if (timeoutSeconds && timeoutSeconds > 0) {
    args.push('-o', `ConnectTimeout=${Math.round(timeoutSeconds)}`);
  }
  return args;
}

function buildEndpointAndArgs(target, configFile, timeoutSeconds, isScp) {
  const parsed = parseSshTarget(target);
  const destination = parsed.user ? `${parsed.user}@${parsed.hostName}` : parsed.hostName;
  const args = buildSshCommonArgs(configFile, timeoutSeconds);
  if (parsed.port !== undefined) {
    args.push(isScp ? '-P' : '-p', String(parsed.port));
  }
  return { destination, args };
}

const WINDOWS_UNSUPPORTED_MSG =
  '由于Antigravity IDE限制，不支持 Windows 远程主机 (Antigravity IDE does not support Windows as a remote SSH host; only Linux and macOS are supported).';

/**
 * Detect when a remote SSH host is Windows (cmd.exe / PowerShell lacking `sh`).
 */
function isWindowsRemoteHostError(stderr, stdout) {
  const combined = `${stderr || ''}\n${stdout || ''}`;
  if (/'sh'\s+is not recognized/i.test(combined)) return true;
  if (/The term 'sh' is not recognized/i.test(combined)) return true;
  if (/'sh'.*(不是内部或外部命令|无法将|项识别为|\uFFFD)/i.test(combined)) return true;
  if (/cmd\.exe|PowerShell/i.test(combined) && /\bsh\b/i.test(combined)) return true;
  return false;
}

/**
 * Single SSH call to inspect remote OS, arch, HOME, IDE server, agy CLI, AND existing Machine/settings.json.
 */
async function probeRemoteHost({
  sshPath,
  target,
  configFile,
  timeoutSeconds,
  env,
  ideVersion,
  distroId,
  serverDataFolderName,
  serverApplicationName,
}) {
  const script = [
    'set -e',
    'KERNEL="$(uname -s)"',
    'ARCH="$(uname -m)"',
    'SERVER_DATA_DIR="$HOME/' + serverDataFolderName + '"',
    `SERVER_DIR="$SERVER_DATA_DIR/bin/${ideVersion}-${distroId}"`,
    `SERVER_SCRIPT="$SERVER_DIR/bin/${serverApplicationName}"`,
    'AGY_BIN="$HOME/.gemini/bin/agy"',
    'SETTINGS_FILE="$SERVER_DATA_DIR/data/Machine/settings.json"',
    'EXISTS="0"',
    'if [ -f "$SERVER_SCRIPT" ]; then EXISTS="1"; fi',
    'AGY_EXISTS="0"',
    'if [ -x "$AGY_BIN" ]; then AGY_EXISTS="1"; fi',
    'SETTINGS_B64=""',
    'if [ -f "$SETTINGS_FILE" ]; then SETTINGS_B64="$(base64 < "$SETTINGS_FILE" | tr -d \'\\r\\n\')"; fi',
    'echo "AG_PROBE_START"',
    'echo "KERNEL=$KERNEL"',
    'echo "ARCH=$ARCH"',
    'echo "HOME=$HOME"',
    'echo "EXISTS=$EXISTS"',
    'echo "AGY_EXISTS=$AGY_EXISTS"',
    'echo "SETTINGS_B64=$SETTINGS_B64"',
    'echo "AG_PROBE_END"',
  ].join('\n');

  const { destination, args: commonArgs } = buildEndpointAndArgs(
    target,
    configFile,
    timeoutSeconds,
    false
  );
  const args = [...commonArgs, '-T', destination, 'sh', '-s'];
  const res = await execBinary(sshPath, args, { env, stdinData: script + '\n' });
  if (res.code !== 0) {
    if (isWindowsRemoteHostError(res.stderr, res.stdout)) {
      throw new Error(WINDOWS_UNSUPPORTED_MSG);
    }
    throw new Error(`SSH probe failed (exit ${res.code}): ${res.stderr.trim() || res.stdout.trim()}`);
  }

  const startIdx = res.stdout.indexOf('AG_PROBE_START');
  const endIdx = res.stdout.indexOf('AG_PROBE_END');
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(`Unexpected SSH probe output:\n${res.stdout}\n${res.stderr}`);
  }

  const body = res.stdout.slice(startIdx, endIdx).split(/\r?\n/);
  const info = {};
  for (const line of body) {
    const eq = line.indexOf('=');
    if (eq > 0) {
      info[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }

  if (!info.KERNEL || !info.ARCH || !info.HOME) {
    throw new Error(`Incomplete probe result: ${JSON.stringify(info)}`);
  }

  let machineSettingsRaw = '';
  if (info.SETTINGS_B64) {
    try {
      machineSettingsRaw = Buffer.from(info.SETTINGS_B64, 'base64').toString('utf8');
    } catch {}
  }

  return {
    kernel: info.KERNEL,
    arch: info.ARCH,
    home: info.HOME,
    alreadyInstalled: info.EXISTS === '1',
    agyInstalled: info.AGY_EXISTS === '1',
    machineSettingsRaw,
  };
}

/**
 * Compute desired `$SERVER_DATA_DIR/data/Machine/settings.json` content and whether a write is required.
 */
function computeDesiredMachineSettings(
  existingRaw,
  { enableProxyTunnel, enableTerminalProxy, tunnelPort, platform }
) {
  let baseObj = {};
  let parseSucceeded = true;
  if (existingRaw && existingRaw.trim()) {
    try {
      baseObj = JSON.parse(stripJsonComments(existingRaw));
    } catch {
      parseSucceeded = false;
      baseObj = {};
    }
  }

  const updated = JSON.parse(JSON.stringify(baseObj));
  const proxyValue = `http://127.0.0.1:${tunnelPort}`;
  const termKey = platform === 'darwin' ? 'terminal.integrated.env.osx' : 'terminal.integrated.env.linux';

  if (enableProxyTunnel) {
    updated['http.proxy'] = proxyValue;
    updated['http.proxySupport'] = 'on';

    if (enableTerminalProxy) {
      const prevEnv =
        updated[termKey] && typeof updated[termKey] === 'object' ? { ...updated[termKey] } : {};
      prevEnv.HTTP_PROXY = proxyValue;
      prevEnv.HTTPS_PROXY = proxyValue;
      prevEnv.http_proxy = proxyValue;
      prevEnv.https_proxy = proxyValue;
      if (!prevEnv.NO_PROXY) prevEnv.NO_PROXY = NO_PROXY_DEFAULT;
      if (!prevEnv.no_proxy) prevEnv.no_proxy = NO_PROXY_DEFAULT;
      updated[termKey] = prevEnv;
    } else if (updated[termKey] && typeof updated[termKey] === 'object') {
      const cleaned = { ...updated[termKey] };
      for (const k of PROXY_ENV_KEYS) {
        if (typeof cleaned[k] === 'string' && cleaned[k].includes('127.0.0.1:')) {
          delete cleaned[k];
        }
      }
      if (cleaned.NO_PROXY === NO_PROXY_DEFAULT) delete cleaned.NO_PROXY;
      if (cleaned.no_proxy === NO_PROXY_DEFAULT) delete cleaned.no_proxy;
      if (Object.keys(cleaned).length === 0) delete updated[termKey];
      else updated[termKey] = cleaned;
    }
  }

  const beforeNormalized = parseSucceeded ? JSON.stringify(baseObj) : null;
  const afterNormalized = JSON.stringify(updated);
  const changed = beforeNormalized !== afterNormalized;

  return {
    changed,
    updatedJsonText: JSON.stringify(updated, null, 2) + '\n',
  };
}

/**
 * Batch upload (at most 1 `scp` call) and batch install/configure (at most 1 `ssh` call).
 */
async function applyRemoteDeployment({
  sshPath,
  scpPath,
  target,
  configFile,
  timeoutSeconds,
  env,
  ideArchiveLocalPath,
  agyLocalPath,
  agyIsTarGz,
  updatedMachineSettingsJson,
  remoteHome,
  serverDataDir,
  serverDir,
  serverScript,
  serverApplicationName,
  log,
}) {
  const runId = crypto.randomBytes(6).toString('hex');
  const tmpDirLocal = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-scp-stage-'));
  const stagedFiles = [];

  let remoteIdeTmp = '';
  let remoteAgyTmp = '';

  try {
    if (ideArchiveLocalPath) {
      const name = `ag-reh-${runId}.tar.gz`;
      const staged = path.join(tmpDirLocal, name);
      fs.copyFileSync(ideArchiveLocalPath, staged);
      stagedFiles.push(staged);
      remoteIdeTmp = `/tmp/${name}`;
    }

    if (agyLocalPath) {
      const name = `ag-agy-${runId}${agyIsTarGz ? '.tar.gz' : '.bin'}`;
      const staged = path.join(tmpDirLocal, name);
      fs.copyFileSync(agyLocalPath, staged);
      stagedFiles.push(staged);
      remoteAgyTmp = `/tmp/${name}`;
    }

    if (stagedFiles.length > 0) {
      const scpEndpoint = buildEndpointAndArgs(target, configFile, timeoutSeconds, true);
      log(`Uploading ${stagedFiles.length} package(s) in a single SCP session -> ${scpEndpoint.destination}:/tmp/`);
      const scpArgs = [...scpEndpoint.args, '-q', ...stagedFiles, `${scpEndpoint.destination}:/tmp/`];
      const scpRes = await execBinary(scpPath, scpArgs, { env });
      if (scpRes.code !== 0) {
        throw new Error(`SCP upload failed (exit ${scpRes.code}): ${scpRes.stderr.trim() || scpRes.stdout.trim()}`);
      }
    }
  } finally {
    try {
      fs.rmSync(tmpDirLocal, { recursive: true, force: true });
    } catch {}
  }

  const hasRemoteWork = Boolean(
    remoteIdeTmp || remoteAgyTmp || updatedMachineSettingsJson !== undefined
  );
  if (!hasRemoteWork) {
    return;
  }

  const home = remoteHome.replace(/\/+$/, '');
  const agyInstallDir = `${home}/.gemini/bin`;
  const agyInstallPath = `${agyInstallDir}/agy`;
  const settingsPath = `${serverDataDir}/data/Machine/settings.json`;

  const lines = [
    'set -e',
    'cleanup() {',
    remoteIdeTmp ? `  rm -f "${remoteIdeTmp}"` : '  :',
    remoteAgyTmp ? `  rm -f "${remoteAgyTmp}"` : '  :',
    `  rm -rf "${agyInstallDir}/.unpack_offline"`,
    '}',
    'trap cleanup EXIT',
  ];

  if (remoteIdeTmp) {
    lines.push(
      `SERVER_DATA_DIR="${serverDataDir}"`,
      `SERVER_DIR="${serverDir}"`,
      `SERVER_SCRIPT="${serverScript}"`,
      'rm -f "$SERVER_DATA_DIR/.installation_lock"',
      'rm -rf "$SERVER_DIR"',
      'mkdir -p "$SERVER_DIR"',
      `tar -xzf "${remoteIdeTmp}" -C "$SERVER_DIR"`,
      'if [ ! -f "$SERVER_SCRIPT" ]; then',
      `  NESTED_BIN=$(find "$SERVER_DIR" -maxdepth 3 -type f -name "${serverApplicationName}" | head -n 1 || true)`,
      '  if [ -n "$NESTED_BIN" ]; then',
      '    NESTED_ROOT=$(dirname "$(dirname "$NESTED_BIN")")',
      '    if [ "$NESTED_ROOT" != "$SERVER_DIR" ]; then',
      '      cp -a "$NESTED_ROOT"/. "$SERVER_DIR"/',
      '    fi',
      '  fi',
      'fi',
      'if [ ! -f "$SERVER_SCRIPT" ]; then',
      '  echo "ERROR: IDE server binary missing after extraction: $SERVER_SCRIPT" >&2',
      '  exit 1',
      'fi',
      'chmod +x "$SERVER_SCRIPT"'
    );
  }

  if (remoteAgyTmp) {
    lines.push(
      `AGY_DIR="${agyInstallDir}"`,
      `AGY_PATH="${agyInstallPath}"`,
      'mkdir -p "$AGY_DIR"',
      'rm -f "$AGY_DIR/.agy-install.lock"'
    );
    if (agyIsTarGz) {
      lines.push(
        'UNPACK_DIR="$AGY_DIR/.unpack_offline"',
        'rm -rf "$UNPACK_DIR" && mkdir -p "$UNPACK_DIR"',
        `tar -xzf "${remoteAgyTmp}" -C "$UNPACK_DIR"`,
        'FOUND=""',
        'for cand in antigravity agy cli bin/antigravity bin/agy bin/cli; do',
        '  if [ -f "$UNPACK_DIR/$cand" ]; then FOUND="$UNPACK_DIR/$cand"; break; fi',
        'done',
        'if [ -z "$FOUND" ]; then',
        '  echo "ERROR: Could not find agy executable inside archive" >&2',
        '  exit 1',
        'fi',
        'chmod 755 "$FOUND"',
        'mv -f "$FOUND" "$AGY_PATH"'
      );
    } else {
      lines.push(`chmod 755 "${remoteAgyTmp}"`, `mv -f "${remoteAgyTmp}" "$AGY_PATH"`);
    }
  }

  if (updatedMachineSettingsJson !== undefined) {
    const b64 = Buffer.from(updatedMachineSettingsJson, 'utf8').toString('base64');
    lines.push(
      `SETTINGS_DIR="${serverDataDir}/data/Machine"`,
      `SETTINGS_FILE="${settingsPath}"`,
      'mkdir -p "$SETTINGS_DIR"',
      `printf '%s' '${b64}' | base64 -d > "$SETTINGS_FILE.tmp"`,
      'mv -f "$SETTINGS_FILE.tmp" "$SETTINGS_FILE"'
    );
  }

  lines.push('echo "AG_BATCH_APPLY_OK"');

  const sshEndpoint = buildEndpointAndArgs(target, configFile, timeoutSeconds, false);
  const sshArgs = [...sshEndpoint.args, '-T', sshEndpoint.destination, 'sh', '-s'];
  const sshRes = await execBinary(sshPath, sshArgs, { env, stdinData: lines.join('\n') + '\n' });
  if (sshRes.code !== 0 || !sshRes.stdout.includes('AG_BATCH_APPLY_OK')) {
    throw new Error(
      `Remote setup failed (exit ${sshRes.code}): ${sshRes.stderr.trim() || sshRes.stdout.trim()}`
    );
  }
}

function stripJsonComments(str) {
  let out = '';
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const next = str[i + 1];
    if (inStr) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < str.length && str[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < str.length && !(str[i] === '*' && str[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

module.exports = {
  resolveSshTools,
  execBinary,
  buildEndpointAndArgs,
  createAskpassContext,
  isWindowsRemoteHostError,
  probeRemoteHost,
  computeDesiredMachineSettings,
  applyRemoteDeployment,
  stripJsonComments,
};
