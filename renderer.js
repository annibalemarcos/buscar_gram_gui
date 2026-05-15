/* renderer.js — UI logic for buscar_gram GUI */
/* eslint-disable no-undef */

const $ = (sel) => document.querySelector(sel);

const els = {
  apiId: $('#apiId'),
  apiHash: $('#apiHash'),
  saveCfgBtn: $('#saveCfgBtn'),
  cfgStatus: $('#cfg-status'),

  query: $('#query'),
  limit: $('#limit'),
  scope: $('#scope'),
  includeDms: $('#includeDms'),

  segBtns: document.querySelectorAll('.seg-btn'),
  outputPath: $('#outputPath'),
  pickFileBtn: $('#pickFileBtn'),
  pickFolderBtn: $('#pickFolderBtn'),
  resolvedPath: $('#resolvedPath'),

  startBtn: $('#startBtn'),
  stopBtn: $('#stopBtn'),

  statusPill: $('#statusPill'),
  statusText: $('#statusText'),
  outChip: $('#outChip'),
  revealBtn: $('#revealBtn'),
  scriptStatus: $('#scriptStatus'),

  ptyInput: $('#ptyInput'),
  sendBtn: $('#sendBtn'),

  terminalEl: $('#terminal'),

  termSearch: $('#termSearch'),
  regexToggle: $('#regexToggle'),
  caseToggle: $('#caseToggle'),
  searchPrevBtn: $('#searchPrevBtn'),
  searchNextBtn: $('#searchNextBtn'),
  searchClearBtn: $('#searchClearBtn'),
  searchCounter: $('#searchCounter'),
};

let currentFormat = 'txt';
let lastOutputPath = null;
let term = null;
let fitAddon = null;
let searchAddon = null;
let regexMode = false;
let caseMode = false;

/* --------- terminal init --------- */
function initTerminal() {
  // eslint-disable-next-line no-undef
  term = new Terminal({
    fontFamily: 'JetBrains Mono, IBM Plex Mono, Fira Code, ui-monospace, monospace',
    fontSize: 12,
    lineHeight: 1.15,
    cursorBlink: true,
    convertEol: true,
    scrollback: 5000,
    theme: {
      background: '#050709',
      foreground: '#d6e1ee',
      cursor: '#5fffff',
      selectionBackground: '#1f2a3c',
      black: '#0d1118',
      red: '#ff6464',
      green: '#5dff8a',
      yellow: '#ffb454',
      blue: '#82aaff',
      magenta: '#c792ea',
      cyan: '#5fffff',
      white: '#d6e1ee',
      brightBlack: '#5b6a82',
      brightRed: '#ff8a8a',
      brightGreen: '#9fffb8',
      brightYellow: '#ffd49b',
      brightBlue: '#a8c3ff',
      brightMagenta: '#dcb6f5',
      brightCyan: '#a0ffff',
      brightWhite: '#ffffff',
    },
  });
  // eslint-disable-next-line no-undef
  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  // eslint-disable-next-line no-undef
  searchAddon = new SearchAddon.SearchAddon();
  term.loadAddon(searchAddon);
  term.open(els.terminalEl);
  setTimeout(() => fitTerm(), 80);

  // forward keystrokes to pty
  term.onData((data) => {
    window.api.sendInput(data);
  });

  window.addEventListener('resize', () => fitTerm());
}

function fitTerm() {
  if (!fitAddon) return;
  try {
    fitAddon.fit();
    window.api.resize(term.cols, term.rows);
  } catch (_) { /* ignore */ }
}

/* --------- config --------- */
async function loadConfig() {
  const cfg = await window.api.getConfig();
  if (cfg.API_ID) els.apiId.value = cfg.API_ID;
  if (cfg.API_HASH) els.apiHash.value = cfg.API_HASH;
  if (cfg.API_ID && cfg.API_HASH) {
    els.cfgStatus.textContent = 'configurado';
    els.cfgStatus.classList.add('ok');
  }
  els.scriptStatus.textContent = cfg.scriptExists ? 'OK' : 'AUSENTE';
  els.scriptStatus.style.color = cfg.scriptExists ? 'var(--neon)' : 'var(--red)';
}

