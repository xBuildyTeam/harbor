const { chatWithTheta } = require('./theta');
const { spawn, exec } = require('child_process');
const http = require('http');

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
  try {
    const data = await fetchJson('http://localhost:11434/api/tags', {}, 2000);
    const models = (data.models || []).map(m => m.name);
    return { running: true, models };
  } catch (error) {
    return { running: false, models: [] };
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
  const { aiMode = 'auto', thetaToken } = options;
  
  // Theta-only mode
  if (aiMode === 'theta' && thetaToken) {
    console.log('[ollama.js] Theta-only mode, calling Theta EdgeCloud');
    const result = await chatWithTheta(messages, thetaToken);
    return result;
  }
  
  // Local-only mode or auto mode (try Ollama first)
  if (aiMode === 'local' || aiMode === 'auto') {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const response = await fetch('http://localhost:11434/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: false, temperature: 0.7 }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content || '';
      if (!content) throw new Error('Ollama returned empty response');
      console.log('[ollama.js] Response from Ollama');
      return { content, provider: 'ollama' };
    } catch (e) {
      console.log(`[ollama.js] Ollama failed: ${e.message}`);
      if (aiMode === 'local') throw e; // No fallback in local-only mode
      // Fall through to Theta fallback in auto mode
    }
  }
  
  // Theta fallback (auto mode)
  if (aiMode === 'auto' && thetaToken) {
    console.log('[ollama.js] Falling back to Theta EdgeCloud');
    const result = await chatWithTheta(messages, thetaToken);
    return result;
  }
  
  throw new Error('No AI provider available');
}

module.exports = {
  checkOllama,
  startOllama,
  stopOllama,
  pullModel,
  chat
};
