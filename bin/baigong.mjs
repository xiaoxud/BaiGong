#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createService } from '../src/service.mjs';
import { connect, ensureService } from '../src/client.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  workspace: { type: 'string', default: process.cwd() },
  'secrets-dir': { type: 'string' },
  port: { type: 'string', default: '0' },
  help: { type: 'boolean', short: 'h' },
} });
const command = positionals[0] || 'ui';
const workspace = path.resolve(values.workspace);
const secretsDirectory = values['secrets-dir'] && path.resolve(values['secrets-dir']);

try {
  if (values.help) {
    console.log('百工 BaiGong 0.1.0\n\nnode bin/baigong.mjs <ui|serve|mcp|status|stop> [--workspace 项目目录]\n\nui: 启动后台服务并输出本地配置地址\nserve: 前台运行本地服务\nmcp: MCP stdio 接入（stdout 只输出协议）\nstatus / stop: 查看 / 停止当前工作区的服务');
  } else if (command === 'serve') {
    const running = await connect(workspace);
    if (running) throw new Error('当前工作区已有百工服务，请使用 ui 或 status');
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口必须在 0–65535 之间');
    const service = await createService({ workspace, secretsDirectory, port });
    console.log(`百工已启动：${service.url}\n工作区：${workspace}\n按 Ctrl+C 停止。`);
    const shutdown = () => service.close().then(() => process.exit(0));
    process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  } else if (command === 'mcp') {
    const { runMcp } = await import('../src/mcp.mjs');
    await runMcp({ workspace, secretsDirectory });
  } else if (command === 'ui') {
    const connection = await ensureService(workspace, { secretsDirectory });
    console.log(`百工配置面板：\n${connection.origin}/#token=${connection.token}\n\n工作区：${connection.workspace}\n此地址包含本机访问令牌，请勿分享。`);
  } else if (command === 'status' || command === 'stop') {
    const connection = await connect(workspace);
    if (!connection) console.log('当前工作区的百工服务未运行。');
    else if (command === 'status') console.log(JSON.stringify({ running: true, origin: connection.origin, workspace: connection.workspace, version: connection.version }, null, 2));
    else {
      const response = await fetch(`${connection.origin}/api/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) throw new Error('停止服务失败');
      console.log('百工服务已停止。');
    }
  } else throw new Error('未知命令。使用 --help 查看帮助。');
} catch (error) {
  process.stderr.write(`BaiGong: ${error.message}\n`);
  process.exitCode = 1;
}
