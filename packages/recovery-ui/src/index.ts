/**
 * CloudGate Recovery UI.
 *
 * Tiny standalone Express server. Bound to the same port (80) as the main UI
 * but only started by s6 if the main backend fails to come up.
 *
 * Zero dependencies on the main app's modules — by design, this must work even
 * when the backend cannot import its own files.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';

const PORT = Number.parseInt(process.env.RECOVERY_PORT ?? '80', 10);
const DATA_DIR = process.env.CLOUDGATE_DATA_DIR ?? '/data';

const app = express();
app.disable('x-powered-by');
app.use(express.json());

app.get('/', (_req, res) => {
	res.setHeader('Content-Type', 'text/html; charset=utf-8');
	res.send(renderPage());
});

app.get('/api/status', async (_req, res) => {
	const bootstrapError = await readJsonIfExists(join(DATA_DIR, '.bootstrap-error'));
	const bootstrapComplete = await readJsonIfExists(join(DATA_DIR, '.bootstrap-complete'));
	const versionFile = await readTextIfExists(join(DATA_DIR, '.version'));
	res.json({
		mode: 'recovery',
		data_dir: DATA_DIR,
		data_dir_exists: existsSync(DATA_DIR),
		bootstrap_complete: bootstrapComplete,
		bootstrap_error: bootstrapError,
		last_known_version: versionFile,
	});
});

app.get('/api/logs/:file', async (req, res) => {
	const allowed = new Set(['cloudgate.log', 'cloudflared.log', 'update-history.log']);
	if (!allowed.has(req.params.file)) {
		res.status(403).json({ error: 'Forbidden' });
		return;
	}
	const path = join(DATA_DIR, 'logs', req.params.file);
	if (!existsSync(path)) {
		res.status(404).json({ error: 'Not found' });
		return;
	}
	try {
		const content = await readFile(path, 'utf8');
		res.setHeader('Content-Type', 'text/plain; charset=utf-8');
		res.send(content.slice(-200_000)); // last ~200KB
	} catch (err) {
		res.status(500).json({ error: (err as Error).message });
	}
});

app.listen(PORT, () => {
	console.log(`[recovery-ui] Listening on port ${PORT}, DATA_DIR=${DATA_DIR}`);
});

// ---------------------------------------------------------------------------

async function readJsonIfExists(path: string): Promise<unknown | null> {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(await readFile(path, 'utf8'));
	} catch {
		return null;
	}
}

async function readTextIfExists(path: string): Promise<string | null> {
	if (!existsSync(path)) return null;
	try {
		return (await readFile(path, 'utf8')).trim();
	} catch {
		return null;
	}
}

function renderPage(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CloudGate Recovery</title>
<style>
  * { box-sizing: border-box; }
  body {
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    margin: 0; padding: 0; background: #111; color: #e0e0e0;
  }
  .wrap { max-width: 720px; margin: 0 auto; padding: 32px 20px; }
  h1 { font-size: 28px; margin: 0 0 8px; color: #ff9966; }
  h2 { font-size: 18px; margin: 24px 0 8px; }
  .badge { display: inline-block; background: #ff9966; color: #111; padding: 2px 10px;
           border-radius: 4px; font-weight: 600; font-size: 12px; text-transform: uppercase; }
  .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px;
          padding: 16px; margin: 16px 0; }
  pre { background: #0a0a0a; padding: 12px; border-radius: 4px;
        overflow-x: auto; font-size: 13px; }
  button { background: #ff9966; color: #111; border: 0; padding: 10px 16px;
           border-radius: 4px; cursor: pointer; font-weight: 600; font-size: 14px;
           margin-right: 8px; }
  button.secondary { background: #2a2a2a; color: #e0e0e0; }
  button:hover { opacity: 0.85; }
  a { color: #ff9966; }
  .muted { color: #888; }
</style>
</head>
<body>
  <div class="wrap">
    <span class="badge">Recovery Mode</span>
    <h1>CloudGate could not start normally</h1>
    <p class="muted">The main backend service failed to come up. Your data in <code>/data</code> is untouched.</p>

    <div class="card">
      <h2>Status</h2>
      <pre id="status">loading…</pre>
    </div>

    <div class="card">
      <h2>Logs</h2>
      <p>
        <button onclick="loadLog('cloudgate.log')">cloudgate.log</button>
        <button onclick="loadLog('cloudflared.log')">cloudflared.log</button>
        <button onclick="loadLog('update-history.log')">update-history.log</button>
      </p>
      <pre id="log" class="muted">Pick a log above…</pre>
    </div>

    <div class="card">
      <h2>What now?</h2>
      <ul>
        <li>Most failures are fixed by a clean container restart: <code>docker restart cloudgate</code>.</li>
        <li>If that doesn't help, share the logs above when reporting an issue.</li>
        <li>Detailed Anti-Brick recovery actions (snapshot restore, hard reset, downgrade) ship in M4.</li>
      </ul>
    </div>

    <p class="muted" style="margin-top: 32px;">
      CloudGate Recovery UI · <a href="https://github.com/Elias02345/CloudGate">github.com/Elias02345/CloudGate</a>
    </p>
  </div>

<script>
fetch('/api/status').then(r => r.json()).then(s => {
  document.getElementById('status').textContent = JSON.stringify(s, null, 2);
}).catch(e => {
  document.getElementById('status').textContent = 'Could not fetch status: ' + e.message;
});

function loadLog(name) {
  const el = document.getElementById('log');
  el.textContent = 'loading ' + name + '…';
  fetch('/api/logs/' + name).then(r => {
    if (!r.ok) return r.json().then(j => Promise.reject(new Error(j.error)));
    return r.text();
  }).then(text => {
    el.textContent = text || '(empty)';
  }).catch(e => {
    el.textContent = 'Error: ' + e.message;
  });
}
</script>
</body>
</html>`;
}
