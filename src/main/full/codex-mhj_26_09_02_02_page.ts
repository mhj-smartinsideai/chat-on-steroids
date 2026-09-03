export const FULL_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Chat On Steroids Full Bridge</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { max-width: 58rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
    code, pre { font-family: ui-monospace, monospace; }
    .ok { color: #17803d; } .warn { color: #a15c00; } .bad { color: #b42318; }
    li { margin: .35rem 0; }
    .warning { border: 1px solid #a15c00; padding: .7rem; margin: .8rem 0; }
    .muted { opacity: .8; }
  </style>
</head>
<body>
  <h1>Full Bridge</h1>
  <p id="bridge">Full Bridge: checking…</p>
  <p id="project">Project / approved roots: checking…</p>
  <p id="site-tools">WebMCP: checking…</p>
  <p id="read-only">Read-only mode: checking…</p>
  <p id="command">Command execution: checking…</p>
  <p id="desktop-control">Desktop control: checking…</p>
  <p id="session-recording">Session recording: checking…</p>
  <p id="multi-agent">Multi-agent: checking…</p>
  <div id="warnings"></div>
  <h2>Core surface</h2>
  <ul id="core-tools"><li class="muted">checking…</li></ul>
  <h2>Desktop surface</h2>
  <ul id="desktop-tools"><li class="muted">checking…</li></ul>
  <p class="muted">Tool registrations are a page snapshot. Live permissions are checked again for every call.</p>
  <script src="/full.js"></script>
</body>
</html>`;

export const FULL_SCRIPT = String.raw`(() => {
  const pageId = crypto.randomUUID();
  const registrationController = new AbortController();
  const text = (id, value, className) => {
    const node = document.getElementById(id);
    if (node) {
      node.textContent = value;
      node.className = className || '';
    }
  };
  const list = (id, entries) => {
    const node = document.getElementById(id);
    if (!node) return;
    node.replaceChildren(...entries.map((entry) => {
      const item = document.createElement('li');
      item.textContent = entry;
      return item;
    }));
  };
  const callApi = async (route, init) => {
    const response = await fetch(route, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init && init.headers ? init.headers : {}) },
      signal: init && init.signal ? init.signal : registrationController.signal
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || payload.error || 'Full Bridge request failed');
    return payload;
  };
  const registrationLabel = (tool, state) => tool.name + ': ' + state;
  const register = async (context, tool) => {
    const definition = {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.annotations ? { annotations: { readOnlyHint: tool.annotations.readOnlyHint } } : {}),
      execute: async (input, options) => {
        const payload = await callApi('/api/full/call', {
          method: 'POST',
          body: JSON.stringify({ pageId, name: tool.name, arguments: input }),
          signal: options && options.signal ? options.signal : registrationController.signal
        });
        return payload.result;
      }
    };
    await context.registerTool(definition, { signal: registrationController.signal });
  };
  const diagnosticEntries = (status, surface, stateForTool) => [
    ...status.diagnostics.filter((entry) => entry.surface === surface && entry.state === 'failed').map((entry) => registrationLabel(entry, 'failed: ' + entry.reason)),
    ...status.tools.filter((tool) => tool.surface === surface).map((tool) => registrationLabel(tool, stateForTool(tool)))
  ];
  const main = async () => {
    const status = await callApi('/api/full/tools?pageId=' + encodeURIComponent(pageId), { method: 'GET' });
    text('bridge', 'Full Bridge: running', 'ok');
    text('project', status.roots.length > 0 ? 'Project / approved roots: ' + status.roots.map((root) => '/' + root).join(', ') : 'Project / approved roots: none', status.roots.length > 0 ? 'ok' : 'warn');
    text('read-only', 'Read-only mode: ' + (status.readOnly ? 'enabled' : 'disabled'), status.readOnly ? 'warn' : 'ok');
    text('command', 'Command execution: ' + (status.capabilities.command ? 'enabled' : 'disabled'), status.capabilities.command ? 'warn' : 'ok');
    text('desktop-control', 'Desktop control: ' + (status.capabilities.control ? 'enabled' : 'disabled'), status.capabilities.control ? 'warn' : 'ok');
    text('session-recording', 'Session recording: ' + (status.sessionRecording ? 'enabled' : 'disabled'), status.sessionRecording ? 'ok' : 'warn');
    text('multi-agent', 'Multi-agent: ' + (status.multiAgent ? 'enabled' : 'disabled'), status.multiAgent ? 'warn' : 'ok');
    const warnings = [];
    if (status.capabilities.command) warnings.push('Command execution is enabled. Commands run with the normal privileges of the Windows user and are not confined to approved folders.');
    if (status.capabilities.control || status.capabilities.screen || status.capabilities.clipboardRead || status.capabilities.clipboardWrite) warnings.push('Desktop access is enabled. Screen, mouse, keyboard and clipboard operations may affect the entire desktop.');
    const warningNode = document.getElementById('warnings');
    if (warningNode) warningNode.replaceChildren(...warnings.map((message) => { const node = document.createElement('p'); node.className = 'warning warn'; node.textContent = message; return node; }));
    list('core-tools', diagnosticEntries(status, 'core', () => 'pending'));
    list('desktop-tools', diagnosticEntries(status, 'desktop', () => 'pending'));
    const context = document.modelContext;
    if (!context || typeof context.registerTool !== 'function') {
      text('site-tools', 'WebMCP: unavailable', 'warn');
      list('core-tools', diagnosticEntries(status, 'core', () => 'unavailable'));
      list('desktop-tools', diagnosticEntries(status, 'desktop', () => 'unavailable'));
      return;
    }
    text('site-tools', 'WebMCP: detected', 'ok');
    const states = new Map(status.tools.map((tool) => [tool.name, 'pending']));
    for (const tool of status.tools) {
      try {
        await register(context, tool);
        states.set(tool.name, 'registered');
      } catch (error) {
        states.set(tool.name, 'failed: ' + (error instanceof Error ? error.message : String(error)));
      }
    }
    list('core-tools', diagnosticEntries(status, 'core', (tool) => states.get(tool.name) || 'unknown'));
    list('desktop-tools', diagnosticEntries(status, 'desktop', (tool) => states.get(tool.name) || 'unknown'));
  };
  window.addEventListener('pagehide', () => registrationController.abort(), { once: true });
  main().catch((error) => {
    text('bridge', 'Full Bridge: unavailable', 'bad');
    text('site-tools', 'WebMCP: unavailable', 'warn');
    const message = error instanceof Error ? error.message : String(error);
    list('core-tools', ['failed: ' + message]);
    list('desktop-tools', ['failed: ' + message]);
  });
})();`;
