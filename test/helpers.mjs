import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Store } from '../src/store.mjs';
import { TaskManager } from '../src/tasks.mjs';

export const secret = 'baigong-local-test-secret-123456';

export function temporary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baigong-test-'));
  const workspace = path.join(root, 'project');
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.writeFileSync(path.join(workspace, 'src/input.txt'), 'hello baigong');
  return { root, workspace, secretsDirectory: path.join(root, 'vault'), cleanup() {
    // The only recursive removal target is the exact directory allocated above.
    if (path.dirname(root) !== fs.realpathSync(os.tmpdir()) || !path.basename(root).startsWith('baigong-test-')) throw new Error('临时目录清理边界异常');
    fs.rmSync(root, { recursive: true, force: true });
  } };
}

export function completion(message, finish = 'stop', model = 'mock-model') {
  return { model, choices: [{ message: { role: 'assistant', ...message }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
}

export function functionCall(name, args = {}) {
  return completion({ content: null, reasoning_content: 'private mock reasoning', tool_calls: [{ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
}

export async function mockApi({ delay = 0, handle } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    requests.push({ path: req.url, body, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    let result;
    if (handle) result = await handle(req, body, res);
    if (res.writableEnded) return;
    if (!result && req.url === '/models') result = { data: [{ id: 'mock-model' }] };
    if (!result && body?.tools?.[0]?.function.name === 'get_probe_marker') result = functionCall('get_probe_marker');
    const last = body?.messages?.at(-1);
    if (!result && last?.role === 'tool' && last.tool_call_id === 'call_get_probe_marker') result = completion({ content: last.content });
    if (!result) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (last?.role === 'user') result = functionCall('read_file', { path: 'src/input.txt' });
      else if (last?.tool_call_id === 'call_read_file') {
        const read = JSON.parse(last.content);
        if (body.tools.some(t => t.function.name === 'write_file')) result = functionCall('write_file', { path: 'output.txt', content: read.content.toUpperCase() });
        else result = completion({ content: `只读分析：${read.content}` });
      } else result = completion({ content: '已创建 output.txt。未运行终端测试，请主智能体审核文件内容。' });
    }
    if (!res.destroyed) res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

export async function fixture(options = {}) {
  const temp = temporary();
  const upstream = await mockApi(options);
  let store;
  try {
    store = new Store(temp.workspace, { secretsDirectory: temp.secretsDirectory });
    store.saveModel({ id: 'worker', name: '测试工匠', provider: 'deepseek', baseUrl: upstream.baseUrl, model: 'mock-model', description: '代码与文件处理', enabled: true, maxTokens: 512, thinking: 'disabled' }, secret);
  } catch (error) { await upstream.close(); temp.cleanup(); throw error; }
  const manager = new TaskManager(store);
  return { ...temp, upstream, store, manager, async ready() {
    await manager.testModel('worker'); manager.setSettings({ enabled: true });
  }, async close() {
    manager.shutdown();
    await upstream.close();
    await until(() => manager.controllers.size === 0);
    temp.cleanup();
  } };
}

export const assignment = (overrides = {}) => ({ modelId: 'worker', title: '大写转换', instructions: '读取 src/input.txt，并将其大写内容写入 output.txt。', acceptance: 'output.txt 的内容为 HELLO BAIGONG。主项目不变。', assignmentReason: '该模型通过了工具调用测试，适合处理指定文件。', files: ['src/input.txt'], mode: 'edit-files', ...overrides });

export async function until(predicate, timeout = 10000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('测试等待超时');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
