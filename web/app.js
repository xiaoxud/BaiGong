import { App } from '@modelcontextprotocol/ext-apps';

const embedded = window.BAIGONG_EMBEDDED === true;
const root = document.querySelector('#app');
const modelDialog = document.querySelector('#model-dialog');
const taskDialog = document.querySelector('#task-dialog');
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const labels = { queued: '等待执行', running: '执行中', 'awaiting-review': '待审核', approved: '已通过', rejected: '未采用', cancelled: '已取消', failed: '执行失败' };
let state, page = 'models', filter = 'all', bridge, token, busy = false, detailId;
let toastTimer;

function toast(message, error = false) {
  const el = document.querySelector('#toast');
  el.textContent = message; el.className = `show${error ? ' error' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.className = '', 4500);
}

async function api(action, args = {}) {
  if (embedded) {
    const result = await bridge.callServerTool({ name: `baigong_${action}`, arguments: args });
    if (result.isError) throw new Error(result.content?.find(c => c.type === 'text')?.text || '操作失败');
    return result.structuredContent.data;
  }
  const response = await fetch('/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ action, args }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作失败');
  return result.result;
}

async function refresh(render = true) {
  state = await api('get_state');
  if (render) draw();
}

function badge(status) {
  const kind = ['running', 'approved'].includes(status) ? '' : ['queued', 'awaiting-review'].includes(status) ? ' warn' : status === 'failed' ? ' red' : ' neutral';
  return `<span class="badge${kind}">${escape(labels[status] || status)}</span>`;
}

function draw() {
  const pending = state.tasks.filter(t => t.status === 'awaiting-review').length;
  const enabled = state.config.settings.enabled;
  root.innerHTML = `<div class="shell">
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark">工</div><div><div class="brand-name">百工</div><div class="brand-sub">BAIGONG STUDIO</div></div></div>
      <div class="nav-label">WORKSPACE</div>
      <nav class="nav" aria-label="工作台导航">
        ${[['models','◈','模型管理'],['tasks','▤','任务中心'],['settings','☷','协作设置'],['workspace','⌘','工作区']].map(([id,icon,label]) => `<button data-nav="${id}" class="${page === id ? 'active' : ''}" ${page === id ? 'aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${icon}</span>${label}${id === 'tasks' && pending ? `<span class="nav-count">${pending}</span>` : ''}</button>`).join('')}
      </nav>
      <div class="sidebar-bottom"><div class="local-status"><span class="dot"></span> 本地服务已连接</div><p>你的模型，你的工作区。<br>百工 v${escape(state.version)}</p></div>
    </aside>
    <main class="main">
      <header class="topbar"><div class="breadcrumb">百工协作台 <span>/</span><strong>${{ models:'模型管理', tasks:'任务中心', settings:'协作设置', workspace:'工作区' }[page]}</strong></div>
      <div class="toolbar"><span class="enable-label">协作${enabled ? '已启用' : '已关闭'}</span><button class="switch ${enabled ? 'on' : ''}" id="global-toggle" role="switch" aria-checked="${enabled}" aria-label="启用百工协作"></button></div></header>
      ${page === 'models' ? modelsView() : page === 'tasks' ? tasksView() : page === 'settings' ? settingsView() : workspaceView()}
      <footer class="footer-note"><span>你定目标，百工协作。</span><span>LOCAL FIRST · HUMAN & AGENT REVIEW</span></footer>
    </main></div>`;
  document.querySelectorAll('[data-nav]').forEach(button => button.onclick = () => { page = button.dataset.nav; draw(); });
  document.querySelector('#global-toggle').onclick = async () => {
    try { await api('update_settings', { enabled: !enabled }); await refresh(); toast(enabled ? '已关闭协作，排队任务已取消；执行中的任务可单独取消' : '已启用协作，可开始分配任务'); }
    catch (error) { toast(error.message, true); }
  };
  bindPage();
}

function modelsView() {
  const models = state.config.models;
  const ready = models.filter(m => m.enabled && m.test?.ok).length;
  return `<section class="page-head"><div><div class="eyebrow">YOUR MULTI-MODEL WORKBENCH</div><h1>让各有所长，协同成事。</h1><p>连接你信任的模型，由主智能体分配任务、审核成果。</p></div><button class="primary" data-add-model>＋ 添加模型</button></section>
    <section class="stats" aria-label="协作概况">
      ${[[models.length,'已连接模型','个'],[ready,'可分配模型','个'],[state.tasks.filter(t=>['running','queued'].includes(t.status)).length,'进行中的任务','项'],[state.tasks.filter(t=>t.status==='awaiting-review').length,'等待主智能体审核','项']].map(([n,l,u])=>`<div class="stat"><div class="stat-label">${l}</div><div class="stat-number">${n}<span>${u}</span></div></div>`).join('')}
    </section>
    ${!state.config.settings.enabled ? '<div class="notice">协作当前处于关闭状态。你可以先配置并测试模型，准备好后打开右上角开关。连接测试会进行两次小型模型调用。</div>' : ''}
    <div class="section-head"><h2>我的模型 <small> / ${models.length.toString().padStart(2,'0')}</small></h2><small>能力描述帮助主智能体选择执行者</small></div>
    ${models.length ? `<div class="model-grid">${models.map(modelCard).join('')}</div>` : `<div class="empty"><div class="empty-symbol">◈</div><h3>第一位工匠，等待入席</h3><p>添加模型的 API 地址与密钥，描述它的专长。<br>完成连接测试后，它就能接受主智能体分配的任务。</p><button data-add-model>添加第一个模型 ↗</button></div>`}
    <div class="section-head"><h2>从一种专长开始</h2><small>点击预填能力描述，模型由你选择</small></div>
    <div class="recipe-grid">${[['代码实现','⌘','擅长代码实现、修复问题、编写测试建议。','把明确的需求变成可审查的代码产出。'],['研究分析','◎','擅长阅读材料、分析问题、整理证据和结论。','从指定材料中提炼有依据的发现。'],['内容创作','✳','擅长中文写作、编辑润色、结构整理。','让表达清晰，让内容更贴近目标。']].map(([title,icon,description,text])=>`<button class="recipe" data-recipe="${escape(description)}"><div class="recipe-symbol" aria-hidden="true">${icon}</div><b>${title}</b><p>${text}</p></button>`).join('')}</div>`;
}

function modelCard(m) {
  return `<article class="model-card"><div class="card-top"><div class="model-identity"><div class="model-avatar ${m.provider === 'deepseek' ? '' : 'compat'}">${m.provider === 'deepseek' ? 'D' : 'A'}</div><div><h3>${escape(m.name)}</h3><small>${escape(m.model)}</small></div></div><span class="badge ${!m.enabled ? 'neutral' : m.test?.ok ? '' : 'warn'}">${!m.enabled ? '已停用' : m.test?.ok ? '连接已验证' : '待测试'}</span></div><p class="model-desc">${escape(m.description || '添加一段能力描述，让主智能体更好地分配任务。')}</p><div class="meta-row"><span class="tag">${escape(m.provider === 'deepseek' ? 'DeepSeek' : 'OpenAI 兼容')}</span><span class="tag">${m.maxTokens.toLocaleString()} tokens / 次</span><span class="tag">${m.hasKey ? '密钥已加密保存' : '未配置密钥'}</span></div><div class="card-bottom"><small>${m.test?.at ? `验证于 ${escape(time(m.test.at))}` : '尚未验证工具调用能力'}</small><div><button data-test-model="${escape(m.id)}">测试连接</button> <button data-edit-model="${escape(m.id)}">配置</button></div></div></article>`;
}

function tasksView() {
  const tasks = state.tasks.filter(t => filter === 'all' || (filter === 'active' ? ['queued','running'].includes(t.status) : t.status === filter));
  return `<section class="page-head"><div><div class="eyebrow">ASSIGN · EXECUTE · REVIEW</div><h1>每份产出，都有交代。</h1><p>查看执行过程与文件变化。任务提交后，由主智能体或你审核。</p></div><button class="primary" id="new-task">＋ 创建任务</button></section>
    <div class="task-filter">${[['all','全部任务'],['active','进行中'],['awaiting-review','待审核'],['approved','已通过'],['failed','失败']].map(([id,label])=>`<button data-filter="${id}" class="${filter===id?'selected':''}">${label}</button>`).join('')}</div>
    ${tasks.length ? `<div class="task-list">${tasks.map(t=>`<button class="task-row" data-task="${t.id}"><div><div class="task-title">${escape(t.title)}</div><div class="task-meta"><span>${escape(t.modelName)}</span><span>${escape(time(t.createdAt))}</span><span>${t.steps} 次调用 · ${t.revision} 次返工</span></div></div>${badge(t.status)}</button>`).join('')}</div>` : '<div class="empty"><div class="empty-symbol">▤</div><h3>这里将记录每一次协作</h3><p>在聊天中让主智能体分配任务，或在这里手动创建。<br>任务的输入、工作副本和审核记录都保存在 .work 中。</p></div>'}`;
}

function settingsView() {
  const s = state.config.settings;
  return `<section class="page-head"><div><div class="eyebrow">COLLABORATION PREFERENCES</div><h1>协作有度，进退有据。</h1><p>设置执行限额。模型选择由主智能体结合任务和能力描述决定。</p></div></section>
    <form id="settings-form" class="panel"><h2>执行与返工</h2><p>单次任务保存创建时的限额。修改设置对后续新任务生效；并发限制立即生效。</p><div class="form-grid">
      ${[['concurrency','同时执行任务数',1,8,'超过上限的任务会排队。'],['maxSteps','每轮执行的模型调用上限',2,40,'达到上限后标记失败，不无限循环。'],['timeoutSeconds','每轮执行超时（秒）',10,600,'同时用于连接测试的请求超时。'],['maxRevisions','每个任务最多返工次数',0,5,'返工会产生额外 API 调用。']].map(([id,label,min,max,help])=>`<div class="field"><label for="${id}">${label}</label><input id="${id}" name="${id}" type="number" min="${min}" max="${max}" value="${s[id]}" required><small>${help}</small></div>`).join('')}
    </div><div class="notice">调用轮数、输出 token 和超时是执行边界，不是精确的金额预算。实际费用以模型平台账单为准。关闭协作后，排队任务取消，执行中的任务可在任务中心取消。</div><div class="actions"><button class="primary" type="submit">保存协作设置</button></div></form>`;
}

function workspaceView() {
  return `<section class="page-head"><div><div class="eyebrow">LOCAL WORKSPACE</div><h1>各有工位，产出可查。</h1><p>当前工作区由启动参数确定，切换项目时为目标项目启动百工。</p></div></section><section class="panel"><h2>当前项目</h2><div class="workspace-path">${escape(state.config.workspace)}</div><p>只复制分配任务时明确选择的文本文件；不会自动扫描或上传整个项目。</p><div class="tree">.work/
├─ config.json                 模型信息与协作设置（无 API Key）
├─ runtime/                    本地服务连接信息（不要分享）
└─ tasks/task-…/
   ├─ assignment.md            任务与验收标准
   ├─ original/                输入文件原始快照
   ├─ workspace/               子智能体工作副本
   ├─ task.json                结果、事件与用量
   └─ review.json              审核记录</div><p>审核通过只记录验收，由主智能体检查后采用文件变更。第一版提供受限的文件工具，不向 worker 开放终端命令。</p></section><section class="panel"><h2>凭据与版本管理</h2><p>API Key 保存在当前用户的独立凭据库。Windows 使用 DPAPI 加密；其他系统使用带私有文件权限的本地 AES-GCM 凭据库。密钥不会返回到聊天或配置读取结果。</p><div class="workspace-path">建议在项目 .gitignore 中加入：.work/</div><p>.work 内包含任务材料和本地访问令牌，不属于插件分发内容。</p></section>`;
}

function bindPage() {
  document.querySelectorAll('[data-add-model]').forEach(b => b.onclick = () => editModel());
  document.querySelectorAll('[data-recipe]').forEach(b => b.onclick = () => editModel(null, b.dataset.recipe));
  document.querySelectorAll('[data-edit-model]').forEach(b => b.onclick = () => editModel(b.dataset.editModel));
  document.querySelectorAll('[data-test-model]').forEach(b => b.onclick = () => testModel(b.dataset.testModel, b));
  document.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => { filter = b.dataset.filter; draw(); });
  document.querySelectorAll('[data-task]').forEach(b => b.onclick = () => showTask(b.dataset.task));
  const newTask = document.querySelector('#new-task');
  if (newTask) newTask.onclick = () => createTask();
  const form = document.querySelector('#settings-form');
  if (form) form.onsubmit = async event => {
    event.preventDefault();
    try { await api('update_settings', Object.fromEntries([...new FormData(form)].map(([k,v])=>[k,Number(v)]))); await refresh(); toast('协作设置已保存'); }
    catch (error) { toast(error.message, true); }
  };
}

function closeButton(dialog) { dialog.querySelector('[data-close]').onclick = () => dialog.close(); }

function editModel(id, description = '') {
  const old = state.config.models.find(m => m.id === id);
  const m = old || { id:'', name:'', provider:'deepseek', baseUrl:'https://api.deepseek.com', model:'', description, enabled:true, thinking:'default', maxTokens:4096 };
  modelDialog.innerHTML = `<header class="dialog-head"><div><h2>${old ? '配置模型' : '添加一位工匠'}</h2><p>连接第三方 API，保存后再测试工具调用能力。</p></div><button class="close" data-close aria-label="关闭模型配置">×</button></header><form id="model-form" class="dialog-content"><div class="form-grid">
    <div class="field"><label for="m-name">显示名称</label><input id="m-name" name="name" value="${escape(m.name)}" placeholder="例如：代码工匠" maxlength="80" required></div>
    <div class="field"><label for="m-id">模型标识</label><input id="m-id" name="id" value="${escape(m.id)}" placeholder="例如：deepseek-code" pattern="[a-z0-9]([a-z0-9]|-){0,63}" ${old?'readonly':''} required><small>小写字母、数字和连字符，保存后不可修改。</small></div>
    <div class="field"><label for="m-provider">接口类型</label><select id="m-provider" name="provider"><option value="deepseek" ${m.provider==='deepseek'?'selected':''}>DeepSeek</option><option value="openai-compatible" ${m.provider==='openai-compatible'?'selected':''}>OpenAI 兼容接口</option></select></div>
    <div class="field"><label for="m-model">完整模型 ID</label><input id="m-model" name="model" value="${escape(m.model)}" placeholder="填写 /models 返回的 ID" required><small>第一版使用 Chat Completions 工具协议。</small></div>
    <div class="field full"><label for="m-url">API 根地址</label><input id="m-url" name="baseUrl" type="url" value="${escape(m.baseUrl)}" placeholder="https://api.example.com/v1" required><small>填写平台提供的根地址，不附加 /chat/completions。</small></div>
    <div class="field full"><label for="m-key">API Key ${old?.hasKey?'· 已保存':''}</label><input id="m-key" name="apiKey" type="password" autocomplete="new-password" placeholder="${old?.hasKey?'留空保留现有密钥':'输入你自己的 API Key'}" ${old?.hasKey?'':'required'}><small>仅发送至本地执行服务，加密保存，不提供密钥回显。</small></div>
    <div class="field full"><label for="m-description">能力描述</label><textarea id="m-description" name="description" maxlength="1500" placeholder="擅长什么？适合哪些任务？有哪些限制？">${escape(m.description)}</textarea></div>
    <div class="field"><label for="m-thinking">思考模式</label><select id="m-thinking" name="thinking">${[['default','跟随平台默认'],['enabled','开启（需平台支持）'],['disabled','关闭（需平台支持）']].map(([v,l])=>`<option value="${v}" ${m.thinking===v?'selected':''}>${l}</option>`).join('')}</select></div>
    <div class="field"><label for="m-max">单次最大输出 tokens</label><input id="m-max" name="maxTokens" type="number" min="256" max="16384" value="${m.maxTokens}" required></div>
    <label class="checkbox full"><input type="checkbox" name="enabled" ${m.enabled?'checked':''}> 启用此模型</label>
    </div><div class="inline-message" id="model-error" role="alert"></div><div class="dialog-footer"><div>${old?'<button type="button" class="danger" id="delete-model">移除模型</button>':'<small>密钥与插件代码分开存储。</small>'}</div><button class="primary" type="submit">保存模型</button></div></form>`;
  closeButton(modelDialog);
  modelDialog.showModal();
  modelDialog.querySelector('#model-form').onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    data.enabled = form.elements.enabled.checked;
    data.maxTokens = Number(data.maxTokens);
    if (!data.apiKey) delete data.apiKey;
    const button = form.querySelector('button[type=submit]'); button.disabled = true;
    try { await api('save_model', data); form.elements.apiKey.value=''; modelDialog.close(); await refresh(); toast('模型已保存，请测试连接后再分配任务'); }
    catch (error) { modelDialog.querySelector('#model-error').textContent = error.message; }
    finally { button.disabled = false; }
  };
  if (old) modelDialog.querySelector('#delete-model').onclick = async () => {
    if (!confirm(`移除「${old.name}」及其凭据？已有任务记录将保留。`)) return;
    try { await api('delete_model', { id }); modelDialog.close(); await refresh(); toast('模型已移除'); }
    catch(error) { modelDialog.querySelector('#model-error').textContent = error.message; }
  };
}

async function testModel(id, button) {
  if (!confirm('连接测试会请求模型目录，并进行两次真实模型调用，可能产生少量费用。继续？')) return;
  button.disabled = true; button.textContent = '验证中…'; busy = true;
  try { const result = await api('test_model', { id }); await refresh(); toast(result.modelMatched ? '连接成功，工具调用往返已验证' : '工具调用通过；平台返回的模型名与配置不同，请核对平台映射'); }
  catch (error) { await refresh().catch(()=>{}); toast(error.message, true); }
  finally { busy = false; button.disabled = false; button.textContent = '测试连接'; }
}

function createTask() {
  const models = state.config.models.filter(m => m.enabled && m.test?.ok);
  if (!state.config.settings.enabled || !models.length) { toast('请先验证模型连接并启用协作', true); return; }
  taskDialog.className = '';
  taskDialog.innerHTML = `<header class="dialog-head"><div><h2>分配一个任务</h2><p>执行只影响任务副本，完成后需要审核。</p></div><button class="close" data-close aria-label="关闭任务创建">×</button></header><form id="task-form" class="dialog-content"><div class="form-grid">
    <div class="field"><label for="t-model">执行模型</label><select id="t-model" name="modelId">${models.map(m=>`<option value="${escape(m.id)}">${escape(m.name)}</option>`).join('')}</select></div><div class="field"><label for="t-mode">执行权限</label><select id="t-mode" name="mode"><option value="read-only">只读分析</option><option value="edit-files">读写任务副本</option></select></div>
    <div class="field full"><label for="t-title">任务名称</label><input id="t-title" name="title" maxlength="120" required></div><div class="field full"><label for="t-instructions">任务内容</label><textarea id="t-instructions" name="instructions" maxlength="40000" required></textarea></div><div class="field full"><label for="t-acceptance">验收标准</label><textarea id="t-acceptance" name="acceptance" maxlength="10000" required placeholder="应交付什么，如何判断完成？"></textarea></div><div class="field full"><label for="t-reason">选择该模型的原因</label><input id="t-reason" name="assignmentReason" maxlength="1500" required></div><div class="field full"><label for="t-files">输入文件（每行一个相对路径，可留空）</label><textarea id="t-files" name="files" placeholder="src/example.js&#10;docs/requirements.md"></textarea><small>只复制这些文件。请勿选择敏感材料；内容会发送到所选第三方平台。</small></div></div><div id="task-error" class="inline-message" role="alert"></div><div class="actions"><button type="submit" class="primary">分配并执行</button></div></form>`;
  closeButton(taskDialog); taskDialog.showModal();
  taskDialog.querySelector('#task-form').onsubmit = async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    data.files = data.files.split('\n').map(s=>s.trim()).filter(Boolean);
    const button = event.currentTarget.querySelector('[type=submit]'); button.disabled = true;
    try { const task = await api('start_task', data); await refresh(); await showTask(task.id); toast('任务已分配'); }
    catch (error) { document.querySelector('#task-error').textContent=error.message; }
    finally { button.disabled=false; }
  };
}

async function showTask(id, silent = false) {
  try {
    const task = await api('get_task', { id });
    detailId = id;
    if (silent && document.querySelector('#review-notes')?.value) return;
    taskDialog.className = 'task-detail';
    taskDialog.innerHTML = `<header class="dialog-head"><div><h2>${escape(task.title)}</h2><p>${escape(task.modelName)} · ${escape(time(task.createdAt))} · ${task.steps} 次模型调用</p></div><button class="close" data-close aria-label="关闭任务详情">×</button></header><div class="dialog-content"><div class="detail-section">${badge(task.status)} <span class="tag">${task.mode==='edit-files'?'读写任务副本':'只读分析'}</span> <span class="tag">返工 ${task.revision} / ${task.limits.maxRevisions}</span></div>
      <section class="detail-section"><h3>分配原因</h3><p class="prose">${escape(task.assignmentReason)}</p></section><section class="detail-section"><h3>任务与验收标准</h3><p class="prose">${escape(task.instructions)}\n\n${escape(task.acceptance)}</p></section>
      ${task.error?`<div class="notice">${escape(task.error)}</div>`:''}${task.result?`<section class="detail-section"><h3>执行结果 · 待审核内容</h3><div class="prose">${escape(task.result)}</div></section>`:''}
      <section class="detail-section"><h3>任务文件</h3>${task.artifacts?.length?`<div class="artifact-tabs">${task.artifacts.map(a=>`<button data-artifact="${escape(a.path)}">${escape(a.path)} · ${{added:'新增',modified:'已修改',unchanged:'未修改'}[a.status]}</button>`).join('')}</div><div id="artifact-view"></div>`:'<p class="prose">暂无已提交的文件产出。</p>'}</section>
      <section class="detail-section"><h3>执行记录</h3><div class="timeline">${task.events.map(e=>`<div><time>${escape(time(e.at))}</time>${escape(e.detail)}</div>`).join('') || '<small>等待执行</small>'}</div></section>
      <section class="detail-section"><h3>用量与模型</h3><p class="prose">输入 ${task.usage.promptTokens.toLocaleString()} / 输出 ${task.usage.completionTokens.toLocaleString()} tokens（平台回报累计）\n请求：${escape(task.upstreamModel)} / 返回：${escape(task.returnedModel || '尚未返回')}\n工作目录：${escape(state.config.workDirectory)}/tasks/${task.id}/workspace</p></section>
      ${task.reviews.length?`<section class="detail-section"><h3>审核记录</h3><div class="prose">${task.reviews.map(r=>`${escape(time(r.at))} · ${escape(r.decision)}\n${escape(r.notes)}`).join('\n\n')}</div></section>`:''}
      ${task.status==='awaiting-review'?'<section class="detail-section field"><label for="review-notes">审核依据 / 返工要求</label><textarea id="review-notes" placeholder="记录检查了哪些文件、运行了哪些验证，或具体需要修改什么。"></textarea><div class="actions"><button data-review="reject">不采用</button><button data-review="request-changes">退回返工</button><button class="primary" data-review="approve">审核通过</button></div><small>通过只记录验收，不自动覆盖项目源码。</small></section>':''}
      ${['running','queued'].includes(task.status)?'<div class="dialog-footer"><small>执行中的任务每隔数秒刷新。</small><button class="danger" id="cancel-task">取消任务</button></div>':''}</div>`;
    closeButton(taskDialog);
    if (!taskDialog.open) taskDialog.showModal();
    taskDialog.querySelectorAll('[data-artifact]').forEach(button => button.onclick = async () => {
      try { const file = await api('get_artifact', { id, path: button.dataset.artifact });
        const view = taskDialog.querySelector('#artifact-view');
        view.innerHTML = '<h3>原始内容</h3><pre class="code original"></pre><h3>任务产出</h3><pre class="code current"></pre>';
        view.querySelector('.original').textContent = file.original ?? '（新增文件）'; view.querySelector('.current').textContent = file.content;
      } catch(error) { toast(error.message,true); }
    });
    taskDialog.querySelectorAll('[data-review]').forEach(button => button.onclick = async () => {
      const notes = taskDialog.querySelector('#review-notes').value.trim();
      if (!notes) { toast('请填写审核依据或具体返工要求',true); return; }
      button.disabled=true;
      try { await api('review_task',{id,decision:button.dataset.review,notes}); await refresh(); await showTask(id); toast('审核决定已记录'); }
      catch(error) { toast(error.message,true); }
      finally { button.disabled=false; }
    });
    const cancel = taskDialog.querySelector('#cancel-task');
    if (cancel) cancel.onclick = async () => { try { await api('cancel_task',{id}); await refresh(); await showTask(id); toast('任务已取消'); } catch(error) { toast(error.message,true); } };
  } catch(error) { if (!silent) toast(error.message,true); }
}

async function boot() {
  if (embedded) {
    document.body.classList.add('embedded');
    bridge = new App({ name: 'BaiGong', version: '0.1.0' }, {}, { autoResize: true });
    await bridge.connect();
  } else {
    const hash = new URLSearchParams(location.hash.slice(1));
    token = hash.get('token') || sessionStorage.getItem('baigong-token');
    if (hash.has('token')) { sessionStorage.setItem('baigong-token', token); history.replaceState(null,'',location.pathname); }
    if (!token) throw new Error('请运行 npm start，并使用输出的完整地址打开配置面板。');
  }
  await refresh();
  setInterval(async () => {
    if (document.hidden || busy || modelDialog.open || (taskDialog.open && !detailId)) return;
    try {
      if (taskDialog.open) {
        const task = state.tasks.find(t => t.id === detailId);
        if (['running','queued'].includes(task?.status)) { await refresh(false); await showTask(detailId,true); }
      } else if (!document.querySelector('form')?.contains(document.activeElement)) await refresh();
    } catch { /* Preserve the current view during temporary service interruptions. */ }
  }, 4000);
}

taskDialog.addEventListener('close',()=>detailId=null);
boot().catch(error => {
  root.innerHTML = `<div class="error-page"><div class="eyebrow">BAIGONG · CONNECTION</div><h1>还差一步，连接工作台。</h1><p>${escape(error.message)}</p></div>`;
});
