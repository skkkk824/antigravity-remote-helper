# Antigravity Remote Helper

[English](#english) | [简体中文](#简体中文)

---

<a id="english"></a>

## English

**Antigravity Remote Helper** enables seamless Remote-SSH development in **Antigravity IDE** when your remote Linux/macOS server has **no outbound internet access** (air-gapped, intranet, or firewalled environments).

Unlike standard VS Code, Antigravity IDE's built-in SSH extension only attempts to download `Antigravity IDE-reh.tar.gz` directly from the remote host, and the remote `agy` AI backend also requires outbound internet to download `~/.gemini/bin/agy` and reach cloud AI APIs. This extension bridges both gaps automatically using your local machine's network.

### Key Features

- **Local Server & `agy` CLI Download + Batch SCP Deploy**:
  - Automatically reads your current Antigravity IDE version & commit (`ideVersion` / `commit`) and caches both `Antigravity IDE-reh.tar.gz` and `~/.gemini/bin/agy` (with SHA512/SHA256 verification) locally.
  - Probes the remote host in a **single SSH session** and batch-deploys missing components in **one `scp` + one `ssh` call**.
- **Built-in Secure Reverse Proxy Tunnel (Zero Third-Party Proxy Required)**:
  - Runs a lightweight local HTTP/HTTPS `CONNECT` forward proxy on `127.0.0.1:17891` and maintains a self-healing `ssh -N -R` reverse tunnel to the remote host.
  - Automatically configures `http.proxy` in remote `~/.antigravity-ide-server/data/Machine/settings.json` so **AGY AI Chat, Tab Autocomplete, and Agents** work out of the box on offline servers.
  - **SSRF / Loopback Protection**: Blocks any remote requests targeting `localhost`, `127.0.0.0/8`, `::1`, `169.254.0.0/16`, or DNS-rebound loopback IPs (`403 Forbidden`).
- **Integrated Terminal Network (Without Touching `~/.bashrc`)**:
  - Optionally injects `HTTP_PROXY` / `HTTPS_PROXY` into `terminal.integrated.env.linux` inside remote `Machine/settings.json`, so `git`, `pip`, and `curl` work inside Antigravity IDE's integrated terminal without affecting external SSH sessions.
- **Full SSH Auth Support**:
  - Parses `~/.ssh/config` (including `Include` directives) and includes a built-in `SSH_ASKPASS` bridge for password/passphrase prompts.

### Quick Start

1. Click the **Remote Helper** icon in the Activity Bar (or run `Remote Helper: Deploy Server & Connect` from the Command Palette `Ctrl+Shift+P` / `Cmd+Shift+P`).
2. Select a host from `~/.ssh/config` or enter `user@host` manually.
3. The extension probes the remote host, downloads & caches any missing binaries locally, deploys them over SCP, configures the reverse proxy tunnel, and opens the remote SSH window.

### Extension Settings

| Setting | Default | Description |
| --- | --- | --- |
| `antigravityRemoteHelper.enableProxyTunnel` | `true` | Start local proxy + `ssh -R` reverse tunnel for AGY AI features. |
| `antigravityRemoteHelper.enableTerminalProxy` | `true` | Inject proxy env vars into IDE integrated terminals only (never modifies `~/.bashrc`). |
| `antigravityRemoteHelper.tunnelPort` | `17891` | Loopback port used on both local PC and remote host. |
| `antigravityRemoteHelper.deployAgyCli` | `true` | Download and deploy `~/.gemini/bin/agy` over SCP. |
| `antigravityRemoteHelper.proxyUrl` | `""` | Optional upstream HTTP proxy on your local PC (leave empty for direct internet). |
| `antigravityRemoteHelper.configFile` | `""` | Custom SSH config path (defaults to `remote.antigravitySSH.configFile` or `~/.ssh/config`). |
| `antigravityRemoteHelper.sshPath` | `""` | Custom `ssh` executable path. |
| `antigravityRemoteHelper.scpPath` | `""` | Custom `scp` executable path. |
| `antigravityRemoteHelper.forceRedeploy` | `false` | Force re-upload even if binaries already exist on the remote host. |
| `antigravityRemoteHelper.connectTimeoutSeconds` | `20` | SSH/SCP connection timeout in seconds. |

---

<a id="简体中文"></a>

## 简体中文

**Antigravity Remote Helper** 专为**无外网访问权限的远程服务器**（内网、离线、防火墙受限环境）设计，让 **Antigravity IDE** 的 Remote-SSH 连接、**AGY AI 面板 / 代码补全** 以及 **IDE 内置终端联网** 全部开箱即用。

### 解决什么问题？

1. **解决远端无法下载 IDE 服务端**：Antigravity IDE 内置的 SSH 扩展默认仅在远端执行 `wget` 拉取 `Antigravity IDE-reh.tar.gz`，无外网主机必然失败。本插件自动识别当前 IDE 版本与 Commit，由**本地电脑下载并缓存**，再通过 `scp` 部署到远端。
2. **解决连上后 AGY AI 面板报错无法使用**：远端无网会导致 `~/.gemini/bin/agy` 下载失败（`Failed to fetch release manifest`）且 `agy --hub` 无法调用云端模型。本插件在本地自动下载并校验 `agy` 部署到远端，同时内置轻量 HTTP/HTTPS 正向代理桥与自愈 `ssh -R` 反向隧道，让远端直接借用本地网络访问 AI 服务。

### 核心特性

- **单次探测 + 批量部署**：1 次 SSH 探测完成远端架构、IDE Server、`agy` CLI 与 `Machine/settings.json` 检查，缺失组件合并为 **1 次 `scp` + 1 次 `ssh`** 原子安装；已部署主机重连仅需 1 次探测。
- **内置零依赖安全代理桥**：无需额外安装代理软件；内置拦截 `localhost`、`127.0.0.0/8`、`::1`、`169.254.0.0/16` 及 DNS 重绑定回环请求，防止远端共享服务器反向访问本机端口。
- **断网/休眠自愈隧道**：多窗口共享隧道端口不冲突，断网重连后若远端残留僵尸 `sshd` 监听端口会自动探测清理并恢复。
- **打通内置终端且不污染 `~/.bashrc`**：仅在远端 `Machine/settings.json` 的 `terminal.integrated.env.linux` 注入代理变量，外部终端（MobaXterm / Termius）完全不受影响。
- **侧边栏实时状态与缓存清理**：主机旁实时显示绿色隧道状态，支持右键单独启停隧道与一键清理历史版本缓存。

### 使用方法

1. 点击左侧活动栏 **Remote Helper** 图标（或按 `Ctrl+Shift+P` / `Cmd+Shift+P` 运行 `Remote Helper: 部署服务端并连接`）。
2. 选择 `~/.ssh/config` 中的主机或手动输入 `user@host`。
3. 插件会自动完成探测、本地下载缓存、批量上传部署、代理隧道配置，并自动打开远程 SSH 窗口。
