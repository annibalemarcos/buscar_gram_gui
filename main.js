const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');

let mainWindow = null;
let ptyProcess = null;

// ---------- Resolve binary / script path ----------
// In production builds the PyInstaller bundle (or fallback .py) lives in
// process.resourcesPath. In dev it sits next to main.js.
const IS_PACKAGED = app.isPackaged;
const RES_DIR = IS_PACKAGED ? process.resourcesPath : __dirname;

const BIN_NAME = process.platform === 'win32' ? 'buscar_gram.exe' : 'buscar_gram';
const BUNDLED_BIN = path.join(RES_DIR, BIN_NAME);
const SCRIPT_PATH = path.join(RES_DIR, 'buscar_gram.py');

// True if a standalone PyInstaller binary is shipped with the app.
const HAS_BUNDLED_BIN = fs.existsSync(BUNDLED_BIN);

// Default config dir (persists API_ID/API_HASH/.session)
const USER_DATA_DIR = path.join(app.getPath('userData'));
const ENV_FILE = path.join(USER_DATA_DIR, '.env');
const SESSION_NAME = path.join(USER_DATA_DIR, 'buscar_gram_session');
// Default output base dir = where the app is run from
const DEFAULT_OUTPUT_BASE = path.join(process.cwd(), 'buscs');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#07090d',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile('index.html');
  mainWindow.on('closed', () => {
    mainWindow = null;
    killPty();
  });
}

app.whenReady().then(() => {
  if (!fs.existsSync(USER_DATA_DIR)) fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  killPty();
  if (process.platform !== 'darwin') app.quit();
});

// ---------- helpers ----------
function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return { API_ID: '', API_HASH: '' };
  const txt = fs.readFileSync(ENV_FILE, 'utf-8');
  const out = { API_ID: '', API_HASH: '' };
  txt.split(/\r?\n/).forEach((line) => {
    const m = line.match(/^([A-Z_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  });
  return out;
}

function saveEnv(apiId, apiHash) {
  const content = `API_ID=${apiId}\nAPI_HASH=${apiHash}\n`;
  fs.writeFileSync(ENV_FILE, content, 'utf-8');
}

function sanitizeName(q) {
  return q
    .replace(/[^a-zA-Z0-9_\-\u00C0-\u017F ]+/g, '_')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 80) || 'busca';
}

function resolveOutputPath(query, format, customPath) {
  const ext = format.startsWith('.') ? format : `.${format}`;
  if (customPath && customPath.trim() !== '') {
    const p = customPath.trim();
    // If user passed a directory, append default filename
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        return path.join(p, `${sanitizeName(query)}${ext}`);
      }
    } catch (_) {}
    // If file with extension provided, use as-is
    if (path.extname(p)) return p;
    // Otherwise treat as filename without ext
    return `${p}${ext}`;
  }
  // Default to buscs/<query>.<ext>
  if (!fs.existsSync(DEFAULT_OUTPUT_BASE)) {
    fs.mkdirSync(DEFAULT_OUTPUT_BASE, { recursive: true });
  }
  return path.join(DEFAULT_OUTPUT_BASE, `${sanitizeName(query)}${ext}`);
}

function killPty() {
  if (ptyProcess) {
    try { ptyProcess.kill(); } catch (_) {}
    ptyProcess = null;
  }
}

// ---------- IPC ----------
ipcMain.handle('config:get', () => {
  return {
    ...loadEnv(),
    userDataDir: USER_DATA_DIR,
    defaultOutputBase: DEFAULT_OUTPUT_BASE,
    sessionName: SESSION_NAME,
    scriptPath: HAS_BUNDLED_BIN ? BUNDLED_BIN : SCRIPT_PATH,
    scriptExists: HAS_BUNDLED_BIN || fs.existsSync(SCRIPT_PATH),
    standalone: HAS_BUNDLED_BIN,
  };
});

