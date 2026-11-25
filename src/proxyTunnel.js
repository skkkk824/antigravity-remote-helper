'use strict';

const cp = require('child_process');
const dns = require('dns');
const http = require('http');
const net = require('net');
const { buildEndpointAndArgs, execBinary } = require('./sshRunner');

const SOCKET_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const HEALTHCHECK_HOST = 'ag-tunnel.healthz';
const HEALTHCHECK_PATH = '/__healthz';
const HEALTHCHECK_TOKEN = 'ag-offline-ssh-ok';

/**
 * Check whether an IPv4 or IPv6 literal is loopback, unspecified, or link-local.
 * Prevents SSRF / reverse-tunnel access to local services on the developer's PC.
 * @param {string} ip
 * @returns {boolean}
 */
function isBlockedIp(ip) {
  if (!ip) return true;
  const clean = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');

  if (net.isIPv4(clean)) {
    const parts = clean.split('.').map((n) => parseInt(n, 10));
    // 127.0.0.0/8 (loopback), 0.0.0.0/8 (unspecified), 169.254.0.0/16 (link-local / metadata)
    if (parts[0] === 127 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    return false;
  }

  if (net.isIPv6(clean)) {
    if (clean === '::1' || clean === '::' || clean === '0:0:0:0:0:0:0:1' || clean === '0:0:0:0:0:0:0:0') {
      return true;
    }
    if (clean.startsWith('fe8') || clean.startsWith('fe9') || clean.startsWith('fea') || clean.startsWith('feb')) {
      return true;
    }
    if (clean.startsWith('::ffff:')) {
      const v4 = clean.slice('::ffff:'.length);
      if (net.isIPv4(v4)) return isBlockedIp(v4);
    }
    return false;
  }

  return false;
}

/**
 * Check whether a hostname is a local/loopback hostname before DNS lookup.
 * @param {string} hostname
 * @returns {boolean}
 */
function isBlockedHostname(hostname) {
  if (!hostname) return true;
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (
    h === 'localhost' ||
    h === 'localhost.localdomain' ||
    h.endsWith('.localhost')
  ) {
    return true;
  }
  if (net.isIP(h)) {
    return isBlockedIp(h);
  }
  return false;
}

/**
 * Resolve hostname and verify the resolved IP is not loopback/link-local (defeats DNS rebinding).
 * @param {string} hostname
 * @param {boolean} allowLoopbackForTests
 * @returns {Promise<string>}
 */
function resolveSafeTargetIp(hostname, allowLoopbackForTests = false) {
  const clean = hostname.trim().replace(/^\[|\]$/g, '');
  if (!allowLoopbackForTests && isBlockedHostname(clean)) {
    return Promise.reject(new Error(`Blocked local/loopback proxy target: ${hostname}`));
  }
  if (net.isIP(clean)) {
    return Promise.resolve(clean);
  }
  return new Promise((resolve, reject) => {
    dns.lookup(clean, { all: false }, (err, address) => {
      if (err) return reject(err);
      if (!allowLoopbackForTests && isBlockedIp(address)) {
        return reject(new Error(`Blocked DNS-rebound loopback target: ${hostname} -> ${address}`));
      }
      resolve(address);
    });
  });
}

/**
 * Bridge two TCP sockets with TCP_NODELAY, idle timeout, and guaranteed bidirectional destroy.
 */
function bridgeSockets(sockA, sockB, idleTimeoutMs = SOCKET_IDLE_TIMEOUT_MS) {
  let closed = false;
  const teardown = () => {
    if (closed) return;
    closed = true;
    try {
      sockA.destroy();
    } catch {}
    try {
      sockB.destroy();
    } catch {}
  };

  for (const s of [sockA, sockB]) {
    try {
      s.setNoDelay(true);
      s.setTimeout(idleTimeoutMs);
    } catch {}
    s.on('timeout', teardown);
    s.on('error', teardown);
    s.on('close', teardown);
    s.on('end', teardown);
  }

  sockA.pipe(sockB);
  sockB.pipe(sockA);
}

/**
 * Local loopback HTTP / HTTPS CONNECT forward proxy + SSH `-R` reverse tunnel manager.
 */
class ProxyTunnelManager {
  /**
   * @param {{log: (msg: string) => void, onStateChange?: () => void, allowLoopbackTargetsForTest?: boolean}} opts
   */
  constructor(opts = {}) {
    this.log = opts.log || (() => {});
    this.onStateChange = opts.onStateChange || (() => {});
    this.allowLoopbackTargetsForTest = Boolean(opts.allowLoopbackTargetsForTest);
    this.proxyServer = null;
    this.proxyListening = false;
    this.currentPort = 0;
    this.upstreamProxyUrl = '';
    this.retryTimer = null;

    /** @type {Map<string, {target: string, port: number, proc: cp.ChildProcess|null, timer: NodeJS.Timeout|null, state: 'connecting'|'active'|'shared'|'stopped', stopped: boolean}>} */
    this.tunnels = new Map();
    this.disposed = false;
  }

  async ensureLocalProxy(port, upstreamProxyUrl = '') {
    this.upstreamProxyUrl = (upstreamProxyUrl || '').trim();
    if (this.disposed) return;

    if (this.proxyServer && this.proxyListening && this.currentPort === port) {
      return;
    }

    this._stopProxyServer();
    this.currentPort = port;
    await this._tryListen(port);
  }

  _tryListen(port) {
    if (this.disposed) return Promise.resolve(false);

    return new Promise((resolve) => {
      const server = http.createServer((req, res) => this._handleHttpRequest(req, res));
      server.on('connect', (req, clientSocket, head) =>
        this._handleConnect(req, clientSocket, head)
      );

      server.once('error', (err) => {
        if (err && err.code === 'EADDRINUSE') {
          this.proxyListening = false;
          this.proxyServer = null;
          this._scheduleProxyTakeover(port);
          resolve(true);
          return;
        }
        this.log(`Local proxy server error: ${err.message || err}`);
        resolve(false);
      });

      server.listen(port, '127.0.0.1', () => {
        this.proxyServer = server;
        this.proxyListening = true;
        if (this.retryTimer) {
          clearTimeout(this.retryTimer);
          this.retryTimer = null;
        }
        this.log(`Local forward proxy listening on 127.0.0.1:${port}`);
        this.onStateChange();
        resolve(true);
      });
    });
  }

  _scheduleProxyTakeover(port) {
    if (this.disposed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.disposed && !this.proxyListening && this.currentPort === port) {
        this._tryListen(port);
      }
    }, 3000);
    if (this.retryTimer.unref) this.retryTimer.unref();
  }

  async _handleHttpRequest(clientReq, clientRes) {
    try {
      // Built-in health probe used to distinguish healthy peer tunnel vs zombie sshd
      if (
        clientReq.url === `http://${HEALTHCHECK_HOST}${HEALTHCHECK_PATH}` ||
        (clientReq.headers.host === HEALTHCHECK_HOST && clientReq.url === HEALTHCHECK_PATH)
      ) {
        clientRes.writeHead(200, { 'Content-Type': 'text/plain' });
        clientRes.end(HEALTHCHECK_TOKEN);
        return;
      }

      const targetUrl = new URL(clientReq.url);
      if (!this.allowLoopbackTargetsForTest && isBlockedHostname(targetUrl.hostname)) {
        clientRes.writeHead(403, { 'Content-Type': 'text/plain' });
        clientRes.end('Forbidden: loopback/link-local target is blocked');
        return;
      }

      const upstream = this.upstreamProxyUrl ? new URL(this.upstreamProxyUrl) : null;
      let connectHost = targetUrl.hostname;
      if (!upstream) {
        connectHost = await resolveSafeTargetIp(targetUrl.hostname, this.allowLoopbackTargetsForTest);
      }

      const reqOpts = upstream
        ? {
            host: upstream.hostname,
            port: parseInt(upstream.port || '80', 10),
            method: clientReq.method,
            path: clientReq.url,
            headers: { ...clientReq.headers, host: targetUrl.host },
            timeout: 30000,
          }
        : {
            host: connectHost,
            port: parseInt(targetUrl.port || '80', 10),
            method: clientReq.method,
            path: `${targetUrl.pathname}${targetUrl.search}`,
            headers: { ...clientReq.headers, host: targetUrl.host },
            timeout: 30000,
          };

      const proxyReq = http.request(reqOpts, (proxyRes) => {
        clientRes.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(clientRes);
      });
      proxyReq.on('timeout', () => proxyReq.destroy(new Error('Upstream timeout')));
      proxyReq.on('error', (err) => {
        if (!clientRes.headersSent) clientRes.writeHead(502);
        clientRes.end(`Bad Gateway: ${err.message}`);
      });
      clientReq.on('error', () => proxyReq.destroy());
      clientReq.pipe(proxyReq);
    } catch (err) {
      const status = /Blocked/i.test(err.message || '') ? 403 : 400;
      if (!clientRes.headersSent) clientRes.writeHead(status);
      clientRes.end(err.message || 'Proxy error');
    }
  }

  async _handleConnect(req, clientSocket, head) {
    clientSocket.on('error', () => {});

    const authority = req.url || '';
    const colonIdx = authority.lastIndexOf(':');
    const targetHost = colonIdx > 0 ? authority.slice(0, colonIdx) : authority;
    const targetPort = parseInt(colonIdx > 0 ? authority.slice(colonIdx + 1) : '443', 10);

    if (!targetHost || Number.isNaN(targetPort)) {
      clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    if (!this.allowLoopbackTargetsForTest && isBlockedHostname(targetHost)) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    if (this.upstreamProxyUrl) {
      let proxyObj;
      try {
        proxyObj = new URL(this.upstreamProxyUrl);
      } catch {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.destroy();
        return;
      }
      const proxyPort = parseInt(proxyObj.port || '80', 10);
      const upstreamSocket = net.connect(proxyPort, proxyObj.hostname, () => {
        const lines = [
          `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
          `Host: ${targetHost}:${targetPort}`,
        ];
        if (proxyObj.username || proxyObj.password) {
          const auth = Buffer.from(
            `${decodeURIComponent(proxyObj.username)}:${decodeURIComponent(proxyObj.password)}`
          ).toString('base64');
          lines.push(`Proxy-Authorization: Basic ${auth}`);
        }
        lines.push('', '');
        upstreamSocket.write(lines.join('\r\n'));
      });

      let respBuf = Buffer.alloc(0);
      const onUpstreamData = (chunk) => {
        respBuf = Buffer.concat([respBuf, chunk]);
        const headerEnd = respBuf.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
          if (respBuf.length > 16384) {
            upstreamSocket.destroy();
            clientSocket.destroy();
          }
          return;
        }
        upstreamSocket.removeListener('data', onUpstreamData);
        const headerText = respBuf.slice(0, headerEnd).toString('latin1');
        const remainder = respBuf.slice(headerEnd + 4);
        const statusLine = headerText.split('\r\n')[0] || '';
        if (!/^HTTP\/\d\.\d\s+200\b/.test(statusLine)) {
          try {
            clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          } catch {}
          upstreamSocket.destroy();
          clientSocket.destroy();
          return;
        }

        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length > 0) upstreamSocket.write(head);
        if (remainder.length > 0) clientSocket.write(remainder);
        bridgeSockets(clientSocket, upstreamSocket);
      };

      upstreamSocket.on('data', onUpstreamData);
      upstreamSocket.once('error', () => {
        try {
          clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        } catch {}
        clientSocket.destroy();
      });
      return;
    }

    let connectIp;
    try {
      connectIp = await resolveSafeTargetIp(targetHost, this.allowLoopbackTargetsForTest);
    } catch (err) {
      const code = /Blocked/i.test(err.message || '') ? '403 Forbidden' : '502 Bad Gateway';
      try {
        clientSocket.write(`HTTP/1.1 ${code}\r\n\r\n`);
      } catch {}
      clientSocket.destroy();
      return;
    }

    const remoteSocket = net.connect(targetPort, connectIp, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) remoteSocket.write(head);
      bridgeSockets(clientSocket, remoteSocket);
    });

    remoteSocket.once('error', () => {
      try {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      } catch {}
      clientSocket.destroy();
    });
  }

  /**
   * Check whether a remote port that rejected `-R` is a healthy peer window tunnel
   * or a dead zombie `sshd` left behind after sleep/disconnect, and clean up zombies.
   */
  async _probeOrCleanZombieRemotePort({ sshPath, target, configFile, timeoutSeconds, port, env }) {
    const { destination, args: baseArgs } = buildEndpointAndArgs(
      target,
      configFile,
      timeoutSeconds,
      false
    );
    const script = [
      `PORT=${port}`,
      'RESP=""',
      'if command -v curl >/dev/null 2>&1; then',
      `  RESP=$(curl -s --max-time 2 -x "http://127.0.0.1:$PORT" "http://${HEALTHCHECK_HOST}${HEALTHCHECK_PATH}" 2>/dev/null || true)`,
      'elif command -v wget >/dev/null 2>&1; then',
      `  RESP=$( env http_proxy="http://127.0.0.1:$PORT" wget -q -T 2 -O - "http://${HEALTHCHECK_HOST}${HEALTHCHECK_PATH}" 2>/dev/null || true)`,
      'fi',
      `if [ "$RESP" = "${HEALTHCHECK_TOKEN}" ]; then`,
      '  echo "TUNNEL_HEALTHY"',
      '  exit 0',
      'fi',
      '# Port is occupied on remote host but unhealthy -> kill stale sshd listener owned by current user',
      'PIDS=""',
      'if command -v lsof >/dev/null 2>&1; then',
      '  PIDS=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN -u "$(id -un)" 2>/dev/null || true)',
      'elif command -v ss >/dev/null 2>&1; then',
      '  PIDS=$(ss -tlpn "sport = :$PORT" 2>/dev/null | sed -n "s/.*pid=\\([0-9]*\\).*/\\1/p" | sort -u)',
      'fi',
      'if [ -n "$PIDS" ]; then',
      '  for p in $PIDS; do',
      '    CMD=$(ps -o comm= -p "$p" 2>/dev/null || true)',
      '    case "$CMD" in *sshd*) kill "$p" 2>/dev/null || true ;; esac',
      '  done',
      '  echo "ZOMBIE_KILLED"',
      'else',
      '  echo "PORT_BUSY_UNKNOWN"',
      'fi',
    ].join('\n');

    try {
      const res = await execBinary(sshPath, [...baseArgs, '-T', destination, 'sh', '-s'], {
        env,
        stdinData: script + '\n',
      });
      if (res.stdout.includes('TUNNEL_HEALTHY')) return 'healthy_peer';
      if (res.stdout.includes('ZOMBIE_KILLED')) return 'zombie_killed';
    } catch {}
    return 'unknown';
  }

  ensureReverseTunnel({ sshPath, target, configFile, timeoutSeconds, port, env }) {
    if (this.disposed || !target) return;
    const existing = this.tunnels.get(target);
    if (existing && !existing.stopped && existing.port === port) {
      return;
    }
    if (existing) {
      this.stopTunnel(target);
    }

    const entry = {
      target,
      port,
      proc: null,
      timer: null,
      state: 'connecting',
      stopped: false,
    };
    this.tunnels.set(target, entry);
    this.onStateChange();

    const launch = () => {
      if (this.disposed || entry.stopped) return;

      const { destination, args: baseArgs } = buildEndpointAndArgs(
        target,
        configFile,
        timeoutSeconds,
        false
      );
      const args = [
        ...baseArgs,
        '-N',
        '-T',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'ServerAliveInterval=20',
        '-o',
        'ServerAliveCountMax=3',
        '-R',
        `127.0.0.1:${port}:127.0.0.1:${port}`,
        destination,
      ];

      const child = cp.spawn(sshPath, args, {
        env: env || process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      entry.proc = child;

      let stderr = '';
      child.stderr.on('data', (d) => {
        stderr += d.toString('utf8');
      });

      const activeTimer = setTimeout(() => {
        if (entry.proc === child && !entry.stopped) {
          entry.state = 'active';
          this.log(`Reverse proxy tunnel active: ${target} (127.0.0.1:${port})`);
          this.onStateChange();
        }
      }, 1500);
      if (activeTimer.unref) activeTimer.unref();

      child.on('error', (err) => {
        clearTimeout(activeTimer);
        entry.state = 'connecting';
        this.log(`Reverse tunnel spawn error (${target}): ${err.message}`);
        this.onStateChange();
        scheduleRetry(5000);
      });

      child.on('close', async (code) => {
        clearTimeout(activeTimer);
        entry.proc = null;
        if (this.disposed || entry.stopped) return;

        const forwardFailed = /remote port forwarding failed/i.test(stderr);
        if (forwardFailed) {
          const check = await this._probeOrCleanZombieRemotePort({
            sshPath,
            target,
            configFile,
            timeoutSeconds,
            port,
            env,
          });
          if (this.disposed || entry.stopped) return;
          if (check === 'healthy_peer') {
            if (entry.state !== 'shared') {
              entry.state = 'shared';
              this.log(`Tunnel port ${port} on ${target} is already served by another active window.`);
              this.onStateChange();
            }
            scheduleRetry(6000);
            return;
          }
          if (check === 'zombie_killed') {
            this.log(`Cleaned up stale zombie sshd holding port ${port} on ${target}; reconnecting immediately.`);
            entry.state = 'connecting';
            this.onStateChange();
            scheduleRetry(500);
            return;
          }
        }

        entry.state = 'connecting';
        this.onStateChange();
        if (stderr.trim() && !forwardFailed) {
          this.log(`Reverse tunnel (${target}) exited (${code}): ${stderr.trim()}`);
        }
        scheduleRetry(3000);
      });
    };

    const scheduleRetry = (delayMs) => {
      if (this.disposed || entry.stopped || entry.timer) return;
      entry.timer = setTimeout(() => {
        entry.timer = null;
        launch();
      }, delayMs);
      if (entry.timer.unref) entry.timer.unref();
    };

    launch();
  }

  stopTunnel(target) {
    const entry = this.tunnels.get(target);
    if (!entry) return false;
    entry.stopped = true;
    entry.state = 'stopped';
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.proc) {
      try {
        entry.proc.kill();
      } catch {}
    }
    this.tunnels.delete(target);
    this.log(`Stopped reverse proxy tunnel for ${target}`);
    this.onStateChange();
    return true;
  }

  stopAllTunnels() {
    for (const target of Array.from(this.tunnels.keys())) {
      this.stopTunnel(target);
    }
  }

  /**
   * @param {string} target
   * @returns {'active'|'shared'|'connecting'|null}
   */
  getHostTunnelState(target) {
    const entry = this.tunnels.get(target);
    if (!entry || entry.stopped) return null;
    return entry.state;
  }

  getActiveTunnelCount() {
    let count = 0;
    for (const entry of this.tunnels.values()) {
      if (entry.state === 'active' || entry.state === 'shared') count++;
    }
    return count;
  }

  _stopProxyServer() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.proxyServer) {
      try {
        this.proxyServer.close();
      } catch {}
      this.proxyServer = null;
    }
    this.proxyListening = false;
  }

  dispose() {
    this.disposed = true;
    this._stopProxyServer();
    this.stopAllTunnels();
  }
}

module.exports = {
  ProxyTunnelManager,
  isBlockedIp,
  isBlockedHostname,
  HEALTHCHECK_HOST,
  HEALTHCHECK_PATH,
  HEALTHCHECK_TOKEN,
};
