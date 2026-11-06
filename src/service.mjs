import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Store } from './store.mjs';
import { TaskManager, safeError } from './tasks.mjs';
import { writeJson, privateDirectory, readJson } from './files.mjs';
import { parse, idSchema } from './schema.mjs';

export const WEB_ROOT = new URL('../web/', import.meta.url);
export const summary = task => ({ id: task.id, title: task.title, modelId: task.modelId, modelName: task.modelName,
  status: task.status, createdAt: task.createdAt, finishedAt: task.finishedAt, revision: task.revision, steps: task.steps, usage: task.usage, assignmentReason: task.assignmentReason });

export function state(store) {
  return { config: store.publicConfig(), tasks: store.tasks().map(summary), version: '0.1.0' };
}

export async function dispatch(store, manager, action, args = {}) {
  switch (action) {
    case 'get_state': return state(store);
    case 'list_models': return { enabled: store.config().settings.enabled,
      models: store.publicConfig().models.filter(m => m.enabled).map(m => ({ id: m.id, name: m.name, model: m.model,
        description: m.description, ready: Boolean(m.hasKey && m.test?.ok), thinking: m.thinking, maxTokens: m.maxTokens })) };
    case 'update_settings': return manager.setSettings(args);
    case 'save_model': {
      const { apiKey, ...model } = args;
      manager.modelIdle(parse(idSchema, model.id));
      return store.saveModel(model, apiKey);
    }
    case 'delete_model': manager.modelIdle(parse(idSchema, args.id)); return store.removeModel(args.id);
    case 'test_model': return manager.testModel(parse(idSchema, args.id));
    case 'start_task': return summary(manager.create(args));
    case 'get_task': return store.getTask(args.id);
    case 'get_artifact': return manager.artifact(args.id, args.path);
    case 'cancel_task': return summary(manager.cancel(args.id));
    case 'review_task': return manager.review(args.id, args.decision, args.notes);
    default: throw new Error('不支持的操作');
  }
}

async function bodyJson(request) {
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 2 * 1024 * 1024) throw new Error('请求体超过 2 MB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function createService({ workspace, secretsDirectory, port = 0, publish = true }) {
  const store = new Store(workspace, { secretsDirectory });
  const manager = new TaskManager(store);
  const token = crypto.randomBytes(32).toString('hex');
  const instance = crypto.randomUUID();
  const runtime = privateDirectory(path.join(store.root, 'runtime'));
  const descriptorFile = path.join(runtime, 'connection.json');
  let origin;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    function json(status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
    try {
      if (req.headers.host !== new URL(origin).host) return json(403, { error: 'Host 不匹配' });
      if (req.headers.origin && req.headers.origin !== origin) return json(403, { error: '禁止跨站请求' });
      const url = new URL(req.url, origin);
      const isApi = url.pathname === '/api/call' || url.pathname === '/api/shutdown' || url.pathname === '/api/health';
      if (isApi) {
        const presented = req.headers.authorization || '';
        const expected = `Bearer ${token}`;
        if (Buffer.byteLength(presented) !== Buffer.byteLength(expected) || !crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected))) return json(401, { error: '请使用启动命令给出的完整配置地址打开面板' });
        if (url.pathname === '/api/health' && req.method === 'GET') return json(200, { name: 'baigong', instance, workspace: store.workspace });
        if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) return json(415, { error: '仅支持 JSON POST' });
        if (url.pathname === '/api/shutdown') {
          json(200, { stopped: true });
          setImmediate(() => close());
          return;
        }
        const input = await bodyJson(req);
        const result = await dispatch(store, manager, input.action, input.args);
        return json(200, { result });
      }
      const staticFiles = { '/': ['index.html', 'text/html'], '/app.js': ['app.bundle.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/icon.svg': ['icon.svg', 'image/svg+xml'] };
      const asset = staticFiles[url.pathname];
      if (req.method !== 'GET' || !asset) return json(404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` });
      res.end(fs.readFileSync(new URL(asset[0], WEB_ROOT)));
    } catch (error) {
      if (!res.headersSent) json(400, { error: safeError(error) });
      else res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const connection = { origin, token, workspace: store.workspace, instance, pid: process.pid, version: '0.1.0' };
  if (publish) writeJson(descriptorFile, connection);
  let closing;
  function close() {
    if (closing) return closing;
    manager.shutdown();
    if (publish && readJson(descriptorFile, {})?.instance === instance) fs.unlinkSync(descriptorFile);
    closing = new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
    return closing;
  }
  return { server, store, manager, connection, close, url: `${origin}/#token=${token}` };
}
