import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('请通过 npm run package 执行');
for (const args of [['run', 'build'], ['run', 'check']]) {
  const run = spawnSync(process.execPath, [npm, ...args], { cwd: root, stdio: 'inherit' });
  if (run.status !== 0) process.exit(run.status || 1);
}
fs.mkdirSync(new URL('../dist/', import.meta.url), { recursive: true });
const pack = spawnSync(process.execPath, [npm, 'pack', '--json', '--pack-destination', 'dist'], { cwd: root, encoding: 'utf8' });
if (pack.status !== 0) throw new Error(pack.stderr);
const result = JSON.parse(pack.stdout)[0];
if (result.files.some(f => /(^|\/)\.work\//.test(f.path) || /(^|\/)\.env($|\.)/.test(f.path))) throw new Error('分发包混入了本机运行数据');
if (!result.files.some(f=>f.path === 'web/app.bundle.js') || !result.files.some(f=>f.path === '.agents/plugins/marketplace.json')) throw new Error('分发包缺少前端产物或安装目录');
const bytes = fs.readFileSync(new URL(`../dist/${result.filename}`, import.meta.url));
const hash = crypto.createHash('sha256').update(bytes).digest('hex');
fs.writeFileSync(new URL('../dist/SHA256SUMS.txt', import.meta.url), `${hash}  ${result.filename}\n`);
console.log(`已生成 dist/${result.filename}（含前端产物和运行依赖）\nSHA256: ${hash}`);
