import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { connect } from '../src/client.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const archive = path.join(repository, 'dist', 'baigong-0.1.0.tgz');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baigong-install-'));
const workspace = path.join(root,'project');
const codexDirectory = path.join(root,'codex');
fs.mkdirSync(workspace); fs.mkdirSync(codexDirectory);
const env = { ...process.env, CODEX_HOME: codexDirectory };

function run(command, args, options = {}) {
  const result = spawnSync(command,args,{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:60000,...options});
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stderr || result.stdout || result.error}`);
  return result.stdout;
}

let client;
try {
  const paths=run('tar',['-tzf',archive]).trim().split(/\r?\n/);
  assert.ok(paths.every(p=>p.startsWith('package/')&&!p.split('/').includes('..')));
  assert.ok(!paths.some(p=>p.includes('/.work/')));
  run('tar',['-xzf',archive,'-C',root]);
  const plugin=path.join(root,'package');
  const help=run(process.execPath,[path.join(plugin,'bin','baigong.mjs'),'--help']);
  assert.match(help,/百工/);
  const codex=process.env.BAIGONG_CODEX || 'codex';
  run(codex,['plugin','marketplace','add',plugin]);
  const available=JSON.parse(run(codex,['plugin','list','--available','--json']));
  assert.ok(available.available?.some(p=>p.name==='baigong'),JSON.stringify(available));
  const installed=JSON.parse(run(codex,['plugin','add','baigong@baigong-local','--json']));
  assert.ok(installed.installedPath,JSON.stringify(installed));
  assert.ok(fs.existsSync(path.join(installed.installedPath,'skills','baigong','SKILL.md')));
  assert.ok(fs.existsSync(path.join(installed.installedPath,'node_modules','@modelcontextprotocol','sdk','package.json')));
  const mcp=new StdioClientTransport({command:process.execPath,args:[path.join(installed.installedPath,'bin','baigong.mjs'),'mcp','--workspace',workspace,'--secrets-dir',path.join(root,'vault')],stderr:'pipe'});
  client=new Client({name:'baigong-clean-install',version:'1.0.0'});
  await client.connect(mcp);
  const state=await client.callTool({name:'baigong_get_state',arguments:{}});
  assert.equal(state.structuredContent.data.config.settings.enabled,false);
  assert.equal(state.structuredContent.data.config.models.length,0);
  const ui=await client.readResource({uri:'ui://baigong/dashboard-v1.html'});
  assert.ok(ui.contents[0].text.includes('BAIGONG_EMBEDDED'));
  console.log('干净安装验收通过：分发包 → 本地 marketplace → Codex 安装缓存 → MCP 工具与内嵌界面资源。');
  console.log('未修改真实 Codex 配置，未调用外部模型。');
} finally {
  await client?.close();
  const connection=await connect(workspace);
  if(connection) await fetch(`${connection.origin}/api/shutdown`,{method:'POST',headers:{Authorization:`Bearer ${connection.token}`,'Content-Type':'application/json'},body:'{}'});
  // Windows may still hold an installed file briefly after closing the child process.
  await new Promise(resolve=>setTimeout(resolve,300));
  if(path.dirname(root)===fs.realpathSync(os.tmpdir())&&path.basename(root).startsWith('baigong-install-')) fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
