import { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, session } from 'electron';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAssistantStore, openStore, tutorialCard } from './store.mjs';
import { createBoard } from './board.mjs';
import { createAgents } from './agents.mjs';
import { createAssistant } from './assistant.mjs';
import { findSimilarCards } from './column-memory.mjs';

const home = 'kanban://board/';
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/board.css', ['board.css', 'text/css']],
  ['/board.js', ['board.js', 'text/javascript']],
  ['/assistant.css', ['assistant.css', 'text/css']],
  ['/assistant.js', ['assistant.js', 'text/javascript']],
]);

protocol.registerSchemesAsPrivileged([{ scheme: 'kanban', privileges: { standard: true, secure: true } }]);
app.setName('HiveAgents Kanban');
if (process.env.KANBAN_DATA_DIR) {
  if (!isAbsolute(process.env.KANBAN_DATA_DIR)) throw new Error('KANBAN_DATA_DIR debe ser absoluto.');
  mkdirSync(process.env.KANBAN_DATA_DIR, { recursive: true, mode: 0o700 });
  app.setPath('userData', process.env.KANBAN_DATA_DIR);
}

let window;
let board;
let assistant;
let running;
let quitting = false;

function notify() {
  if (window && !window.webContents.isDestroyed()) window.webContents.send('board:changed');
}

function runBoard(id) {
  if (quitting || running) throw new Error('Esperá a que termine el ciclo activo.');
  running = board.run(id).finally(() => { running = undefined; });
  return running;
}

function boardAssistant() {
  if (!assistant) throw new Error('No se pudo abrir la conversación. Conservá assistant.json para recuperarla.');
  return assistant;
}

function similar(input) {
  const { title = '', brief = '', requiredTerms = [], excludeId } = input ?? {};
  if (typeof title !== 'string' || title.length > 120 || typeof brief !== 'string' || brief.length > 2000
    || !Array.isArray(requiredTerms) || requiredTerms.length > 8
    || requiredTerms.some(term => typeof term !== 'string' || term.length > 80)
    || (excludeId !== undefined && (typeof excludeId !== 'string' || excludeId.length > 128))) {
    throw new Error('Revisá los campos antes de buscar tareas parecidas.');
  }
  return findSimilarCards(board.snapshot().cards, { title, brief, requiredTerms }, { excludeId });
}

function openWindow() {
  window = new BrowserWindow({
    title: 'HiveAgents Kanban', width: 1360, height: 850, minWidth: 720, minHeight: 540,
    show: false, backgroundColor: '#f6f6f2',
    webPreferences: {
      contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false,
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => { window = undefined; });
  return window.loadURL(home);
}

async function start() {
  await app.whenReady();
  protocol.handle('kanban', async request => {
    const url = new URL(request.url);
    const asset = url.host === 'board' && assets.get(url.pathname);
    if (!asset || request.method !== 'GET') return new Response(null, { status: 404 });
    const content = await readFile(new URL(`../ui/${asset[0]}`, import.meta.url));
    return new Response(content, { headers: {
      'Content-Type': asset[1],
      'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      'X-Content-Type-Options': 'nosniff',
    } });
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const data = app.getPath('userData');
  const cwd = join(data, 'agent-workspace');
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const store = openStore(data);
  const firstLaunch = !store.exists();
  const agents = createAgents({
    cwd, receiptDirectory: join(data, 'receipts'), model: process.env.KANBAN_MODEL || undefined,
    getCards: () => board?.snapshot().cards ?? [],
  });
  board = createBoard({ store, agents, onChange: notify });
  if (firstLaunch) board.create(tutorialCard);
  try {
    assistant = createAssistant({
      board, store: openAssistantStore(data), respond: (input, signal) => agents.assist(input, signal),
      runCard: runBoard, onChange: notify,
    });
  } catch {
    // Board storage and its recovery stay usable even if the chat file is damaged.
  }

  const commands = {
    snapshot: () => board.snapshot(),
    create: input => board.create(input),
    edit: (id, input) => board.edit(id, input),
    copy: (id, receiptId) => clipboard.writeText(board.copyText(id, receiptId)),
    run: runBoard,
    stop: () => board.stop(),
    retry: id => board.retry(id),
    findSimilar: similar,
    assistantSnapshot: () => boardAssistant().snapshot(),
    askAssistant: input => boardAssistant().ask(input),
    decideAssistant: input => boardAssistant().decide(input),
  };
  for (const [name, command] of Object.entries(commands)) {
    ipcMain.handle(`board:${name}`, (event, ...args) => {
      if (event.sender !== window?.webContents || !event.senderFrame
          || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== home) {
        throw new Error('Origen de operación desconocido.');
      }
      return command(...args);
    });
  }
  await openWindow();
  app.on('activate', () => { if (!window) void openWindow(); });
}

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting || (!running && !assistant)) return;
    event.preventDefault();
    quitting = true;
    const timer = setTimeout(() => app.quit(), 5000);
    const closeAssistant = Promise.resolve().then(() => assistant?.close());
    try {
      board.stop();
    } catch {
      // The persisted in-flight marker allows recovery if the final write fails.
    }
    void Promise.allSettled([running, closeAssistant]).finally(() => {
      clearTimeout(timer);
      app.quit();
    });
  });
  start().catch(error => {
    dialog.showErrorBox('No se pudo abrir el tablero', error.message);
    app.quit();
  });
} else {
  app.quit();
}
