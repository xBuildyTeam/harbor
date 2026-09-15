const { spawn, exec } = require('child_process');
const http = require('http');
const localai = require('./localai');

let ollamaProcess = null;

// Helper to make HTTP request with timeout
function fetchJson(url, options = {}, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve(data);
          }
        } else {
          reject(new Error(`HTTP error! Status: ${res.statusCode}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });

    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

/**
 * Check if Ollama is running and get installed models
 */
async function checkOllama() {
  // NAME KEPT, MEANING WIDENED. The IPC channel is 'ollama:check' and the tray,
  // the dock and Wave OS all call it, so renaming would break three consumers to
  // no benefit. It now reports whichever OpenAI-compatible runtime is actually
  // present, and carries `provider` / `canManage` so a caller can tell Ollama
  // (startable) from LM Studio (found, not startable) instead of assuming.
  try {
    const d = await localai.detect();
    return {
      running: d.running,
      models: d.models,
      provider: d.provider,
      label: d.label,
      baseUrl: d.baseUrl,
      port: d.port,
      canManage: d.canManage,
      all: d.all,
    };
  } catch (error) {
    return { running: false, models: [], provider: null, canManage: true };
  }
}

/**
 * Start Ollama process
 */
function startOllama() {
  return new Promise((resolve, reject) => {
    // First, check if already running
    checkOllama().then(status => {
      if (status.running) {
        resolve({ success: true, message: 'Ollama is already running' });
        return;
      }

      // Spawn 'ollama serve'
      try {
        ollamaProcess = spawn('ollama', ['serve'], {
          shell: true,
          detached: true,
          stdio: 'ignore'
        });
        
        ollamaProcess.unref();

        // Wait a bit and check if it started
        let attempts = 0;
        const interval = setInterval(async () => {
          attempts++;
          const check = await checkOllama();
          if (check.running) {
            clearInterval(interval);
            resolve({ success: true, message: 'Ollama started successfully' });
          } else if (attempts >= 5) {
            clearInterval(interval);
            reject(new Error('Failed to start Ollama: Service did not respond in time'));
          }
        }, 1000);
      } catch (err) {
        reject(new Error(`Failed to spawn Ollama process: ${err.message}`));
      }
    });
  });
}

/**
 * Stop Ollama process
 */
function stopOllama() {
  return new Promise((resolve) => {
    // If we have a process handle, kill it
    if (ollamaProcess) {
      try {
        process.kill(-ollamaProcess.pid); // Kill process group
      } catch (e) {
        try {
          ollamaProcess.kill();
        } catch (e2) {}
      }
      ollamaProcess = null;
    }

    // Additionally, on Windows, terminate all ollama.exe tasks for absolute robustness
    if (process.platform === 'win32') {
      exec('taskkill /f /im ollama.exe', (err) => {
        resolve({ success: true, message: 'Ollama stopped' });
      });
    } else {
      exec('killall ollama', (err) => {
        resolve({ success: true, message: 'Ollama stopped' });
      });
    }
  });
}

/**
 * Pull Ollama model
 * Uses native pull progress or spawns pulling subprocess.
 * Let's spawn and wait for completions.
 */
function pullModel(name) {
  return new Promise((resolve, reject) => {
    const pullProcess = spawn('ollama', ['pull', name], { shell: true });
    
    let errorOutput = '';
    pullProcess.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    pullProcess.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, message: `Model ${name} pulled successfully` });
      } else {
        reject(new Error(`Failed to pull model ${name}: ${errorOutput || 'Exit code ' + code}`));
      }
    });

    pullProcess.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Send chat completions query
 */
async function chat(model, messages, options = {}) {
  const { aiMode = 'auto' } = options;
  
  // Theta-only mode
  // Theta-only and Theta-fallback branches removed in v3.0.3. Cloud inference is
  // Wave OS's job - it owns Theta key management and model routing already.
  if (aiMode === 'theta') {
    return {
      error: true,
      provider: 'none',
      content: 'Harbor runs local models only. Use the Wave Assistant in Wave OS for Theta models.'
    };
  }
  
  // Local-only mode or auto mode (try Ollama first)
  if (aiMode === 'local' || aiMode === 'auto') {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      // Base URL from detection, not a literal. Harbor already spoke the OpenAI
      // shape here, so pointing it at whichever runtime is up is the whole change.
      const detected = await localai.detect();
      const response = await fetch(`${detected.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: false, temperature: 0.7 }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content || '';
      if (!content) throw new Error(`${detected.label || 'Local runtime'} returned an empty response`);
      console.log(`[ollama.js] Response from ${detected.label || 'local runtime'}`);
      return { content, provider: detected.provider || 'local' };
    } catch (e) {
      console.log(`[ollama.js] local runtime failed: ${e.message}`);
      if (aiMode === 'local') throw e; // No fallback in local-only mode
      // Fall through to Theta fallback in auto mode
    }
  }
  
  // Theta fallback (auto mode)
  
  throw new Error('No AI provider available');
}

module.exports = {
  detectLocalAi: localai.detect,
  invalidateLocalAi: localai.invalidate,
  checkOllama,
  startOllama,
  stopOllama,
  pullModel,
  chat
};
