export const PLANNER_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Chat On Steroids Planner Bridge</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { max-width: 52rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
    code, pre { font-family: ui-monospace, monospace; }
    .ok { color: #17803d; } .warn { color: #a15c00; } .bad { color: #b42318; }
    li { margin: .4rem 0; } select { padding: .3rem; }
  </style>
</head>
<body>
  <h1>Planner Bridge</h1>
  <p id="bridge">Planner Bridge: checking…</p>
  <p id="project">Project: checking…</p>
  <p id="site-tools">Site Tools API: checking…</p>
  <label id="root-picker" hidden>Project root: <select id="root"></select></label>
  <h2>Tool registration</h2>
  <ul>
    <li>repo_tree: <span id="repo_tree">checking…</span></li>
    <li>repo_search: <span id="repo_search">checking…</span></li>
    <li>repo_read: <span id="repo_read">checking…</span></li>
    <li>plan_write: <span id="plan_write">checking…</span></li>
  </ul>
  <script src="/planner.js"></script>
</body>
</html>`;

export const PLANNER_SCRIPT = String.raw`(() => {
  const TOOL_NAMES = ['repo_tree', 'repo_search', 'repo_read', 'plan_write'];
  const rootParam = new URLSearchParams(window.location.search).get('root');
  let activeRootName = rootParam;
  const text = (id, value, className) => {
    const node = document.getElementById(id);
    if (node) {
      node.textContent = value;
      node.className = className || '';
    }
  };
  const api = async (route, body) => {
    const response = await fetch(route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rootName: activeRootName, ...body })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || payload.error || 'Planner request failed');
    return JSON.stringify(payload, null, 2);
  };
  const schemas = {
    repo_tree: {
      name: 'repo_tree',
      description: 'Inspect the directory structure of the approved local repository. Read-only.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, depth: { type: 'integer', minimum: 0, maximum: 6 } } },
      annotations: { readOnlyHint: true },
      execute: (input) => api('/api/planner/tree', { path: input.path || '', depth: input.depth === undefined ? 3 : input.depth })
    },
    repo_search: {
      name: 'repo_search',
      description: 'Search source files and text inside the approved local repository. Read-only.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' }, mode: { type: 'string', enum: ['name', 'content'] }, maxResults: { type: 'integer', minimum: 1, maximum: 100 }, include: { type: 'string' }, caseSensitive: { type: 'boolean' } }, required: ['query'] },
      annotations: { readOnlyHint: true },
      execute: (input) => api('/api/planner/search', { query: input.query, path: input.path || '', mode: input.mode || 'content', maxResults: input.maxResults || 50, include: input.include || null, caseSensitive: input.caseSensitive === true })
    },
    repo_read: {
      name: 'repo_read',
      description: 'Read a text file or selected line range inside the approved local repository. Read-only.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 }, maxBytes: { type: 'integer', minimum: 1, maximum: 262144 } }, required: ['path'] },
      annotations: { readOnlyHint: true },
      execute: (input) => api('/api/planner/read', { path: input.path, startLine: input.startLine === undefined ? null : input.startLine, endLine: input.endLine === undefined ? null : input.endLine, maxBytes: input.maxBytes || 262144 })
    },
    plan_write: {
      name: 'plan_write',
      description: 'Create or replace a structured planning Markdown document under docs/tasks/**. This tool cannot modify source code.',
      inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, documentType: { type: 'string', enum: ['plan', 'macro', 'micro', 'status', 'review'] }, blockId: { type: 'string' }, content: { type: 'string' } }, required: ['taskId', 'documentType', 'content'] },
      execute: (input) => api('/api/planner/write', { taskId: input.taskId, documentType: input.documentType, blockId: input.blockId === undefined ? null : input.blockId, content: input.content })
    }
  };
  const register = async (context) => {
    for (const name of TOOL_NAMES) {
      try {
        await context.registerTool(schemas[name]);
        text(name, 'registered', 'ok');
      } catch (error) {
        text(name, 'failed: ' + (error instanceof Error ? error.message : String(error)), 'bad');
      }
    }
  };
  const main = async () => {
    const statusResponse = await fetch('/api/planner/status' + (rootParam ? '?root=' + encodeURIComponent(rootParam) : ''));
    const status = await statusResponse.json();
    if (!statusResponse.ok) throw new Error(status.message || 'Planner status failed');
    text('bridge', status.running ? 'Planner Bridge: running' : 'Planner Bridge: unavailable', status.running ? 'ok' : 'bad');
    const picker = document.getElementById('root-picker');
    const select = document.getElementById('root');
    if (select && status.roots.length > 1) {
      picker.hidden = false;
      select.replaceChildren(...status.roots.map((root) => { const option = document.createElement('option'); option.value = root.name; option.textContent = '/' + root.name + (root.available ? '' : ' (unavailable)'); option.selected = root.name === status.selectedRoot; return option; }));
      select.addEventListener('change', () => { window.location.search = '?root=' + encodeURIComponent(select.value); });
    }
    if (status.selectedRoot) text('project', 'Project: /' + status.selectedRoot, 'ok');
    else text('project', status.roots.length === 0 ? 'Project: no approved root' : 'Project: select an approved root', 'warn');
    const context = document.modelContext;
    if (!context) {
      text('site-tools', 'Site Tools API: unavailable', 'warn');
      TOOL_NAMES.forEach((name) => text(name, 'unavailable', 'warn'));
      return;
    }
    text('site-tools', 'Site Tools API: detected', 'ok');
    if (!status.selectedRoot) {
      TOOL_NAMES.forEach((name) => text(name, 'waiting for project root', 'warn'));
      return;
    }
    activeRootName = status.selectedRoot;
    await register(context);
  };
  main().catch((error) => {
    text('bridge', 'Planner Bridge: unavailable', 'bad');
    text('project', 'Project: unavailable', 'bad');
    text('site-tools', 'Site Tools API: unavailable', 'warn');
    TOOL_NAMES.forEach((name) => text(name, 'failed', 'bad'));
    console.error(error instanceof Error ? error.message : String(error));
  });
})();`;
