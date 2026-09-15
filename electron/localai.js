// ===========================================================================
// LOCAL AI RUNTIME DETECTION
//
// THE REFRAME THAT MAKES THIS SMALL. "Support more open-source models" sounds
// like per-model work, but a model is just weights - Llama, Qwen, Mistral,
// DeepSeek, Gemma and Phi speak no protocol at all. The RUNTIME serving them
// does. So this is per-runtime work, and there are only about six that matter.
//
// AND THE OPENAI HTTP SHAPE HAS WON. Every runtime below exposes
// POST /v1/chat/completions and GET /v1/models. Harbor's chat path ALREADY
// called /v1/chat/completions, so the inference half needed no change at all -
// only the hardcoded host:port and the Ollama-native /api/tags model list.
//
// /v1/models IS THE UNLOCK. It is the OpenAI-standard model list and Ollama
// implements it too, so replacing /api/tags with it makes detection
// provider-agnostic in one change rather than adding a branch per runtime.
//
// WHAT STAYS OLLAMA-ONLY, AND WHY THAT IS HONEST. Harbor can `spawn('ollama
// serve')` and `ollama pull`. It cannot meaningfully launch LM Studio, which is
// a desktop GUI app. So management is Ollama-only and every provider carries an
// explicit `canManage` flag - the UI must say "found, not managed" rather than
// offering a Start button that cannot work.
// ===========================================================================
const http = require('http');

// Ports are the documented defaults for each runtime. Ollama is FIRST on purpose:
// when several are up, prefer the one Harbor can actually start and stop.
const PROVIDERS = [
  { id: 'ollama',     label: 'Ollama',          port: 11434, canManage: true },
  { id: 'lmstudio',   label: 'LM Studio',       port: 1234,  canManage: false },
  { id: 'jan',        label: 'Jan',             port: 1337,  canManage: false },
  { id: 'llamacpp',   label: 'llama.cpp',       port: 8080,  canManage: false },
  { id: 'vllm',       label: 'vLLM',            port: 8000,  canManage: false },
  { id: 'textgenwebui', label: 'text-gen-webui', port: 5000, canManage: false },
];

// A short cache, because checkOllama() is called by the tray menu, the dock
// refresh and the status IPC. Probing six ports on every one of those would be
// rude to the machine and would slow the menu open.
const CACHE_MS = 5000;
let cache = { at: 0, result: null };

function getJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET',
        headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
          } else {
            reject(new Error('HTTP ' + res.statusCode));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// Both shapes are read, because /v1/models is the standard but an older Ollama
// only answers /api/tags. Trying the standard FIRST means the portable path is
// the normal path and the native one is the exception.
function modelNamesFrom(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.data)) {                       // OpenAI /v1/models
    return payload.data.map((m) => m && (m.id || m.name)).filter(Boolean);
  }
  if (Array.isArray(payload.models)) {                     // Ollama /api/tags
    return payload.models.map((m) => m && (m.name || m.model)).filter(Boolean);
  }
  return [];
}

async function probe(provider, timeoutMs) {
  const base = `http://localhost:${provider.port}`;
  try {
    const models = modelNamesFrom(await getJson(base + '/v1/models', timeoutMs));
    return { ...provider, running: true, models, baseUrl: base, via: '/v1/models' };
  } catch (e) { /* fall through to the native list */ }
  try {
    const models = modelNamesFrom(await getJson(base + '/api/tags', timeoutMs));
    return { ...provider, running: true, models, baseUrl: base, via: '/api/tags' };
  } catch (e) {
    return null;
  }
}

/**
 * Probe every known runtime in PARALLEL and return what is actually there.
 * Parallel matters: six sequential 1.5s timeouts on a machine with nothing
 * running would be a nine-second tray menu.
 */
async function detect({ timeoutMs = 1500, force = false } = {}) {
  if (!force && cache.result && Date.now() - cache.at < CACHE_MS) return cache.result;
  const found = (await Promise.all(PROVIDERS.map((p) => probe(p, timeoutMs)))).filter(Boolean);
  // Preference order is PROVIDERS order, so a manageable runtime wins a tie.
  const active = found.find((f) => f.models.length > 0) || found[0] || null;
  const result = {
    running: !!active,
    provider: active ? active.id : null,
    label: active ? active.label : null,
    baseUrl: active ? active.baseUrl : `http://localhost:${PROVIDERS[0].port}`,
    port: active ? active.port : PROVIDERS[0].port,
    canManage: active ? active.canManage : true,
    models: active ? active.models : [],
    // Every runtime that answered, so the UI can say "LM Studio and Ollama are
    // both up" instead of silently picking one and looking wrong.
    all: found.map((f) => ({ id: f.id, label: f.label, port: f.port, models: f.models.length, canManage: f.canManage })),
  };
  cache = { at: Date.now(), result };
  return result;
}

function invalidate() { cache = { at: 0, result: null }; }

/**
 * THE PORT AS ONE DERIVED FACT. Before this, 11434 was written literally in
 * ollama.js twice, in tunnel.js's spawn arguments, and in the endpoint that
 * ipc-handlers reports to Wave OS. Four copies of one fact: a user running LM
 * Studio would have had Harbor tunnel port 11434 - nothing - so storyPipeline's
 * LOCAL_LLM_URL tier would point at a dead port and fail in a way that looks
 * like the model being slow. Exactly the duplicated-declaration family that
 * dropped a settings field five times and shared_folders.name once.
 */
async function activePort() {
  const d = await detect();
  return d.port;
}

module.exports = { PROVIDERS, detect, invalidate, activePort, modelNamesFrom };