ipcMain.handle('config:save', (_e, { apiId, apiHash }) => {
  saveEnv(apiId, apiHash);
  return { ok: true };
});

ipcMain.handle('dialog:pickFile', async (_e, { defaultName, format }) => {
  const ext = (format || 'txt').replace(/^\./, '');
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Escolher arquivo de saída',
    defaultPath: defaultName ? `${sanitizeName(defaultName)}.${ext}` : `busca.${ext}`,
    filters: [
      { name: 'Texto', extensions: ['txt'] },
      { name: 'JSON', extensions: ['json'] },
      { name: 'Markdown', extensions: ['md'] },
      { name: 'CSV', extensions: ['csv'] },
      { name: 'Todos', extensions: ['*'] },
    ],
  });
  if (result.canceled) return { canceled: true };
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle('dialog:pickFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Escolher pasta de saída',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled) return { canceled: true };
  return { canceled: false, folderPath: result.filePaths[0] };
});

ipcMain.handle('output:reveal', (_e, p) => {
  if (p && fs.existsSync(p)) {
    shell.showItemInFolder(p);
    return { ok: true };
  }
  return { ok: false };
});

ipcMain.handle('output:resolve', (_e, { query, format, customPath }) => {
  return resolveOutputPath(query, format, customPath);
});

ipcMain.handle('search:start', (_e, payload) => {
  const { query, limit, scope, includeDms, format, customPath } = payload;

  if (!query || !query.trim()) {
    return { ok: false, error: 'Informe a busca.' };
  }

  const env = loadEnv();
  if (!env.API_ID || !env.API_HASH) {
    return { ok: false, error: 'Configure API_ID e API_HASH primeiro.' };
  }

  const outputPath = resolveOutputPath(query, format || 'txt', customPath);
  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  killPty();

  // Prefer the bundled PyInstaller binary; fall back to system python.
  let execBin;
  let args = [];

  if (HAS_BUNDLED_BIN) {
    execBin = BUNDLED_BIN;
  } else {
    execBin = process.env.PYTHON ||
              (process.platform === 'win32' ? 'python' : 'python3');
    args.push(SCRIPT_PATH);
  }

  args.push(
    '--query', query,
    '--limit', String(limit || 500),
    '--only', scope || 'groups',
    '--export', outputPath,
    '--session', SESSION_NAME,
  );
  if (includeDms) args.push('--dms');

  const cols = 140;
  const rows = 40;

  try {
    ptyProcess = pty.spawn(execBin, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: path.dirname(execBin),
      env: {
        ...process.env,
        API_ID: env.API_ID,
        API_HASH: env.API_HASH,
        PYTHONUNBUFFERED: '1',
        FORCE_COLOR: '1',
      },
    });
  } catch (err) {
    return {
      ok: false,
      error: HAS_BUNDLED_BIN
        ? `Falha ao iniciar o binário (${execBin}): ${err.message}`
        : `Falha ao iniciar Python (${execBin}): ${err.message}. Instale Python 3.9+ ou reempacote com PyInstaller.`,
    };
  }

  ptyProcess.onData((data) => {
    if (mainWindow) mainWindow.webContents.send('pty:data', data);
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    if (mainWindow) {
      mainWindow.webContents.send('pty:exit', {
        exitCode,
        signal,
        outputPath,
        outputExists: fs.existsSync(outputPath),
      });
    }
    ptyProcess = null;
  });

  return { ok: true, outputPath, pythonBin: execBin, standalone: HAS_BUNDLED_BIN };
});

ipcMain.handle('search:stop', () => {
  killPty();
  return { ok: true };
});

ipcMain.handle('pty:input', (_e, data) => {
  if (ptyProcess) {
    ptyProcess.write(data);
    return { ok: true };
  }
  return { ok: false };
});

ipcMain.handle('pty:resize', (_e, { cols, rows }) => {
  if (ptyProcess) {
    try { ptyProcess.resize(cols, rows); } catch (_) {}
    return { ok: true };
  }
  return { ok: false };
});
