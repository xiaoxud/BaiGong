import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { privateDirectory, readJson, writeJson } from './files.mjs';

export function defaultVaultDirectory() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'BaiGong', 'secrets');
}

// Never interpolate a credential into a command or put it in process arguments.
function dpapi(value, decrypt = false) {
  const method = decrypt ? 'Unprotect' : 'Protect';
  const script = `Add-Type -AssemblyName System.Security; $data=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $output=[Security.Cryptography.ProtectedData]::${method}($data,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($output))`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: value.toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  if (result.status !== 0) throw new Error('Windows 凭据加密失败，请检查当前用户的 DPAPI 可用性');
  return Buffer.from(result.stdout.trim(), 'base64');
}

export class Vault {
  constructor(directory = defaultVaultDirectory()) {
    this.directory = privateDirectory(directory);
    this.file = path.join(directory, 'credentials.json');
    this.cache = new Map();
  }
  localKey() {
    const file = path.join(this.directory, 'master.key');
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('凭据主密钥必须仅当前用户可访问');
    return fs.readFileSync(file);
  }
  encrypt(secret) {
    if (process.platform === 'win32') return { type: 'dpapi', data: dpapi(Buffer.from(secret)).toString('base64') };
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.localKey(), iv);
    const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return { type: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  }
  decrypt(value) {
    if (value.type === 'dpapi' && process.platform === 'win32') return dpapi(Buffer.from(value.data, 'base64'), true).toString('utf8');
    if (value.type !== 'aes-256-gcm' || process.platform === 'win32') throw new Error('凭据格式不适用于当前系统，请重新填写密钥');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.localKey(), Buffer.from(value.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8');
  }
  get(id) {
    const data = readJson(this.file, {});
    const value = Object.hasOwn(data, id) ? data[id] : null;
    if (!value) return null;
    const serialized = JSON.stringify(value);
    if (this.cache.get(id)?.serialized === serialized) return this.cache.get(id).secret;
    const secret = this.decrypt(value);
    this.cache.set(id, { serialized, secret });
    return secret;
  }
  has(id) { return Object.hasOwn(readJson(this.file, {}), id); }
  set(id, secret) {
    if (typeof secret !== 'string' || secret.length < 8 || secret.length > 4096 || /\s/.test(secret)) throw new Error('请输入至少 8 位且不含空白的 API Key');
    const data = readJson(this.file, {});
    Object.defineProperty(data, id, { value: this.encrypt(secret), enumerable: true, configurable: true });
    writeJson(this.file, data);
    this.cache.delete(id);
  }
  remove(id) { const data = readJson(this.file, {}); delete data[id]; writeJson(this.file, data); this.cache.delete(id); }
}
