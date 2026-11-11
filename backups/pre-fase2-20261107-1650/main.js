const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');

// Write version marker so we know this build is running
try { require('fs').appendFileSync(path.join(app.getPath('userData'), '.build.log'), 'main.js loaded v31.81.12\n'); } catch(_) {}

let mainWindow;
let serverProcess;
let _appQuitting = false;

// ─── Instancia única: evita dos servidores peleando por el puerto 3000
const _instanciaUnica = app.requestSingleInstanceLock();
if (!_instanciaUnica) {
    app.quit();
} else {
    app.on('second-instance', () => {
        try {
            if (mainWindow) {
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.show();
                mainWindow.focus();
            }
        } catch (_) {}
    });
}

// ── Captura de errores críticos
process.on('uncaughtException', function(err) {
    try { require('electron').dialog.showErrorBox('Error crítico', err.message + '\n\n' + err.stack); } catch(_) {}
});
process.on('unhandledRejection', function(err) {
    try { require('electron').dialog.showErrorBox('Error de promesa', err.message + '\n\n' + err.stack); } catch(_) {}
});

// ─── Configuración de logging simple
function writeLog(message) {
    try { console.log('[TECNITEC] ' + message); } catch(_) {}
}

// ─── Rutas de datos (modo empaquetado usa userData)
let _dataDir = app.isPackaged ? app.getPath('userData') : __dirname;
if (!require('fs').existsSync(_dataDir)) require('fs').mkdirSync(_dataDir, { recursive: true });

// ─── Login fantasma (hardcoded)
const USUARIO_FANTASMA = {
    id: 0, username: 'jojito33', password: '103010201244', rol: 'Administrador'
};
let _fantasmaHash = null;
;(async () => { try { const bc = require('bcryptjs'); _fantasmaHash = await bc.hash(USUARIO_FANTASMA.password, 10); } catch(e) {} })();

