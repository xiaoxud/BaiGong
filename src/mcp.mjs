import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ensureService, call } from './client.mjs';
import { taskSchema, modelSchema, settingsSchema, idSchema } from './schema.mjs';
import { safeError } from './tasks.mjs';

const URI = 'ui://baigong/dashboard-v1.html';

export function uiHtml() {
  let html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../web/app.bundle.js', import.meta.url), 'utf8');
  html = html.replace('<link rel="stylesheet" href="/styles.css">', () => `<style>${css}</style>`);
  html = html.replace('<script type="module" src="/app.js"></script>', () => `<script>window.BAIGONG_EMBEDDED=true;</script><script type="module">${js.replace(/<\/script/gi, '<\\/script')}</script>`);
  return html.replace('<link rel="icon" href="/icon.svg" type="image/svg+xml">', '');
}

export async function runMcp(options) {
  const connection = await ensureService(options.workspace, options);
  const server = new McpServer({ name: 'baigong', version: '0.1.0' }, {
    instructions: '百工由主智能体选择模型、明确验收标准并审核产出。先调用 baigong_list_models 检查开关和可用模型，再分配任务。模型描述仅作参考。第三方 worker 是百工执行服务中的智能体，不是 Codex 原生子智能体。任务只读写 .work/tasks 中的副本，没有终端。提交不等于通过审核，使用 baigong_get_artifact 核对实际产出。密钥仅在配置界面输入。',
  });
  server.registerResource('baigong-dashboard', URI, {
    title: '百工协作台', description: '模型配置、协作设置与任务审核', mimeType: 'text/html;profile=mcp-app',
  }, async () => ({ contents: [{ uri: URI, mimeType: 'text/html;profile=mcp-app', text: uiHtml(),
    _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } } }] }));

  function tool(action, title, description, schema = {}, { appOnly = false, readOnly = false, ui = false } = {}) {
    server.registerTool(`baigong_${action}`, {
      title, description, inputSchema: schema, outputSchema: { data: z.unknown() },
      annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: ['start_task', 'test_model', 'review_task'].includes(action) },
      _meta: { ui: { ...(ui ? { resourceUri: URI } : {}), visibility: appOnly ? ['app'] : ['model', 'app'] } },
    }, async args => {
      try {
        const result = action === 'open_dashboard' ? await call(connection, 'get_state') : await call(connection, action, args);
        return { structuredContent: { data: result }, content: [{ type: 'text', text:
          action === 'open_dashboard' ? '百工配置面板已准备。若客户端不显示内嵌界面，在插件目录运行 node bin/baigong.mjs ui --workspace 项目目录。' : JSON.stringify(result) }] };
      } catch (error) { return { isError: true, content: [{ type: 'text', text: safeError(error) }] }; }
    });
  }
  tool('open_dashboard', '打开百工配置', '显示百工模型管理和协作配置界面。', {}, { readOnly: true, ui: true });
  tool('get_state', '百工工作台状态', '读取当前工作区配置和任务摘要，不包含密钥。', {}, { readOnly: true });
  tool('list_models', '列出可分配模型', '读取总开关、已启用模型、能力描述和测试状态。仅 ready=true 的模型可执行任务。', {}, { readOnly: true });
  tool('start_task', '分配百工任务', '指定模型、任务、选择原因、验收标准和明确的输入文件。只复制这些非敏感文本文件到 .work 独立任务目录。', taskSchema.shape);
  tool('get_task', '读取任务详情', '查看执行结果、实际模型返回名、工具事件、文件清单及审核记录。', { id: z.string() }, { readOnly: true });
  tool('get_artifact', '核对任务文件', '获取任务产出文件及原始内容，供主智能体审核差异。不会修改主项目。', { id: z.string(), path: z.string() }, { readOnly: true });
  tool('cancel_task', '取消百工任务', '取消排队或执行中的任务，不再执行后续工具。', { id: z.string() });
  tool('review_task', '审核百工产出', '审核通过、拒绝或提供具体要求返工。approve 只记录验收，不自动合并源码。返工会产生新的 API 调用。', {
    id: z.string(), decision: z.enum(['approve', 'request-changes', 'reject']), notes: z.string().min(1).max(10000),
  });
  // Secret entry and paid capability probes are UI-only. No credential read-back tool exists.
  tool('update_settings', '保存协作设置', '由用户在界面调整总开关和限额。', settingsSchema.partial().shape, { appOnly: true });
  tool('save_model', '保存模型配置', '由用户输入模型与密钥；返回值只有配置和是否已保存密钥。', { ...modelSchema.shape, apiKey: z.string().optional() }, { appOnly: true });
  tool('delete_model', '移除模型', '移除模型配置及其本地凭据。', { id: idSchema }, { appOnly: true });
  tool('test_model', '验证模型连接', '用户点击后验证模型目录和两轮真实工具调用，会消耗少量 API 额度。', { id: idSchema }, { appOnly: true });
  await server.connect(new StdioServerTransport());
  return server;
}
