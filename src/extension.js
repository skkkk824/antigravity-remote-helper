'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const {
  resolveSshConfigPath,
  parseSshConfigFile,
  encodeRemoteAuthority,
  decodeRemoteAuthority,
} = require('./sshConfig');
const {
  readServerConfigFromAppRoot,
  mapRemotePlatform,
  buildDownloadUrls,
  getRemotePaths,
} = require('./serverInfo');
const { downloadFromMirrors } = require('./downloader');
const {
  DEFAULT_AGY_RELEASE_BASE_URL,
  mapAgyPlatform,
  resolveAgyBinaryFromManifest,
  fetchAgyReleaseManifest,
} = require('./agyInstaller');
const {
  resolveSshTools,
  createAskpassContext,
  probeRemoteHost,
  computeDesiredMachineSettings,
  applyRemoteDeployment,
} = require('./sshRunner');
const { ProxyTunnelManager } = require('./proxyTunnel');

const STATE_KNOWN_TARGETS = 'knownTunnelTargets';

class HostItem extends vscode.TreeItem {
  /**
   * @param {{alias: string, hostName?: string, user?: string, port?: string}} host
   * @param {'active'|'shared'|'connecting'|null} tunnelState
   * @param {number} tunnelPort
   */
  constructor(host, tunnelState, tunnelPort) {
    super(host.alias, vscode.TreeItemCollapsibleState.None);
    this.host = host;

    const isTunnelUp = tunnelState === 'active' || tunnelState === 'shared';
    this.contextValue = tunnelState ? 'sshHostTunneled' : 'sshHost';

    if (isTunnelUp) {
      this.iconPath = new vscode.ThemeIcon(
        'radio-tower',
        new vscode.ThemeColor('testing.iconPassed')
      );
    } else if (tunnelState === 'connecting') {
      this.iconPath = new vscode.ThemeIcon('sync~spin');
    } else {
      this.iconPath = new vscode.ThemeIcon('remote');
    }

    const details = [];
    if (host.user) details.push(host.user);
    if (host.hostName && host.hostName !== host.alias) {
      details.push(host.hostName);
    }
    if (host.port && host.port !== '22') {
      details.push(`port ${host.port}`);
    }
    if (isTunnelUp) {
      details.push(`Tunnel :${tunnelPort}`);
    } else if (tunnelState === 'connecting') {
      details.push('reconnecting...');
    }

    this.description = details.join(' · ');
    this.tooltip = isTunnelUp
      ? `${host.alias} — Reverse proxy tunnel active on 127.0.0.1:${tunnelPort}`
      : `Deploy IDE server + AGY CLI & connect to ${host.alias}`;
    this.command = {
      command: 'antigravityOfflineSsh.deployAndConnect',
      title: 'Deploy Server & Connect',
      arguments: [this],
    };
  }
}

class OfflineSshHostsProvider {
  constructor(tunnelManager) {
    this.tunnelManager = tunnelManager;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    return element;
  }

  getChildren() {
    const settings = getSettings();
    const hosts = parseSshConfigFile(settings.configFile);
    return hosts.map((h) => {
      const state =
        this.tunnelManager.getHostTunnelState(h.alias) ||
        (h.hostName
          ? this.tunnelManager.getHostTunnelState(
              h.user ? `${h.user}@${h.hostName}` : h.hostName
            )
          : null);
      return new HostItem(h, state, settings.tunnelPort);
    });
  }
}

function getEffectiveSshConfigPath() {
  const cfg = vscode.workspace.getConfiguration('antigravityOfflineSsh');
  const agyCfg = vscode.workspace.getConfiguration('remote.antigravitySSH');
  return resolveSshConfigPath(cfg.get('configFile'), agyCfg.get('configFile'));
}

