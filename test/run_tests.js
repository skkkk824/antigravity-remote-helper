'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const {
  parseSshConfigFile,
  parseSshTarget,
  encodeRemoteAuthority,
  decodeRemoteAuthority,
} = require('../src/sshConfig');
const {
  readServerConfigFromAppRoot,
  mapRemotePlatform,
  buildDownloadUrls,
  getRemotePaths,
} = require('../src/serverInfo');
const { fetchText, downloadFromMirrors } = require('../src/downloader');
const {
  mapAgyPlatform,
  resolveAgyBinaryFromManifest,
  fetchAgyReleaseManifest,
} = require('../src/agyInstaller');
const {
  resolveSshTools,
  buildEndpointAndArgs,
  isWindowsRemoteHostError,
  computeDesiredMachineSettings,
  stripJsonComments,
} = require('../src/sshRunner');
const {
  ProxyTunnelManager,
  isBlockedIp,
  isBlockedHostname,
  HEALTHCHECK_HOST,
  HEALTHCHECK_PATH,
  HEALTHCHECK_TOKEN,
} = require('../src/proxyTunnel');

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-offline-ssh-test-'));
  try {
    // 1. Test encodeRemoteAuthority & decodeRemoteAuthority
    const encoded1 = encodeRemoteAuthority('10.1.130.53');
    assert.strictEqual(
      encoded1,
      'ssh-remote+7b22686f73744e616d65223a2231302e312e3133302e3533227d'
    );
    assert.strictEqual(decodeRemoteAuthority(encoded1), '10.1.130.53');

    const encoded2 = encodeRemoteAuthority('root@10.1.130.53');
    assert.strictEqual(decodeRemoteAuthority(encoded2), 'root@10.1.130.53');

    assert.deepStrictEqual(parseSshTarget('ubuntu@[::1]:2222'), {
      hostName: '::1',
      user: 'ubuntu',
      port: 2222,
    });

    // 2. Test SSRF / loopback blocking
    assert.strictEqual(isBlockedIp('127.0.0.1'), true);
    assert.strictEqual(isBlockedIp('127.255.0.2'), true);
    assert.strictEqual(isBlockedIp('0.0.0.0'), true);
    assert.strictEqual(isBlockedIp('169.254.169.254'), true);
    assert.strictEqual(isBlockedIp('::1'), true);
    assert.strictEqual(isBlockedIp('::ffff:127.0.0.1'), true);
    assert.strictEqual(isBlockedIp('8.8.8.8'), false);
    assert.strictEqual(isBlockedHostname('localhost'), true);
    assert.strictEqual(isBlockedHostname('api.localhost'), true);
    assert.strictEqual(isBlockedHostname('antigravity.google'), false);

    // Verify default ProxyTunnelManager blocks loopback HTTP & CONNECT requests with 403
    const secProxy = new ProxyTunnelManager({ log: () => {} });
    const pProbe = http.createServer();
    await new Promise((r) => pProbe.listen(0, '127.0.0.1', r));
    const secPort = pProbe.address().port;
    await new Promise((r) => pProbe.close(r));

    await secProxy.ensureLocalProxy(secPort, '');
    try {
      // Healthcheck works
      const hcRes = await fetchText(`http://${HEALTHCHECK_HOST}${HEALTHCHECK_PATH}`, {
        proxyUrl: `http://127.0.0.1:${secPort}`,
      });
      assert.strictEqual(hcRes.statusCode, 200);
      assert.strictEqual(hcRes.body, HEALTHCHECK_TOKEN);

      // Loopback HTTP GET is blocked with 403
      const blockedHttp = await fetchText('http://127.0.0.1:8080/secret', {
        proxyUrl: `http://127.0.0.1:${secPort}`,
      });
      assert.strictEqual(blockedHttp.statusCode, 403);

      // Loopback HTTPS CONNECT is blocked with 403
      const connectStatus = await new Promise((resolve, reject) => {
        const s = net.connect(secPort, '127.0.0.1', () => {
          s.write('CONNECT localhost:445 HTTP/1.1\r\nHost: localhost:445\r\n\r\n');
        });
        let data = '';
        s.on('data', (c) => {
          data += c.toString('latin1');
          if (data.includes('\r\n\r\n')) {
            s.destroy();
            resolve(data.split('\r\n')[0]);
          }
        });
        s.on('error', reject);
      });
      assert.match(connectStatus, /403 Forbidden/);
    } finally {
      secProxy.dispose();
    }

    // 3. Test computeDesiredMachineSettings (idempotence + terminal proxy env merge)
    const initialRaw = '{\n  // user comment\n  "editor.tabSize": 2,\n  "terminal.integrated.env.linux": {\n    "MY_VAR": "abc"\n  }\n}\n';
    const step1 = computeDesiredMachineSettings(initialRaw, {
      enableProxyTunnel: true,
      enableTerminalProxy: true,
      tunnelPort: 17891,
      platform: 'linux',
    });
    assert.strictEqual(step1.changed, true);
    const step1Obj = JSON.parse(step1.updatedJsonText);
    assert.strictEqual(step1Obj['http.proxy'], 'http://127.0.0.1:17891');
    assert.strictEqual(step1Obj['terminal.integrated.env.linux'].MY_VAR, 'abc');
    assert.strictEqual(
      step1Obj['terminal.integrated.env.linux'].HTTPS_PROXY,
      'http://127.0.0.1:17891'
    );

    // Re-running with identical settings must produce `changed: false` (zero extra SSH write!)
    const step2 = computeDesiredMachineSettings(step1.updatedJsonText, {
      enableProxyTunnel: true,
      enableTerminalProxy: true,
      tunnelPort: 17891,
      platform: 'linux',
    });
    assert.strictEqual(step2.changed, false);

    // Turning off enableTerminalProxy removes proxy keys while preserving MY_VAR
    const step3 = computeDesiredMachineSettings(step1.updatedJsonText, {
      enableProxyTunnel: true,
      enableTerminalProxy: false,
      tunnelPort: 17891,
      platform: 'linux',
    });
    assert.strictEqual(step3.changed, true);
    const step3Obj = JSON.parse(step3.updatedJsonText);
    assert.deepStrictEqual(step3Obj['terminal.integrated.env.linux'], { MY_VAR: 'abc' });

    // 4. Test serverInfo against locally installed Antigravity IDE product.json (if present)
    const appRoot = process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Antigravity IDE', 'resources', 'app')
      : '';
    if (appRoot && fs.existsSync(path.join(appRoot, 'product.json'))) {
      const cfg = readServerConfigFromAppRoot(appRoot, '1.107.0', '');
      assert.strictEqual(cfg.ideVersion, '2.8.0');
      const { platform, serverArch } = mapRemotePlatform('Linux', 'x86_64');
      const { urls } = buildDownloadUrls(cfg, platform, serverArch);
      assert.strictEqual(
        urls[0],
        'https://edgedl.me.gvt1.com/edgedl/release2/j0qc3/antigravity/stable/2.8.0-8dc5315afe097a21a6cb38dda76edc0835dfabfa/linux-x64/Antigravity%20IDE-reh.tar.gz'
      );
      const remotePaths = getRemotePaths('/root/', cfg);
      assert.strictEqual(
        remotePaths.serverScript,
        '/root/.antigravity-ide-server/bin/2.8.0-8dc5315afe097a21a6cb38dda76edc0835dfabfa/bin/antigravity-ide-server'
      );
    }

    // 5. Test agyInstaller + downloader + ProxyTunnelManager forwarding (with allowLoopbackTargetsForTest)
    const rawBinContent = Buffer.from('#!/bin/sh\necho "1.2.3"\n');
    const rawBinSha256 = crypto.createHash('sha256').update(rawBinContent).digest('hex');
    const gzPayload = zlib.gzipSync(Buffer.from('fake-tar-content'));

    const mockOrigin = http.createServer((req, res) => {
      if (req.url === '/manifests/linux_amd64.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            version: '1.2.3',
            url: `http://127.0.0.1:${originPort}/agy-linux-amd64`,
            sha256: rawBinSha256,
          })
        );
      } else if (req.url === '/agy-linux-amd64') {
        res.writeHead(200, { 'Content-Length': String(rawBinContent.length) });
        res.end(rawBinContent);
      } else if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/ok.tar.gz' });
        res.end();
      } else if (req.url === '/ok.tar.gz') {
        res.writeHead(200, { 'Content-Length': String(gzPayload.length) });
        res.end(gzPayload);
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
    await new Promise((resolve) => mockOrigin.listen(0, '127.0.0.1', resolve));
    const originPort = mockOrigin.address().port;

    const tunnelMgr = new ProxyTunnelManager({
      log: () => {},
      allowLoopbackTargetsForTest: true,
    });
    const probeSrv = http.createServer();
    await new Promise((resolve) => probeSrv.listen(0, '127.0.0.1', resolve));
    const proxyPort = probeSrv.address().port;
    await new Promise((resolve) => probeSrv.close(resolve));

    await tunnelMgr.ensureLocalProxy(proxyPort, '');
    try {
      const manifest = await fetchAgyReleaseManifest(
        `http://127.0.0.1:${originPort}`,
        'linux_amd64',
        { proxyUrl: `http://127.0.0.1:${proxyPort}` }
      );
      const resolved = resolveAgyBinaryFromManifest(manifest, 'linux', 'x64');
      assert.strictEqual(resolved.version, '1.2.3');

      const outBin = path.join(tmpDir, 'cache', 'agy-bin');
      const dlBin = await downloadFromMirrors([resolved.url], outBin, {
        proxyUrl: `http://127.0.0.1:${proxyPort}`,
        expectGzip: false,
        expectedSha256: resolved.sha256,
      });
      assert.strictEqual(dlBin.size, rawBinContent.length);

      const outArchive = path.join(tmpDir, 'cache', 'test.tar.gz');
      const dlGz = await downloadFromMirrors(
        [`http://127.0.0.1:${originPort}/missing`, `http://127.0.0.1:${originPort}/redirect`],
        outArchive
      );
      assert.strictEqual(dlGz.size, gzPayload.length);
    } finally {
      tunnelMgr.dispose();
      mockOrigin.close();
    }

    // 6. Test SSH config & endpoint helper
    const cfgPath = path.join(tmpDir, 'ssh_config');
    fs.writeFileSync(cfgPath, 'Host gpu-box\n  HostName 10.1.130.53\n  User root\n', 'utf8');
    assert.strictEqual(parseSshConfigFile(cfgPath)[0].alias, 'gpu-box');
    assert.deepStrictEqual(mapAgyPlatform('Linux', 'x86_64').manifestKey, 'linux_amd64');
    assert.strictEqual(JSON.parse(stripJsonComments('{"a":1,}'))['a'], 1);
    assert.deepStrictEqual(resolveSshTools('', '', ''), { sshPath: 'ssh', scpPath: 'scp' });
    assert.deepStrictEqual(buildEndpointAndArgs('root@10.1.130.53:2222', '', 15, true), {
      destination: 'root@10.1.130.53',
      args: ['-o', 'ConnectTimeout=15', '-P', '2222'],
    });
    assert.strictEqual(
      isWindowsRemoteHostError("'sh' is not recognized as an internal or external command", ''),
      true
    );
    assert.strictEqual(isWindowsRemoteHostError("'sh' \uFFFD\uFFFD\uFFFD\uFFFD", ''), true);
    assert.strictEqual(isWindowsRemoteHostError('Permission denied (publickey).', ''), false);
    assert.throws(() => mapRemotePlatform('MINGW64_NT-10.0', 'x86_64'), /不支持 Windows 远程主机/);

    console.log('ALL V0.3.0 TESTS PASSED');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