els.saveCfgBtn.addEventListener('click', async () => {
  const apiId = els.apiId.value.trim();
  const apiHash = els.apiHash.value.trim();
  if (!apiId || !apiHash) {
    setStatus('error', 'API_ID e API_HASH são obrigatórios');
    return;
  }
  if (!/^\d+$/.test(apiId)) {
    setStatus('error', 'API_ID precisa ser numérico');
    return;
  }
  await window.api.saveConfig(apiId, apiHash);
  els.cfgStatus.textContent = 'configurado';
  els.cfgStatus.classList.add('ok');
  setStatus('idle', 'credenciais salvas');
});

/* --------- format segment --------- */
els.segBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    els.segBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentFormat = btn.dataset.fmt;
    refreshResolved();
  });
});

/* --------- output paths --------- */
async function refreshResolved() {
  const q = els.query.value.trim() || 'busca';
  const p = await window.api.resolveOutput(q, currentFormat, els.outputPath.value);
  els.resolvedPath.textContent = p;
}
els.query.addEventListener('input', refreshResolved);
els.outputPath.addEventListener('input', refreshResolved);

els.pickFileBtn.addEventListener('click', async () => {
  const r = await window.api.pickFile(els.query.value, currentFormat);
  if (!r.canceled) {
    els.outputPath.value = r.filePath;
    // sync format with extension
    const ext = (r.filePath.split('.').pop() || '').toLowerCase();
    if (['txt', 'json', 'md'].includes(ext)) {
      currentFormat = ext;
      els.segBtns.forEach((b) => b.classList.toggle('active', b.dataset.fmt === ext));
    }
    refreshResolved();
  }
});

els.pickFolderBtn.addEventListener('click', async () => {
  const r = await window.api.pickFolder();
  if (!r.canceled) {
    els.outputPath.value = r.folderPath;
    refreshResolved();
  }
});

/* --------- search start/stop --------- */
function setStatus(kind, text) {
  els.statusPill.classList.remove('running', 'done', 'error');
  if (kind && kind !== 'idle') els.statusPill.classList.add(kind);
  els.statusText.textContent = text;
}

els.startBtn.addEventListener('click', async () => {
  const query = els.query.value.trim();
  if (!query) {
    setStatus('error', 'informe a palavra-chave');
    els.query.focus();
    return;
  }
  if (term) term.clear();
  setStatus('running', 'buscando…');
  els.startBtn.disabled = true;
  els.stopBtn.disabled = false;
  els.revealBtn.disabled = true;

  const payload = {
    query,
    limit: parseInt(els.limit.value, 10) || 500,
    scope: els.scope.value,
    includeDms: els.includeDms.checked,
    format: currentFormat,
    customPath: els.outputPath.value.trim(),
  };

  const res = await window.api.startSearch(payload);
  if (!res.ok) {
    setStatus('error', res.error || 'falha ao iniciar');
    els.startBtn.disabled = false;
    els.stopBtn.disabled = true;
    return;
  }
  lastOutputPath = res.outputPath;
  els.outChip.textContent = res.outputPath;
  // refit after spawning
  setTimeout(() => fitTerm(), 100);
});

els.stopBtn.addEventListener('click', async () => {
  await window.api.stopSearch();
  setStatus('idle', 'interrompido');
  els.startBtn.disabled = false;
  els.stopBtn.disabled = true;
});

/* --------- pty bridge --------- */
window.api.onPtyData((data) => {
  if (term) term.write(data);
});

window.api.onPtyExit((info) => {
  els.startBtn.disabled = false;
  els.stopBtn.disabled = true;
  if (info.exitCode === 0) {
    setStatus('done', info.outputExists ? `salvo em ${info.outputPath}` : 'concluído');
  } else {
    setStatus('error', `encerrado (code ${info.exitCode})`);
  }
  if (info.outputExists) {
    els.revealBtn.disabled = false;
    lastOutputPath = info.outputPath;
    els.outChip.textContent = info.outputPath;
  }
});

els.revealBtn.addEventListener('click', () => {
  if (lastOutputPath) window.api.revealInFolder(lastOutputPath);
});

/* --------- stdin input box --------- */
function sendInputLine() {
  const val = els.ptyInput.value;
  window.api.sendInput(val + '\r');
  els.ptyInput.value = '';
}
els.sendBtn.addEventListener('click', sendInputLine);
els.ptyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendInputLine();
  }
});