function getSettings() {
  const cfg = vscode.workspace.getConfiguration('antigravityOfflineSsh');
  const agyCfg = vscode.workspace.getConfiguration('remote.antigravitySSH');
  const agyExpCfg = vscode.workspace.getConfiguration('remote.antigravitySSH.experimental');
  const agyCoreCfg = vscode.workspace.getConfiguration('antigravity');

  const configFile = resolveSshConfigPath(cfg.get('configFile'), agyCfg.get('configFile'));
  const explicitConfigFile = (cfg.get('configFile') || agyCfg.get('configFile') || '').trim();
  const { sshPath, scpPath } = resolveSshTools(
    cfg.get('sshPath'),
    agyCfg.get('path'),
    cfg.get('scpPath')
  );

  const tunnelPort = Number(cfg.get('tunnelPort', 17891)) || 17891;
  let proxyUrl = (cfg.get('proxyUrl') || '').trim();
  if (proxyUrl.includes(`127.0.0.1:${tunnelPort}`) || proxyUrl.includes(`localhost:${tunnelPort}`)) {
    proxyUrl = '';
  }

  const enableProxyTunnel = Boolean(cfg.get('enableProxyTunnel', true));
  const enableTerminalProxy = Boolean(cfg.get('enableTerminalProxy', true));
  const deployAgyCli = Boolean(cfg.get('deployAgyCli', true));
  const forceRedeploy = Boolean(cfg.get('forceRedeploy', false));
  const connectTimeoutSeconds = Number(cfg.get('connectTimeoutSeconds', 20)) || 20;
  const overrideBinaryName = agyExpCfg.get('serverBinaryName', '');
  const releaseBaseUrl = (agyCoreCfg.get('releaseBaseUrl') || '').trim() || DEFAULT_AGY_RELEASE_BASE_URL;

  return {
    configFile,
    explicitConfigFile,
    sshPath,
    scpPath,
    proxyUrl,
    enableProxyTunnel,
    enableTerminalProxy,
    tunnelPort,
    deployAgyCli,
    forceRedeploy,
    connectTimeoutSeconds,
    overrideBinaryName,
    releaseBaseUrl,
  };
}

function detectCurrentRemoteTarget() {
  const wfUri = vscode.workspace.workspaceFile;
  if (wfUri && wfUri.scheme === 'vscode-remote' && wfUri.authority.startsWith('ssh-remote+')) {
    return decodeRemoteAuthority(wfUri.authority);
  }
  const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (folderUri && folderUri.scheme === 'vscode-remote' && folderUri.authority.startsWith('ssh-remote+')) {
    return decodeRemoteAuthority(folderUri.authority);
  }
  return undefined;
}

