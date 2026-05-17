/**
 * CloudGate Recovery UI.
 *
 * Tiny standalone Express server. Bound to the same port (80) as the main UI
 * but only started by s6 if the main backend fails to come up.
 *
 * Zero dependencies on the main app's modules — by design, this must work even
 * when the backend cannot import its own files.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { copyFile, readFile, unlink } from 'node:fs/promises';
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

// --- Status ---------------------------------------------------------------

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

// --- Logs -----------------------------------------------------------------

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

// --- DB backups: list + restore ------------------------------------------

interface BackupEntry {
	name: string;
	size: number;
	mtime: string;
	type: 'pre-update' | 'manual';
}

app.get('/api/backups', (_req, res) => {
	const dir = join(DATA_DIR, 'db', 'backups');
	const entries: BackupEntry[] = [];
	if (existsSync(dir)) {
		for (const name of readdirSync(dir)) {
			if (!name.endsWith('.sqlite')) continue;
			try {
				const stat = statSync(join(dir, name));
				entries.push({
					name,
					size: stat.size,
					mtime: stat.mtime.toISOString(),
					type: name.startsWith('pre-update-') ? 'pre-update' : 'manual',
				});
			} catch {
				/* ignore stat failure */
			}
		}
	}
	// Newest first
	entries.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
	res.json({ backups: entries });
});

app.post('/api/restore-db', async (req, res) => {
	const body = req.body as { name?: string; confirm?: string };
	if (!body?.name) {
		res.status(400).json({ error: 'Missing "name"' });
		return;
	}
	if (body.confirm !== 'I-UNDERSTAND') {
		res.status(400).json({ error: 'Confirmation phrase missing or wrong (must be "I-UNDERSTAND")' });
		return;
	}
	const safe = body.name.replace(/[^a-zA-Z0-9._-]/g, '');
	const src = join(DATA_DIR, 'db', 'backups', safe);
	const dst = join(DATA_DIR, 'db', 'db.sqlite');
	if (!existsSync(src)) {
		res.status(404).json({ error: 'Backup not found' });
		return;
	}
	try {
		await copyFile(src, dst);
		// Remove WAL/SHM files — they'll be regenerated against the restored DB
		for (const aux of ['db.sqlite-wal', 'db.sqlite-shm']) {
			const path = join(DATA_DIR, 'db', aux);
			if (existsSync(path)) await unlink(path).catch(() => null);
		}
		res.json({ ok: true, restored: safe, message: 'DB restored. Restart the container.' });
	} catch (err) {
		res.status(500).json({ error: (err as Error).message });
	}
});

// --- Soft reset: clear bootstrap markers, keep data ----------------------

app.post('/api/soft-reset', async (req, res) => {
	const body = req.body as { confirm?: string };
	if (body.confirm !== 'I-UNDERSTAND') {
		res.status(400).json({ error: 'Confirmation phrase missing or wrong' });
		return;
	}
	for (const marker of ['.bootstrap-complete', '.bootstrap-error', '.bootstrap-outcome']) {
		const path = join(DATA_DIR, marker);
		if (existsSync(path)) {
			try {
				await unlink(path);
			} catch {
				/* ignore */
			}
		}
	}
	res.json({ ok: true, message: 'Bootstrap markers cleared. Restart the container to re-bootstrap.' });
});

// --- Hard reset: move /data to /data.broken.<ts> -------------------------

