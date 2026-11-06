import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
let count = 0;
for (const directory of ['bin', 'src', 'scripts', 'web', 'test']) {
  const absolute = path.join(root, directory);
  if (!fs.existsSync(absolute)) continue;
  for (const name of fs.readdirSync(absolute).filter(f => /\.(m?js)$/.test(f) && !f.endsWith('.bundle.js'))) {
    const result = spawnSync(process.execPath, ['--check', path.join(absolute, name)], { encoding: 'utf8' });
    if (result.status) throw new Error(result.stderr);
    count++;
  }
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
const mcp = JSON.parse(fs.readFileSync(path.join(root, 'mcp.json'), 'utf8'));
const marketplace = JSON.parse(fs.readFileSync(path.join(root, '.agents/plugins/marketplace.json'), 'utf8'));
if (manifest.name !== 'baigong' || mcp.mcpServers.baigong.type !== 'stdio' || marketplace.plugins[0].name !== manifest.name) throw new Error('插件清单不一致');
const skill = fs.readFileSync(path.join(root, 'skills/baigong/SKILL.md'), 'utf8');
if (!skill.startsWith('---\nname: baigong\n') || /\[TODO:/.test(skill)) throw new Error('技能元数据无效');
if (!fs.existsSync(path.join(root, 'web/app.bundle.js'))) throw new Error('先执行 npm run build');
console.log(`语法检查通过（${count} 个源文件）；插件清单、技能入口和界面产物齐全。`);