function computeDirectorySizeBytes(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) total += computeDirectorySizeBytes(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const output = vscode.window.createOutputChannel('Antigravity Offline SSH');
  const log = (msg) => {
    const ts = new Date().toISOString();
    output.appendLine(`[${ts}] ${msg}`);
  };

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  statusBar.command = 'antigravityOfflineSsh.deployAndConnect';
  statusBar.show();

  let hostsProvider;
  const tunnelManager = new ProxyTunnelManager({
    log,
    onStateChange: () => {
      updateStatusBar();
      if (hostsProvider) hostsProvider.refresh();
    },
  });

  hostsProvider = new OfflineSshHostsProvider(tunnelManager);

  function updateStatusBar() {
    const count = tunnelManager.getActiveTunnelCount();
    const settings = getSettings();
    if (count > 0) {
      statusBar.text = `$(radio-tower) Offline SSH (Tunnel :${settings.tunnelPort})`;
      statusBar.tooltip = `Offline SSH active: local proxy 127.0.0.1:${settings.tunnelPort} forwarded to ${count} remote host(s)`;
    } else {
      statusBar.text = '$(cloud-upload) Offline SSH';
      statusBar.tooltip = 'Deploy Antigravity Server + AGY CLI locally & connect via SSH';
    }
  }
  updateStatusBar();

  context.subscriptions.push(
    output,
    statusBar,
    tunnelManager,
    vscode.window.registerTreeDataProvider('antigravityOfflineSshHosts', hostsProvider)
  );

  async function rememberTunnelTarget(target) {
    const list = context.globalState.get(STATE_KNOWN_TARGETS, []);
    const filtered = list.filter((x) => x !== target);
    filtered.unshift(target);
    await context.globalState.update(STATE_KNOWN_TARGETS, filtered.slice(0, 5));
  }

  async function syncTunnelWithEnvironment() {
    const settings = getSettings();
    if (!settings.enableProxyTunnel) {
      tunnelManager.stopAllTunnels();
      return;
    }

    await tunnelManager.ensureLocalProxy(settings.tunnelPort, settings.proxyUrl);

    if (vscode.env.remoteName === 'ssh-remote') {
      const currentTarget = detectCurrentRemoteTarget();
      const savedTargets = context.globalState.get(STATE_KNOWN_TARGETS, []);
      const candidates = currentTarget ? [currentTarget] : savedTargets.slice(0, 1);

      for (const target of candidates) {
        tunnelManager.ensureReverseTunnel({
          sshPath: settings.sshPath,
          target,
          configFile: settings.explicitConfigFile,
          timeoutSeconds: settings.connectTimeoutSeconds,
          port: settings.tunnelPort,
        });
      }
    }
  }

  syncTunnelWithEnvironment().catch((err) => {
    log(`Auto-tunnel startup warning: ${err.message || err}`);
  });

  // Live reload on settings or workspace folder changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('antigravityOfflineSsh') ||
        e.affectsConfiguration('remote.antigravitySSH')
      ) {
        hostsProvider.refresh();
        updateStatusBar();
        syncTunnelWithEnvironment().catch((err) => log(`Config reload warning: ${err.message || err}`));
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      syncTunnelWithEnvironment().catch((err) => log(`Workspace folder sync warning: ${err.message || err}`));
    })
  );

  async function pickTargetHost(item) {
    if (item && item.host && item.host.alias) {
      return item.host.alias;
    }
    const { configFile } = getSettings();
    const hosts = parseSshConfigFile(configFile);
    const currentRemote = detectCurrentRemoteTarget();
    const items = [];

    if (currentRemote && !hosts.some((h) => h.alias === currentRemote)) {
      items.push({
        label: currentRemote,
        description: '(current SSH window)',
        alias: currentRemote,
      });
    }

    for (const h of hosts) {
      items.push({
        label: h.alias,
        description: [h.user, h.hostName].filter(Boolean).join('@'),
        detail: h.port ? `Port ${h.port}` : undefined,
        alias: h.alias,
      });
    }

    items.push({
      label: '$(edit) Enter SSH host manually...',
      description: 'e.g. root@10.1.130.53',
      isManual: true,
    });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select an SSH host from ~/.ssh/config or enter one manually',
      matchOnDescription: true,
    });
    if (!picked) return undefined;

    if (picked.isManual) {
      const entered = await vscode.window.showInputBox({
        prompt: 'Enter SSH destination (e.g. root@10.1.130.53 or host alias)',
        placeHolder: 'root@10.1.130.53',
        ignoreFocusOut: true,
      });
      return entered ? entered.trim() : undefined;
    }

    return picked.alias;
  }

  async function ensureLocalIdeArchive(serverConfig, platform, serverArch, proxyUrl, progress, token) {
    const { archiveName, urls } = buildDownloadUrls(serverConfig, platform, serverArch);
    const cacheDir = path.join(
      context.globalStorageUri.fsPath,
      'cache',
      `${serverConfig.ideVersion}-${serverConfig.distroId}`,
      `${platform}-${serverArch}`
    );
    const cachedFile = path.join(cacheDir, archiveName);

    if (fs.existsSync(cachedFile) && fs.statSync(cachedFile).size > 0) {
      log(`Using cached IDE server archive: ${cachedFile}`);
      return cachedFile;
    }

    const controller = new AbortController();
    const sub = token ? token.onCancellationRequested(() => controller.abort()) : undefined;

    let lastPct = -1;
    try {
      progress.report({ message: `Downloading ${archiveName} locally...` });
      const res = await downloadFromMirrors(urls, cachedFile, {
        proxyUrl,
        expectGzip: true,
        signal: controller.signal,
        log,
        onProgress: ({ downloaded, total }) => {
          if (total && total > 0) {
            const pct = Math.floor((downloaded / total) * 100);
            if (pct !== lastPct && pct % 5 === 0) {
              lastPct = pct;
              const mbDone = (downloaded / (1024 * 1024)).toFixed(1);
              const mbTotal = (total / (1024 * 1024)).toFixed(1);
              progress.report({ message: `Downloading ${archiveName}: ${mbDone}/${mbTotal} MB (${pct}%)` });
            }
          }
        },
      });
      log(`Downloaded ${archiveName} (${res.size} bytes) -> ${cachedFile}`);
      return cachedFile;
    } finally {
      if (sub) sub.dispose();
    }
  }

  async function ensureLocalAgyBinary(kernel, arch, settings, progress, token) {
    const { nodePlatform, nodeArch, manifestKey } = mapAgyPlatform(kernel, arch);
    const controller = new AbortController();
    const sub = token ? token.onCancellationRequested(() => controller.abort()) : undefined;

    try {
      progress.report({ message: `Fetching agy CLI manifest (${manifestKey})...` });
      const manifest = await fetchAgyReleaseManifest(settings.releaseBaseUrl, manifestKey, {
        proxyUrl: settings.proxyUrl,
        signal: controller.signal,
      });
      const resolved = resolveAgyBinaryFromManifest(manifest, nodePlatform, nodeArch);
      const ext = resolved.isTarGz ? '.tar.gz' : '';
      const cacheDir = path.join(
        context.globalStorageUri.fsPath,
        'cache',
        'agy-cli',
        resolved.version,
        `${nodePlatform}-${nodeArch}`
      );
      const cachedFile = path.join(cacheDir, `agy-${resolved.version}${ext}`);

      if (fs.existsSync(cachedFile) && fs.statSync(cachedFile).size > 0) {
        log(`Using cached agy CLI v${resolved.version}: ${cachedFile}`);
        return { localFilePath: cachedFile, isTarGz: resolved.isTarGz, version: resolved.version };
      }

      let lastPct = -1;
      progress.report({ message: `Downloading agy CLI v${resolved.version} locally...` });
      const res = await downloadFromMirrors([resolved.url], cachedFile, {
        proxyUrl: settings.proxyUrl,
        expectGzip: resolved.isTarGz,
        expectedSha512: resolved.sha512,
        expectedSha256: resolved.sha256,
        signal: controller.signal,
        log,
        onProgress: ({ downloaded, total }) => {
          if (total && total > 0) {
            const pct = Math.floor((downloaded / total) * 100);
            if (pct !== lastPct && pct % 10 === 0) {
              lastPct = pct;
              const mbDone = (downloaded / (1024 * 1024)).toFixed(1);
              const mbTotal = (total / (1024 * 1024)).toFixed(1);
              progress.report({
                message: `Downloading agy CLI v${resolved.version}: ${mbDone}/${mbTotal} MB (${pct}%)`,
              });
            }
          }
        },
      });
      log(`Downloaded agy CLI v${resolved.version} (${res.size} bytes) -> ${cachedFile}`);
      return { localFilePath: cachedFile, isTarGz: resolved.isTarGz, version: resolved.version };
    } finally {
      if (sub) sub.dispose();
    }
  }

  async function runDeployFlow(target, { connectAfter, reuseWindow }) {
    const settings = getSettings();
    const serverConfig = readServerConfigFromAppRoot(
      vscode.env.appRoot,
      vscode.version,
      settings.overrideBinaryName
    );
    log(
      `IDE version=${serverConfig.ideVersion}, commit=${serverConfig.commit}, quality=${serverConfig.quality}`
    );

    const askpass = await createAskpassContext((promptText) =>
      vscode.window.showInputBox({
        prompt: promptText,
        password: !/yes\/no/i.test(promptText),
        ignoreFocusOut: true,
      })
    );

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Antigravity Offline SSH (${target})`,
          cancellable: true,
        },
        async (progress, token) => {
          progress.report({ message: 'Probing remote host (single SSH session)...' });
          const probe = await probeRemoteHost({
            sshPath: settings.sshPath,
            target,
            configFile: settings.explicitConfigFile,
            timeoutSeconds: settings.connectTimeoutSeconds,
            env: askpass.env,
            ideVersion: serverConfig.ideVersion,
            distroId: serverConfig.distroId,
            serverDataFolderName: serverConfig.serverDataFolderName,
            serverApplicationName: serverConfig.serverApplicationName,
          });
          log(
            `Probe result: kernel=${probe.kernel}, arch=${probe.arch}, ideInstalled=${probe.alreadyInstalled}, agyInstalled=${probe.agyInstalled}`
          );

          const { platform, serverArch } = mapRemotePlatform(probe.kernel, probe.arch);
          const remotePaths = getRemotePaths(probe.home, serverConfig);

          let ideArchiveLocalPath;
          if (!probe.alreadyInstalled || settings.forceRedeploy) {
            ideArchiveLocalPath = await ensureLocalIdeArchive(
              serverConfig,
              platform,
              serverArch,
              settings.proxyUrl,
              progress,
              token
            );
          } else {
            log(`IDE server already installed on ${target}.`);
          }
          if (token.isCancellationRequested) return;

          let agyLocalPath;
          let agyIsTarGz = false;
          if (settings.deployAgyCli) {
            if (!probe.agyInstalled || settings.forceRedeploy) {
              const agyPkg = await ensureLocalAgyBinary(
                probe.kernel,
                probe.arch,
                settings,
                progress,
                token
              );
              agyLocalPath = agyPkg.localFilePath;
              agyIsTarGz = agyPkg.isTarGz;
            } else {
              log(`agy CLI already installed on ${target}.`);
            }
          }
          if (token.isCancellationRequested) return;

          let updatedMachineSettingsJson;
          if (settings.enableProxyTunnel) {
            const desired = computeDesiredMachineSettings(probe.machineSettingsRaw, {
              enableProxyTunnel: settings.enableProxyTunnel,
              enableTerminalProxy: settings.enableTerminalProxy,
              tunnelPort: settings.tunnelPort,
              platform,
            });
            if (desired.changed) {
              updatedMachineSettingsJson = desired.updatedJsonText;
            } else {
              log(`Remote Machine/settings.json already matches proxy :${settings.tunnelPort}.`);
            }
          }

          if (ideArchiveLocalPath || agyLocalPath || updatedMachineSettingsJson !== undefined) {
            progress.report({ message: `Applying packages & settings on ${target}...` });
            await applyRemoteDeployment({
              sshPath: settings.sshPath,
              scpPath: settings.scpPath,
              target,
              configFile: settings.explicitConfigFile,
              timeoutSeconds: settings.connectTimeoutSeconds,
              env: askpass.env,
              ideArchiveLocalPath,
              agyLocalPath,
              agyIsTarGz,
              updatedMachineSettingsJson,
              remoteHome: probe.home,
              serverDataDir: remotePaths.serverDataDir,
              serverDir: remotePaths.serverDir,
              serverScript: remotePaths.serverScript,
              serverApplicationName: serverConfig.serverApplicationName,
              log,
            });
            log(`Batch deployment completed on ${target}.`);
          }

          if (settings.enableProxyTunnel) {
            await tunnelManager.ensureLocalProxy(settings.tunnelPort, settings.proxyUrl);
            await rememberTunnelTarget(target);
            tunnelManager.ensureReverseTunnel({
              sshPath: settings.sshPath,
              target,
              configFile: settings.explicitConfigFile,
              timeoutSeconds: settings.connectTimeoutSeconds,
              port: settings.tunnelPort,
            });
          }
        }
      );

      if (connectAfter) {
        const authority = encodeRemoteAuthority(target);
        if (vscode.env.remoteName === 'ssh-remote') {
          const choice = await vscode.window.showInformationMessage(
            `Deployed AGY CLI & proxy tunnel to ${target}. Reload window now to activate AGY view?`,
            'Reload Window'
          );
          if (choice === 'Reload Window') {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
          }
        } else {
          log(`Opening Antigravity remote SSH window with authority: ${authority}`);
          await vscode.commands.executeCommand('vscode.newWindow', {
            remoteAuthority: authority,
            reuseWindow: Boolean(reuseWindow),
          });
        }
      } else {
        const choice =
          vscode.env.remoteName === 'ssh-remote'
            ? await vscode.window.showInformationMessage(
                `Deployed server, AGY CLI & proxy config to ${target}. Reload window to apply?`,
                'Reload Window'
              )
            : await vscode.window.showInformationMessage(
                `Deployed server, AGY CLI & proxy config to ${target}.`
              );
        if (choice === 'Reload Window') {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      }
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      log(`ERROR: ${msg}`);
      const action = await vscode.window.showErrorMessage(
        `Offline SSH failed: ${msg}`,
        'Show Log'
      );
      if (action === 'Show Log') {
        output.show(true);
      }
    } finally {
      askpass.dispose();
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityOfflineSsh.deployAndConnect', async (item) => {
      const target = await pickTargetHost(item);
      if (!target) return;
      await runDeployFlow(target, { connectAfter: true, reuseWindow: false });
    }),
    vscode.commands.registerCommand(
      'antigravityOfflineSsh.deployAndConnectCurrentWindow',
      async (item) => {
        const target = await pickTargetHost(item);
        if (!target) return;
        await runDeployFlow(target, { connectAfter: true, reuseWindow: true });
      }
    ),
    vscode.commands.registerCommand('antigravityOfflineSsh.deployOnly', async (item) => {
      const target = await pickTargetHost(item);
      if (!target) return;
      await runDeployFlow(target, { connectAfter: false, reuseWindow: false });
    }),
    vscode.commands.registerCommand('antigravityOfflineSsh.startTunnelForHost', async (item) => {
      const target = await pickTargetHost(item);
      if (!target) return;
      const settings = getSettings();
      await tunnelManager.ensureLocalProxy(settings.tunnelPort, settings.proxyUrl);
      await rememberTunnelTarget(target);
      tunnelManager.ensureReverseTunnel({
        sshPath: settings.sshPath,
        target,
        configFile: settings.explicitConfigFile,
        timeoutSeconds: settings.connectTimeoutSeconds,
        port: settings.tunnelPort,
      });
      vscode.window.showInformationMessage(
        `Started local proxy & SSH reverse tunnel (127.0.0.1:${settings.tunnelPort}) for ${target}.`
      );
    }),
    vscode.commands.registerCommand('antigravityOfflineSsh.stopTunnelForHost', async (item) => {
      const target = await pickTargetHost(item);
      if (!target) return;
      tunnelManager.stopTunnel(target);
      vscode.window.showInformationMessage(`Stopped SSH reverse tunnel for ${target}.`);
    }),
    vscode.commands.registerCommand('antigravityOfflineSsh.clearCache', async () => {
      const cacheRoot = path.join(context.globalStorageUri.fsPath, 'cache');
      const bytes = computeDirectorySizeBytes(cacheRoot);
      if (bytes === 0) {
        vscode.window.showInformationMessage('Local Offline SSH cache is already empty.');
        return;
      }
      const mb = (bytes / (1024 * 1024)).toFixed(1);
      const confirm = await vscode.window.showWarningMessage(
        `Delete cached server & agy CLI archives (${mb} MB)?`,
        { modal: true },
        'Clear Cache'
      );
      if (confirm !== 'Clear Cache') return;
      fs.rmSync(cacheRoot, { recursive: true, force: true });
      log(`Cleared local cache (${mb} MB): ${cacheRoot}`);
      vscode.window.showInformationMessage(`Cleared ${mb} MB of cached Offline SSH archives.`);
    }),
    vscode.commands.registerCommand('antigravityOfflineSsh.downloadCache', async () => {
      const settings = getSettings();
      const serverConfig = readServerConfigFromAppRoot(
        vscode.env.appRoot,
        vscode.version,
        settings.overrideBinaryName
      );
      const archPick = await vscode.window.showQuickPick(
        [
          { label: 'linux-x64', kernel: 'Linux', machine: 'x86_64', platform: 'linux', arch: 'x64', description: '64-bit x86 Linux (most servers)' },
          { label: 'linux-arm', kernel: 'Linux', machine: 'aarch64', platform: 'linux', arch: 'arm', description: '64-bit ARM64 / aarch64 Linux' },
          { label: 'darwin-x64', kernel: 'Darwin', machine: 'x86_64', platform: 'darwin', arch: 'x64', description: 'macOS Intel' },
          { label: 'darwin-arm', kernel: 'Darwin', machine: 'arm64', platform: 'darwin', arch: 'arm', description: 'macOS Apple Silicon' },
        ],
        { placeHolder: 'Select target platform/architecture to cache locally (IDE Server + AGY CLI)' }
      );
      if (!archPick) return;

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Caching Antigravity Offline Bundle (${archPick.label})`,
            cancellable: true,
          },
          async (progress, token) => {
            const ideFile = await ensureLocalIdeArchive(
              serverConfig,
              archPick.platform,
              archPick.arch,
              settings.proxyUrl,
              progress,
              token
            );
            let agyMsg = '';
            if (settings.deployAgyCli) {
              const agyPkg = await ensureLocalAgyBinary(
                archPick.kernel,
                archPick.machine,
                settings,
                progress,
                token
              );
              agyMsg = ` & agy v${agyPkg.version}`;
            }
            vscode.window.showInformationMessage(
              `Cached IDE server${agyMsg} at: ${path.dirname(ideFile)}`
            );
          }
        );
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        log(`ERROR caching bundle: ${msg}`);
        vscode.window.showErrorMessage(`Download failed: ${msg}`);
      }
    }),
    vscode.commands.registerCommand('antigravityOfflineSsh.openSshConfig', async () => {
      const configPath = getEffectiveSshConfigPath();
      if (!fs.existsSync(configPath)) {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, '', 'utf8');
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath));
      await vscode.window.showTextDocument(doc, { preview: false });
    }),
    vscode.commands.registerCommand('antigravityOfflineSsh.refreshHosts', () => {
      hostsProvider.refresh();
    }),
    vscode.commands.registerCommand('antigravityOfflineSsh.showLog', () => {
      output.show(true);
    })
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