app.post('/api/hard-reset', (req, res) => {
	const body = req.body as { confirm?: string };
	// Stricter confirmation phrase to make accidents harder.
	if (body.confirm !== 'YES-I-WANT-TO-LOSE-ALL-DATA') {
		res.status(400).json({
			error: 'Confirmation phrase missing or wrong. Must literally be "YES-I-WANT-TO-LOSE-ALL-DATA".',
		});
		return;
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const archiveDir = `${DATA_DIR}.broken.${stamp}`;
	try {
		mkdirSync(archiveDir, { recursive: true });
		for (const name of readdirSync(DATA_DIR)) {
			renameSync(join(DATA_DIR, name), join(archiveDir, name));
		}
		res.json({
			ok: true,
			archived: archiveDir,
			message: `Old /data moved to ${archiveDir}. Restart the container — it will bootstrap fresh.`,
		});
	} catch (err) {
		res.status(500).json({ error: (err as Error).message });
	}
});

// --- listen ---------------------------------------------------------------

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

// Touch unused import — keep available for future endpoints
void rmSync;

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
  .wrap { max-width: 760px; margin: 0 auto; padding: 32px 20px; }
  h1 { font-size: 28px; margin: 0 0 8px; color: #ff9966; }
  h2 { font-size: 18px; margin: 24px 0 8px; }
  .badge { display: inline-block; background: #ff9966; color: #111; padding: 2px 10px;
           border-radius: 4px; font-weight: 600; font-size: 12px; text-transform: uppercase; }
  .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px;
          padding: 16px; margin: 16px 0; }
  .danger { border-color: #5a2020; }
  pre { background: #0a0a0a; padding: 12px; border-radius: 4px;
        overflow-x: auto; font-size: 13px; max-height: 320px; }
  button { background: #ff9966; color: #111; border: 0; padding: 8px 14px;
           border-radius: 4px; cursor: pointer; font-weight: 600; font-size: 13px;
           margin: 4px 8px 4px 0; }
  button.secondary { background: #2a2a2a; color: #e0e0e0; }
  button.danger { background: #5a2020; color: #ffaaaa; }
  button:hover { opacity: 0.85; }
  a { color: #ff9966; }
  .muted { color: #888; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 6px 8px; border-bottom: 1px solid #2a2a2a; text-align: left; }
  .ok { color: #66cc88; }
  .err { color: #ff8888; }
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
      <h2>Database backups</h2>
      <p class="muted">Restoring will overwrite the current DB. After restore, restart the container.</p>
      <div id="backups">loading…</div>
    </div>

    <div class="card danger">
      <h2>Reset options</h2>
      <p class="muted">In order of severity. All require typing a confirmation phrase.</p>

      <p>
        <strong>Soft reset</strong> — clear bootstrap markers, then restart.
        Keeps all your data + secrets. Re-runs migrations.
      </p>
      <button class="secondary" onclick="doSoftReset()">Soft reset…</button>

      <p style="margin-top: 16px;">
        <strong>Hard reset</strong> — move <code>/data</code> aside to
        <code>/data.broken.&lt;ts&gt;</code>. Next start: completely fresh.
        Old data is preserved on the volume (you can copy it out later).
      </p>
      <button class="danger" onclick="doHardReset()">Hard reset…</button>
    </div>

    <div class="card">
      <h2>What now?</h2>
      <ul>
        <li>Most failures are fixed by a clean container restart: <code>docker restart cloudgate</code>.</li>
        <li>If you see a bootstrap error above, the soft reset is usually enough.</li>
        <li>Hard reset is the last resort — keep an off-host backup before doing it.</li>
        <li>Share the logs above when filing an issue.</li>
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

function loadBackups() {
  fetch('/api/backups').then(r => r.json()).then(j => {
    const el = document.getElementById('backups');
    if (!j.backups.length) {
      el.innerHTML = '<p class="muted">No backups found in /data/db/backups/</p>';
      return;
    }
    let html = '<table><tr><th>Name</th><th>Size</th><th>When</th><th>Type</th><th></th></tr>';
    for (const b of j.backups) {
      const kb = (b.size / 1024).toFixed(0);
      html += '<tr><td><code>' + b.name + '</code></td><td>' + kb + ' KB</td><td>' + b.mtime.slice(0, 19) +
              '</td><td>' + b.type + '</td><td><button onclick="restoreDb(\\''+ b.name +'\\')">Restore</button></td></tr>';
    }
    html += '</table>';
    el.innerHTML = html;
  }).catch(e => { document.getElementById('backups').textContent = 'Error: ' + e.message; });
}
loadBackups();

function restoreDb(name) {
  const phrase = prompt('This will OVERWRITE the current database with ' + name +
    '.\\nType exactly:  I-UNDERSTAND  to proceed.');
  if (phrase !== 'I-UNDERSTAND') return;
  fetch('/api/restore-db', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, confirm: phrase })
  }).then(r => r.json()).then(j => {
    if (j.ok) {
      alert('Restored: ' + j.restored + '\\n\\nNow run: docker restart cloudgate');
    } else {
      alert('Restore failed: ' + (j.error || 'unknown'));
    }
  }).catch(e => alert('Error: ' + e.message));
}

function doSoftReset() {
  const phrase = prompt('Soft reset will clear bootstrap markers (your data is kept).\\nType exactly:  I-UNDERSTAND');
  if (phrase !== 'I-UNDERSTAND') return;
  fetch('/api/soft-reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: phrase })
  }).then(r => r.json()).then(j => {
    alert(j.ok ? (j.message + '\\nRun: docker restart cloudgate') : (j.error || 'failed'));
  }).catch(e => alert('Error: ' + e.message));
}

function doHardReset() {
  const phrase = prompt('HARD reset moves /data aside — fresh start.\\n' +
    'Type EXACTLY:  YES-I-WANT-TO-LOSE-ALL-DATA');
  if (phrase !== 'YES-I-WANT-TO-LOSE-ALL-DATA') return;
  fetch('/api/hard-reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: phrase })
  }).then(r => r.json()).then(j => {
    alert(j.ok ? (j.message + '\\nRun: docker restart cloudgate') : (j.error || 'failed'));
  }).catch(e => alert('Error: ' + e.message));
}
</script>
</body>
</html>`;
}
