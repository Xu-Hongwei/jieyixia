/* First backend bridge: healthz + deterministic analyze fixture -> temporary planner task. */
if (concept === 'desktop') {
  const params = new URLSearchParams(location.search);
  const apiBase = (window.JXL_API_BASE || params.get('api') || 'http://127.0.0.1:8000').replace(/\/$/, '');
  const state = { status: 'idle', message: '未连接', busy: false };
  const demoSource = {
    source_id: 'src-04',
    kind: 'text',
    captured_at: '2026-11-16T21:40:00+08:00',
    text: '机器学习实验报告写作指南（课程组整理）\n\n一份合格的实验报告应当包含：问题定义、数据与预处理、方法、对比实验、结果分析、结论与局限。\n对比实验至少两组，建议包含一个朴素基线（如多数类分类器或线性回归）与一个改进方法；若改动多个模块，请补消融实验说明各模块贡献。\n图表规范：坐标轴须有单位，图例不得遮挡数据，表格数字右对齐并对齐小数位。\n写作提醒：结论段不要重复摘要，应回答「所以呢」；局限段要写清失败情形，而不是套话。\n关键词：对比实验、消融、图表规范、可复现。',
  };
  const valueOf = (fields, key) => (fields || []).find(field => field.key === key)?.value;
  const asList = value => Array.isArray(value) ? value : value ? [value] : [];
  const paint = () => {
    document.querySelectorAll('[data-pn-backend-status]').forEach(el => {
      el.textContent = state.message;
      el.dataset.state = state.status;
    });
    document.querySelectorAll('[data-pn-backend-action]').forEach(button => {
      button.disabled = state.busy;
      button.setAttribute('aria-busy', String(state.busy));
    });
  };
  const setStatus = (status, message, busy = false) => { state.status = status; state.message = message; state.busy = busy; paint(); };
  async function request(path, options = {}) {
    const response = await fetch(`${apiBase}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(body?.message || `后端返回 ${response.status}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }
  async function health() {
    setStatus('loading', '检查中…', true);
    try {
      const body = await request('/api/healthz');
      setStatus(body.model_ready ? 'ready' : 'warning', body.model_ready ? '已连接 · 可分析' : '已连接 · 模型不可用');
      return body;
    } catch (error) {
      setStatus('error', error.message || '后端不可达');
      throw error;
    }
  }
  function taskFromAnalysis(body) {
    const title = valueOf(body.fields, 'title') || '后端分析任务';
    const summary = valueOf(body.fields, 'summary');
    const keywords = asList(valueOf(body.fields, 'keywords'));
    const deadline = valueOf(body.fields, 'deadline');
    const requirements = [summary, ...keywords.map(keyword => `关键词：${keyword}`)].filter(Boolean);
    return {
      id: `api-${body.source_id}`,
      backendSourceId: body.source_id,
      title,
      due: deadline || '',
      time: typeof deadline === 'string' && deadline.includes('T') ? deadline.slice(11, 16) : '',
      plan: '',
      start: '',
      color: 'cream',
      category: '后端分析',
      requirements: requirements.length ? requirements : ['后端未返回可展示的要求字段'],
      submit: '后端未指定',
      source: `后端分析 · ${body.model_name || 'unknown'}`,
    };
  }
  async function importReference() {
    setStatus('loading', '分析中…', true);
    try {
      const body = await request('/api/analyze', { method: 'POST', body: JSON.stringify(demoSource) });
      const task = taskFromAnalysis(body);
      document.dispatchEvent(new CustomEvent('collage-backend-task', { detail: { task, analysis: body, apiBase } }));
      setStatus('ready', `已导入 · ${body.model_name || 'fixture'}`);
      return body;
    } catch (error) {
      setStatus('error', error.status ? `${error.status} · ${error.message}` : '后端不可达');
      throw error;
    }
  }
  window.collageBackend = { apiBase, health, importReference };
}