/* --------- in-terminal search --------- */
function buildSearchOptions() {
  return {
    regex: regexMode,
    caseSensitive: caseMode,
    wholeWord: false,
    incremental: false,
    decorations: {
      matchBackground: '#ffb454',
      matchBorder: '#ffb454',
      matchOverviewRuler: '#ffb454',
      activeMatchBackground: '#5dff8a',
      activeMatchBorder: '#5dff8a',
      activeMatchColorOverviewRuler: '#5dff8a',
    },
  };
}

function updateSearchCounter(result) {
  if (!els.termSearch.value) {
    els.searchCounter.textContent = '—';
    els.searchCounter.classList.remove('has-match', 'no-match');
    return;
  }
  if (result && result.resultCount > 0) {
    els.searchCounter.textContent = `${result.resultIndex + 1}/${result.resultCount}`;
    els.searchCounter.classList.add('has-match');
    els.searchCounter.classList.remove('no-match');
  } else {
    els.searchCounter.textContent = '0/0';
    els.searchCounter.classList.add('no-match');
    els.searchCounter.classList.remove('has-match');
  }
}

function validateRegex(pattern) {
  if (!regexMode || !pattern) {
    els.termSearch.classList.remove('regex-invalid');
    return true;
  }
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern);
    els.termSearch.classList.remove('regex-invalid');
    return true;
  } catch (_) {
    els.termSearch.classList.add('regex-invalid');
    return false;
  }
}

function doSearchNext() {
  const q = els.termSearch.value;
  if (!q) { updateSearchCounter(null); return; }
  if (!validateRegex(q)) { updateSearchCounter({ resultCount: 0, resultIndex: -1 }); return; }
  const ok = searchAddon.findNext(q, buildSearchOptions());
  if (!ok) updateSearchCounter({ resultCount: 0, resultIndex: -1 });
}

function doSearchPrev() {
  const q = els.termSearch.value;
  if (!q) { updateSearchCounter(null); return; }
  if (!validateRegex(q)) { updateSearchCounter({ resultCount: 0, resultIndex: -1 }); return; }
  const ok = searchAddon.findPrevious(q, buildSearchOptions());
  if (!ok) updateSearchCounter({ resultCount: 0, resultIndex: -1 });
}

function clearSearch() {
  els.termSearch.value = '';
  els.termSearch.classList.remove('regex-invalid');
  if (searchAddon && searchAddon.clearDecorations) searchAddon.clearDecorations();
  updateSearchCounter(null);
}

function bindSearch() {
  if (searchAddon && searchAddon.onDidChangeResults) {
    searchAddon.onDidChangeResults((res) => updateSearchCounter(res));
  }

  els.termSearch.addEventListener('input', () => {
    validateRegex(els.termSearch.value);
    doSearchNext();
  });

  els.termSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) doSearchPrev();
      else doSearchNext();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      clearSearch();
      term && term.focus();
    }
  });

  els.searchNextBtn.addEventListener('click', doSearchNext);
  els.searchPrevBtn.addEventListener('click', doSearchPrev);
  els.searchClearBtn.addEventListener('click', clearSearch);

  els.regexToggle.addEventListener('click', () => {
    regexMode = !regexMode;
    els.regexToggle.classList.toggle('active', regexMode);
    els.regexToggle.title = regexMode ? 'regex ativado' : 'ativar regex';
    validateRegex(els.termSearch.value);
    if (els.termSearch.value) doSearchNext();
  });

  els.caseToggle.addEventListener('click', () => {
    caseMode = !caseMode;
    els.caseToggle.classList.toggle('active', caseMode);
    els.caseToggle.title = caseMode ? 'case sensitive ativado' : 'case sensitive';
    if (els.termSearch.value) doSearchNext();
  });

  // Atalho global: Ctrl/Cmd+F foca a busca
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      els.termSearch.focus();
      els.termSearch.select();
    }
  });
}

/* --------- boot --------- */
window.addEventListener('DOMContentLoaded', async () => {
  initTerminal();
  bindSearch();
  await loadConfig();
  refreshResolved();
});
