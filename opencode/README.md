# opencode 配置 — AI 安装指南

本文件给 AI agent 阅读。目标：在一台新机器上，根据本指南把 opencode 及其全部依赖、MCP、插件安装并验证到可用状态。按顺序执行，每步都有验证命令，失败时按「故障处理」排查。

支持 macOS 和 Linux。两者差异仅在第 1 步的包管理器和第 4 步的服务管理方式（macOS 用 brew services，Linux 用 systemd user service）；其余所有组件（opencode、Node、tmux、Go、agent-tracker、pinchtab）均为跨平台，agent-tracker 的 socket 走 `$XDG_RUNTIME_DIR/agent-tracker.sock`，Linux 原生支持。执行前先判断平台：`uname -s`（Darwin=macOS，Linux=Linux），之后只看对应分支的命令。

上游仓库：

- 本配置：<https://github.com/NexusXian/.config/tree/main/opencode>
- agent-tracker（tracker MCP + 插件的后端）：<https://github.com/NexusXian/agent-tracker>

## 安装目标清单

1. opencode CLI 可运行
2. `~/.config/opencode/` 配置就位，`npm install` 完成
3. 环境变量 `CC_API_KEY`、`PACKYCODE_API_KEY` 配置
4. agent-tracker：`~/.local/bin/tracker-mcp` 二进制 + tracker-server brew 服务运行
5. （可选）pinchtab 本地服务

## 文件说明

| 路径 | 作用 |
|---|---|
| `opencode.json` | 主配置：provider（claude/packycode，走 `https://slb-v1.api.fan/v1` 中转）、MCP、权限 |
| `AGENTS.md` | agent 行为规则 |
| `agents/search.md` | 自定义 search agent |
| `commands/consult.md` + `consult.json` + `tools/consult.ts` | `/consult` 命令（GLM-5.2 二次审查） |
| `plugin/tracker-auto.ts` | tmux 内自动任务追踪插件 |
| `tui-plugins/tui.json` | TUI 快捷键 |
| `tools/pinchtab-mcp.mjs` | pinchtab 浏览器控制 MCP server，9 个工具 |
| `package.json` / `tsconfig.json` | 本地依赖：`@modelcontextprotocol/sdk`、`zod`、`@opencode-ai/plugin` |

## 步骤 1：安装基础依赖

macOS：

```bash
brew install opencode node tmux go   # node 需要 >= 20；go 仅步骤 4 需要
```

Linux（Debian/Ubuntu；其他发行版用对应包管理器）：

```bash
curl -fsSL https://opencode.ai/install | bash   # opencode 官方脚本
sudo apt install nodejs npm tmux golang          # node 需要 >= 20，发行版仓库过旧时用 nodesource 或 nvm
```

验证（两平台相同）：

```bash
opencode --version   # 有版本号输出
node --version       # v20+
go version           # 步骤 4 需要
```

## 步骤 2：放置配置

若 `~/.config` 整体由本仓库管理：

```bash
git clone git@github.com:NexusXian/.config.git ~/.config
```

若 `~/.config` 已有其他内容，只同步 opencode 目录：

```bash
git clone git@github.com:NexusXian/.config.git /tmp/nexus-config
rsync -a /tmp/nexus-config/opencode/ ~/.config/opencode/
```

## 步骤 3：安装依赖 + 环境变量

```bash
cd ~/.config/opencode && npm install
```

向用户索取以下 key，写入 `~/.zshrc`（两个 provider 共用同一 baseURL，缺一个则对应 provider 不可用）：

```bash
export CC_API_KEY="..."        # provider: claude
export PACKYCODE_API_KEY="..." # provider: packycode
```

可选（pinchtab）：

```bash
export PINCHTAB_URL="http://127.0.0.1:9867"  # 默认值，可省略
export PINCHTAB_TOKEN="..."                  # pinchtab 开了鉴权时才需要
```