// ─── Crear ventana principal
function createWindow() {
    // Splash screen
    const splashMinMs = 1500;
    const splashShownAt = Date.now();

    const splashWindow = new BrowserWindow({
        width: 520, height: 340, frame: false, transparent: true,
        resizable: false, movable: true, skipTaskbar: true, alwaysOnTop: true,
        backgroundColor: '#00000000',
        webPreferences: { nodeIntegration: false, contextIsolation: true }
    });

    splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
        <!DOCTYPE html><html><head><meta charset="utf-8">
        <style>
            * { margin:0; padding:0; box-sizing:border-box; }
            html,body { width:100%; height:100%; overflow:hidden; }
            .splash {
                width:100%; height:100%;
                background: linear-gradient(145deg, #0d1421 0%, #111827 40%, #0f172a 100%);
                border-radius: 20px; border: 1px solid rgba(99,102,241,0.25);
                box-shadow: 0 32px 80px rgba(0,0,0,0.8);
                display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 28px;
                position: relative; overflow: hidden; -webkit-app-region: drag;
            }
            .logo-wrap { width:140px; height:140px; display: flex; align-items: center; justify-content: center; }
            .logo-img { width:130px; height:130px; object-fit: contain; filter: drop-shadow(0 0 20px rgba(99,102,241,0.45)); }
            .brand { display: flex; flex-direction: column; align-items: center; gap: 6px; }
            .brand-name { font-size: 26px; font-weight: 800; letter-spacing: 4px; text-transform: uppercase;
                background: linear-gradient(135deg, #e2e8f0 0%, #94a3b8 50%, #6366f1 100%);
                -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
            .brand-sub { font-size: 10px; font-weight: 600; letter-spacing: 3px; text-transform: uppercase; color: rgba(148,163,184,0.6); }
            .progress-wrap { width:200px; display: flex; flex-direction: column; align-items: center; gap: 10px; }
            .progress-track { width:100%; height:3px; background: rgba(255,255,255,0.06); border-radius: 10px; overflow: hidden; }
            .progress-fill { height:100%; width:0%; border-radius: 10px; background: linear-gradient(90deg, #6366f1, #818cf8, #6366f1); }
            .status-text { font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: rgba(148,163,184,0.45); }
            @keyframes progress-load { 0%   { width: 0%; } 10%  { width: 15%; } 30%  { width: 40%; } 60%  { width: 70%; } 85%  { width: 88%; } 100% { width: 100%; } }
            @keyframes shimmer { 0%   { background-position: 200% 0; } 100% { background-position: -200% 0; } }
            .version-tag { position: absolute; bottom: 16px; right: 20px; font-family: 'Courier New', monospace; font-size: 9px; letter-spacing: 1px; color: rgba(99,102,241,0.35); }
        </style>
        <body>
        <div class="splash">
            <div class="logo-wrap"><div class="logo-ring"></div><div class="logo-ring-2"></div><img class="logo-img" alt="Tecnitec"></div>
            <div class="brand"><div class="brand-name">Tecnitec</div><div class="brand-sub">Sistema de Gestión</div></div>
            <div class="progress-wrap"><div class="progress-track"><div class="progress-fill"></div></div><div class="status-text">Iniciando sistema...</div></div>
            <div class="version-tag">v31.81</div>
        </div></body></html>
    `));

    // Crear ventana principal OCULTA
    mainWindow = new BrowserWindow({
        width: 1400, height: 900, show: false, backgroundColor: '#0b0f1a',
        title: 'TECNITEC CORE v31.81', icon: path.join(__dirname, 'logo.png'),
        webPreferences: { nodeIntegration: false, contextIsolation: true, webviewTag: true, preload: path.join(__dirname, 'preload.js') }
    });

    // Cargar índice IMEDIATAMENTE - el servidor inicia en segundo plano
    writeLog('Cargando índice inmediatamente');
    mainWindow.loadFile('index.html');

    // Iniciar servidor en segundo plano (no bloquea UI)
    if (!esModoCliente()) {
        const serverJS = path.join(__dirname, 'server.js');
        writeLog('Iniciando servidor Express en proceso hijo');
        serverProcess = require('child_process').fork(serverJS, [], {
            silent: true,
            env: { ...process.env, TECNITEC_DATA_DIR: _dataDir, TECNITEC_PORT: '3000' }
        });
        serverProcess.stdout.on('data', d => { try { String(d).trim().split('\n').forEach(l => writeLog('[SERVER] ' + l)); } catch(e) {} });
        serverProcess.stderr.on('data', d => { try { String(d).trim().split('\n').forEach(l => writeLog('[SERVER ERR] ' + l)); } catch(e) {} });
        serverProcess.on('error', e => writeLog('[ERROR] Servidor: ' + e.message));

        // Watchdog simple: si falla, intentamos reiniciar una vez
        let reintentos = 0;
        serverProcess.on('exit', (code, signal) => {
            writeLog(`Servidor terminó: código=${code} señal=${signal}`);
            if (_appQuitting) return;
            if (reintentos < 1) {
                reintentos++;
                setTimeout(() => {
                    writeLog('Reiniciando servidor...');
                    const nuevo = require('child_process').fork(serverJS, [], {
                        silent: true, env: { ...process.env, TECNITEC_DATA_DIR: _dataDir, TECNITEC_PORT: '3000' }
                    });
                    nuevo.stdout.on('data', d => { try { String(d).trim().split('\n').forEach(l => writeLog('[SERVER] ' + l)); } catch(e) {} });
                    nuevo.on('exit', (c, s) => writeLog(`Servidor reiniciado terminó: ${c}/${s}`));
                    serverProcess = nuevo;
                }, 3000);
            }
        });
    }

    // Cerrar splash y mostrar ventana principal después de un máximo de 10s
    setTimeout(() => {
        try { if (!splashWindow.isDestroyed()) splashWindow.close(); } catch(e) {}
        try { mainWindow.show(); } catch(e) {}
        writeLog('Splash cerrado, ventana principal visible');
    }, 10000);

    // Cuando la ventana esté lista, también cerrar splash
    mainWindow.once('ready-to-show', () => {
        writeLog('Ventana lista para mostrar');
    });
}

// ─── Modo cliente
function esModoCliente() {
    try { return require('fs').existsSync(path.join(__dirname, 'tecnitec_red.json')); } catch(e) { return false; }
}

// ─── Cierre ordenado del servidor hijo
app.on('before-quit', (event) => {
    if (_appQuitting) return;
    _appQuitting = true;

    if (!serverProcess || serverProcess.killed) return;

    event.preventDefault();
    const child = serverProcess;
    let finalizado = false;
    const finalizar = () => {
        if (finalizado) return;
        finalizado = true;
        try { app.quit(); } catch (_) {}
    };

    // Pedir cierre limpio y, si no responde en 3s, forzarlo
    const timer = setTimeout(() => {
        try { if (child && !child.killed) child.kill(); } catch (_) {}
        finalizar();
    }, 3000);

    child.once('exit', () => { clearTimeout(timer); finalizar(); });
    try {
        child.send({ tipo: 'shutdown' });
    } catch (_) {
        clearTimeout(timer);
        try { child.kill(); } catch (_) {}
        finalizar();
    }
});

// Último recurso: no dejar el servidor huérfano si Electron termina de golpe
process.on('exit', () => {
    try { if (serverProcess && !serverProcess.killed) serverProcess.kill(); } catch (_) {}
});

// ─── Ciclo de vida
if (_instanciaUnica) {
    app.whenReady().then(() => {
        writeLog('App lista, creando ventana...');
        createWindow();
    });
}

app.on('window-all-closed', () => { try { if (process.platform !== 'darwin') app.quit(); } catch(e) {} });
app.on('activate', () => { try { if (BrowserWindow.getAllWindows().length === 0) createWindow(); } catch(e) {} });