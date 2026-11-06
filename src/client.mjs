import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { privateDirectory, readJson } from './files.mjs';

const cli = fileURLToPath(new URL('../bin/baigong.mjs', import.meta.url));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function connect(workspace) {
  const canonical = fs.realpathSync(workspace);
  const connection = readJson(path.join(canonical, '.work', 'runtime', 'connection.json'), null);
  if (!connection) return null;
  const url = new URL(connection.origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^[a-f0-9]{64}$/.test(connection.token)) throw new Error('本地服务连接文件无效');
  try {
    const response = await fetch(`${connection.origin}/api/health`, { headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(1500), redirect: 'error' });
    const value = await response.json();
    return response.ok && value.name === 'baigong' && value.instance === connection.instance && value.workspace === canonical ? connection : null;
  } catch { return null; }
}

export async function ensureService(workspace, { secretsDirectory } = {}) {
  const existing = await connect(workspace);
  if (existing) return existing;
  const runtime = privateDirectory(path.join(fs.realpathSync(workspace), '.work', 'runtime'));
  const lock = path.join(runtime, 'startup.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    for (let i = 0; i < 100; i++) {
      await wait(100);
      const connection = await connect(workspace);
      if (connection) return connection;
    }
    throw new Error('本地服务启动锁仍在使用；确认无启动进程后检查 .work/runtime/startup.lock');
  }
  try {
    const logFd = fs.openSync(path.join(runtime, 'service.log'), 'a', 0o600);
    const args = [cli, 'serve', '--workspace', fs.realpathSync(workspace)];
    if (secretsDirectory) args.push('--secrets-dir', path.resolve(secretsDirectory));
    const child = spawn(process.execPath, args, { detached: true, windowsHide: true, stdio: ['ignore', logFd, logFd] });
    let spawnError;
    child.on('error', error => { spawnError = error; });
    child.unref();
    fs.closeSync(logFd);
    for (let i = 0; i < 150; i++) {
      if (spawnError) throw new Error('无法启动 Node 本地服务');
      await wait(100);
      const connection = await connect(workspace);
      if (connection) return connection;
    }
    throw new Error('本地服务未成功启动，请查看 .work/runtime/service.log');
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

export async function call(connection, action, args = {}) {
  const response = await fetch(`${connection.origin}/api/call`, {
    method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, args }), redirect: 'error', signal: AbortSignal.timeout(1250000),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '本地服务请求失败');
  return value.result;
}