## 步骤 4：agent-tracker

来源仓库 <https://github.com/NexusXian/agent-tracker>（`~/.config/agent-tracker` 若已随 .config 克隆则等价，优先用已克隆的）。

编译 + 安装 tracker-mcp（两平台相同）：

```bash
git clone git@github.com:NexusXian/agent-tracker.git ~/.config/agent-tracker  # 已存在则跳过
cd ~/.config/agent-tracker
./install.sh                                   # go build 出 bin/tracker-server tracker-mcp agent
mkdir -p ~/.local/bin && cp bin/tracker-mcp ~/.local/bin/
```

启动 tracker-server 常驻服务：

macOS（brew services）：

```bash
./scripts/install_brew_service.sh
```

Linux（systemd user service；Linuxbrew 无 `brew services`，上面的脚本会直接报错，不要用）：

```bash
mkdir -p ~/.config/systemd/user
cp bin/tracker-server ~/.local/bin/
cat > ~/.config/systemd/user/agent-tracker.service <<'EOF'
[Unit]
Description=Agent tracker server

[Service]
ExecStart=%h/.local/bin/tracker-server
Restart=always

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload && systemctl --user enable --now agent-tracker
loginctl enable-linger "$USER"   # SSH 登出后服务不退出
```

验证：

```bash
# macOS
brew services list | grep tracker           # status 为 started
# Linux
systemctl --user is-active agent-tracker    # active
# 两平台：socket 存在
ls "$XDG_RUNTIME_DIR/agent-tracker.sock"
```

注意：`opencode.json` 中 tracker MCP 的 command 是硬编码路径 `/Users/nexus/.local/bin/tracker-mcp`，任何平台用户名不同都需改成实际路径（`~/.local/bin/tracker-mcp` 展开后的绝对路径）。

## 步骤 5（可选）：pinchtab

本地服务，无云端版。不装则 pinchtab 工具不可用，不影响 opencode 其他功能。

```bash
curl -fsSL https://pinchtab.com/install.sh | bash
```

验证 MCP server 本身可启动（无需 pinchtab 服务在跑）：

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}\n' \
  | node ~/.config/opencode/tools/pinchtab-mcp.mjs
```

## 最终验证

```bash
opencode --version
cd ~/.config/opencode && npm ls @modelcontextprotocol/sdk zod   # 无 missing
echo "$CC_API_KEY" | head -c 4   # 非空
```

启动 `opencode`，检查：

- 能列出模型（claude/packycode 下的 Opus 4.6/4.7/5、Sonnet 5、Fable 5）
- `/consult` 命令存在
- pinchtab 服务运行时 `pinchtab_tabs` 等工具可调用

## 故障处理

- opencode 起动报 provider 401：检查 `CC_API_KEY` / `PACKYCODE_API_KEY` 是否 export 进了 opencode 的运行环境
- tracker MCP 连不上：确认 `~/.local/bin/tracker-mcp` 存在且服务已启动（macOS: `brew services list`；Linux: `systemctl --user status agent-tracker`）、`$XDG_RUNTIME_DIR/agent-tracker.sock` 存在
- Linux 上 `install_brew_service.sh` 报 "brew services command is unavailable"：预期行为，改用 systemd 分支的命令
- Linux 上 SSH 登出后 tracker-server 退出：未执行 `loginctl enable-linger`
- pinchtab 工具报 `fetch failed`：pinchtab 服务未运行（`127.0.0.1:9867`），启动 pinchtab 或忽略
- 模型列表为空：检查 baseURL `https://slb-v1.api.fan/v1` 可达性及 key 有效性

## 使用速览

```bash
opencode             # 交互模式
opencode "任务描述"   # 直接执行
```

- `/consult`：GLM-5.2 批判性二次审查
- `/models`：切换模型/思考档位（low/medium/high/xhigh/max）
- tmux 中运行时 tracker 插件自动记录任务状态
