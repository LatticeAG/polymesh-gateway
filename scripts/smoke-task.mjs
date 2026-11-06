// Node 22+; run against a locally migrated Wrangler server.
const base = (process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const sockets = [];
const timeoutMs = 20000;

async function post(path, body) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

function connect(label, token, mesh) {
  const url = new URL('/api/v1/ws', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', token);
  url.searchParams.set('mesh', mesh);
  const ws = new WebSocket(url);
  sockets.push(ws);
  const queue = [];
  let wake;
  let failure;
  ws.addEventListener('message', event => {
    try {
      const message = JSON.parse(event.data);
      console.log(`${label} recv ${message.type}`);
      queue.push(message);
    } catch (error) { failure = error; }
    wake?.();
  });
  ws.addEventListener('error', () => { failure = new Error(`${label} WebSocket error`); wake?.(); });
  ws.addEventListener('close', event => { failure = new Error(`${label} WebSocket closed: ${event.code} ${event.reason}`); wake?.(); });
  return {
    send: message => ws.send(JSON.stringify(message)),
    async receive(type) {
      const deadline = Date.now() + timeoutMs;
      while (true) {
        if (failure) throw failure;
        const error = queue.find(message => message.type === 'error');
        if (error) throw new Error(`${label}: ${error.code}: ${error.message}`);
        const index = queue.findIndex(message => message.type === type);
        if (index !== -1) return queue.splice(index, 1)[0];
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`${label} timeout waiting for ${type}`);
        await new Promise(resolve => {
          const timer = setTimeout(() => { wake = undefined; resolve(); }, remaining);
          wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
        });
      }
    },
  };
}

try {
  const worker = await post('/agents', { display_name: `worker-${suffix}` });
  const submitter = await post('/agents', { display_name: `submitter-${suffix}` });
  const mesh = await post('/meshes', { name: `smoke-${suffix}`, agent_id: worker.agent_id });
  await post(`/meshes/${encodeURIComponent(mesh.mesh_id)}/join`, { agent_id: submitter.agent_id, invite_code: mesh.invite_code });
  const workerToken = await post('/auth/token', { api_key: worker.api_key });
  const submitterToken = await post('/auth/token', { api_key: submitter.api_key });
  const w = connect('worker', workerToken.token, mesh.mesh_id);
  await w.receive('mesh.joined');
  w.send({ type: 'card.announce', capabilities: [] });
  await w.receive('card.registered');
  const s = connect('submitter', submitterToken.token, mesh.mesh_id);
  await s.receive('mesh.joined');
  s.send({ type: 'card.announce', capabilities: [] });
  await s.receive('card.registered');
  s.send({ type: 'task.submit', target: worker.agent_id, capability: 'smoke', payload: { hello: 'world' }, task_id: suffix });
  const task = await w.receive('task.submit');
  if (task.task_id !== suffix || task.from !== submitter.agent_id || task.payload?.hello !== 'world') throw new Error('Incorrect task delivery');
  w.send({ type: 'task.complete', task_id: task.task_id, result: { ok: true } });
  const completed = await s.receive('task.completed');
  if (completed.task_id !== suffix || completed.result?.ok !== true) throw new Error('Incorrect task result');
  console.log('TASK E2E PASS');
} catch (error) {
  console.error(`TASK E2E FAIL ${error.message}`);
  process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.close();
}
