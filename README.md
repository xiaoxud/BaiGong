# 百工 BaiGong

**你定目标，百工协作。**

本地多模型协作插件：配置多个第三方模型，由 Codex 主智能体拆解任务、选择执行者、审核成果。每项任务使用项目内 `.work/tasks` 下的独立工作副本。

当前为 **0.1.0 首版**：支持 DeepSeek / OpenAI 兼容的 Chat Completions 工具接口，提供模型配置、真实工具往返测试、并发队列、取消、超时、文件产出审核和限次返工。包含 MCP Apps 内嵌界面以及同一套本机网页面板。界面能否内嵌取决于客户端；本机网页可独立使用。

## 本地启动

需要 Node.js 22+、npm。支持 Windows、macOS、Linux；无需修改主模型或登录方式。

```powershell
git clone https://github.com/xiaoxud/BaiGong.git
cd BaiGong
npm ci
npm run build
npm start
```

打开命令输出的完整本地地址。首次配置总开关默认关闭，不会自动调用第三方接口。在面板添加 API 根地址、API Key、完整模型 ID 和能力描述，点击「测试连接」，验证后再启用协作。测试会查询 `/models`，并进行两次真实模型调用，可能收费。

默认将当前目录作为项目。为另一个项目启动：

```powershell
node bin/baigong.mjs ui --workspace "D:/Projects/my-project"
node bin/baigong.mjs status --workspace "D:/Projects/my-project"
node bin/baigong.mjs stop --workspace "D:/Projects/my-project"
```

`ui` 启动隐藏的本地后台进程并输出访问地址；`serve` 在前台运行。地址片段中的 token 是本机面板访问令牌，不要分享。页面加载后将其移入当前标签页的会话存储，并从地址栏移除。

## 接入 Codex

### 安装完整插件

先在本仓库执行 `npm ci` 和 `npm run build`，再把仓库作为本地 marketplace 添加。仓库已包含 `.agents/plugins/marketplace.json`、`plugin.json`、`mcp.json` 和技能。

```powershell
codex plugin marketplace add "C:/absolute/path/BaiGong"
```

在支持本地插件的客户端插件目录中选择 `baigong-local`，安装 `baigong` 后新开聊天。可说「打开百工配置」「用百工完成这个项目任务」。部分 CLI 支持 `codex plugin add baigong@baigong-local`；以本机 `codex plugin --help` 为准。

**在需要处理的项目中开启聊天。** MCP stdio 接口以客户端传入的进程工作目录为项目；如果客户端的插件启动目录不是目标项目，请使用下面的直接 MCP 配置，显式传 `--workspace`。

### 直接连接本地 MCP（兼容入口）

在自己的 Codex `config.toml` 中添加以下配置，替换两个绝对路径。保留其他现有配置。此方式提供工具与内嵌 UI；技能可从本仓库 `skills/baigong` 安装到个人技能目录，或直接使用完整插件方式。

```toml
[mcp_servers.baigong]
command = "node"
args = ["C:/absolute/path/BaiGong/bin/baigong.mjs", "mcp", "--workspace", "D:/Projects/my-project"]
```

重启 MCP 连接或新开聊天后，调用 `baigong_open_dashboard`。所有 MCP stdout 都保持为协议数据。本机网页和 MCP 共用同一个工作区服务与任务队列。

插件启用且其工具/指令被当前聊天加载后，主智能体可读取模型能力并分配任务。仅安装技能不保证每条消息自动委派；可明确要求「这个项目的实际工作使用百工，主智能体审核」。项目或组织的更高优先级规则仍然适用。

## 工作流程

1. 主智能体读取已启用、已验证的模型，按任务选择执行者。
2. 明确任务、选择理由、验收标准和输入文件，不上传整个项目。
3. worker 使用 `list_files` / `read_file` / `write_file` 读写自己的任务副本。
4. 产出进入 `awaiting-review`。主智能体检查文件差异、独立运行必要验证。
5. 记录通过、拒绝或限次返工。**审核通过不自动覆盖项目源码**，由主智能体结合项目最新状态采用修改。

第一版没有 worker 终端、浏览器、原生 Codex 子智能体路由、自动合并或精确金额预算。文件工具校验相对路径、符号链接/目录联接、敏感文件名和大小；这不是可用于任意程序的操作系统沙箱。模型返回名只是平台声明，不是模型身份的独立证明。

关闭总开关：取消排队任务，正在执行的任务可以继续完成或手动取消。每次执行（含一次返工）受超时、模型调用轮数、单轮输出 tokens 限制。服务重启后，未完成的任务标记失败，不假装恢复了模型上下文。修改在用模型前须完成或取消对应任务。

## 数据位置

```text
你的项目/.work/
├─ config.json             非敏感模型配置与执行限额
├─ runtime/                私有连接令牌、启动锁和服务日志
└─ tasks/task-…/
   ├─ assignment.md        任务与验收标准
   ├─ original/            指定输入的原始快照
   ├─ workspace/           worker 工作副本
   ├─ task.json            状态、产出、工具事件、用量
   └─ review.json          审核记录（有审核后生成）
```

请将 `.work/` 加到目标项目 `.gitignore`。任务材料会发送至所选模型平台；保留和清理本机数据由使用者决定，停止服务不会删除任务和凭据。

密钥不存进 `.work/config.json`，按工作区命名空间区分，位于 Windows `%LOCALAPPDATA%/BaiGong/secrets`，其他系统 `~/.local/share/BaiGong/secrets`。Windows 使用当前用户 DPAPI；其他系统采用 AES-256-GCM，加密主密钥与密文保存在权限受限的本机目录（不是独立硬件密钥库）。工具不提供密钥读取接口，不持久化完整模型对话或思考内容。

## 验证与分享

```powershell
npm run build
npm run check
npm test
npm run test:ui
npm run package
node scripts/test-install.mjs
```

常规测试使用本机模拟 API，不需要真实密钥，不产生模型费用。浏览器测试使用 Playwright 和系统 Edge（可通过 `BAIGONG_BROWSER` 指定 Chromium 可执行文件），还会通过官方 MCP Apps AppBridge 检查内嵌界面。macOS/Linux 无 Edge 时先安装 Playwright Chromium，或指定 Chrome 路径。

`test-install.mjs` 需要已安装的 Codex CLI：使用临时 Codex 配置和临时项目，实际解包、注册本地插件源、安装至隔离缓存并验证 MCP 工具和界面资源，不修改日常 Codex 设置。

`npm run package` 输出 `dist/baigong-0.1.0.tgz` 和 SHA256 校验清单。包包含已构建界面和生产运行依赖，不包含 `.work`、个人密钥或开发依赖。接收者解压后可直接用 Node 运行 `bin/baigong.mjs`；目录作为本地 marketplace 注册后可安装插件。Git 仓库安装则先运行 `npm ci` / `npm run build` 准备运行依赖。

公开插件目录上架是另一个流程，本项目没有自动发布；本地 MCP 插件公开提交还受平台资格与审核要求限制。

## 接口依据

- [OpenAI 插件打包和本地分发](https://developers.openai.com/plugins/build/plugins)
- [MCP Apps 界面集成](https://developers.openai.com/plugins/build/chatgpt-ui)
- [DeepSeek 工具调用协议](https://api-docs.deepseek.com/guides/tool_calls/)

MIT License.
