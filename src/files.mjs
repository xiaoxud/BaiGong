import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_FILE = 512 * 1024;
const forbidden = /^(\.git|\.work|node_modules|\.ssh|\.aws|\.codex|\.agents)$/i;
const sensitive = /(^\.env($|\.)|^\.(npmrc|pypirc|netrc)$|^id_(rsa|dsa|ecdsa|ed25519)($|\.)|\.(pem|key|p12|pfx)$|^(credentials|secrets)(\.|$))/i;

export function safeParts(relative, { allowRoot = false } = {}) {
  if (allowRoot && (relative === '.' || relative === '')) return [];
  if (typeof relative !== 'string' || !relative || /[\\:\x00-\x1f]/.test(relative) || path.isAbsolute(relative)) throw new Error('只允许使用正斜杠分隔的相对路径');
  const parts = relative.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || forbidden.test(p) || sensitive.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(p))) {
    throw new Error('路径越界或包含受保护的目录、凭据文件');
  }
  return parts;
}

export function checkedPath(root, relative, options = {}) {
  const parts = safeParts(relative, options);
  const absoluteRoot = fs.realpathSync(root);
  let current = absoluteRoot;
  for (const part of parts) {
    current = path.join(current, part);
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error('不允许符号链接、目录联接或硬链接');
      const real = fs.realpathSync(current);
      if (real !== absoluteRoot && !real.startsWith(absoluteRoot + path.sep)) throw new Error('路径超出任务目录');
    } else {
      // lstat also catches dangling links, which existsSync intentionally does not.
      try { fs.lstatSync(current); throw new Error('不允许悬空链接'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return current;
}

export function privateDirectory(directory) {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('存储目录不能经过符号链接或目录联接');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.mkdirSync(current, { mode: 0o700 });
    }
  }
  return absolute;
}

export function readJson(file, fallback) {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('存储文件不能是符号链接');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export function writeJson(file, value) {
  privateDirectory(path.dirname(file));
  try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error('不能覆盖符号链接'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

export function readText(root, relative) {
  const file = checkedPath(root, relative);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('只支持不超过 512 KB 的普通文本文件');
  const bytes = fs.readFileSync(file);
  if (bytes.includes(0)) throw new Error('不支持二进制文件');
  return bytes.toString('utf8');
}

export function writeText(root, relative, content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_FILE) throw new Error('文件内容不能超过 512 KB');
  const file = checkedPath(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  checkedPath(root, relative);
  fs.writeFileSync(file, content, { mode: 0o600 });
}

export function listFiles(root, directory = '.', maximum = 200) {
  const start = checkedPath(root, directory, { allowRoot: true });
  const result = [];
  function walk(folder) {
    for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
      if (result.length >= maximum) return;
      const relative = path.relative(root, path.join(folder, item.name)).split(path.sep).join('/');
      try { checkedPath(root, relative); } catch { continue; }
      if (item.isDirectory()) walk(path.join(folder, item.name));
      else if (item.isFile()) result.push(relative);
    }
  }
  walk(start);
  return result;
}
