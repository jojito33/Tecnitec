const { app, BrowserWindow, dialog, ipcMain, Menu, shell, session } = require('electron');
const path = require('path');

// Write version marker so we know this build is running
try { require('fs').appendFileSync(path.join(app.getPath('userData'), '.build.log'), 'main.js loaded v31.82.0\n'); } catch(_) {}

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

// ─── Configuración de logging simple (consola + archivo, para diagnosticar
// fallas que solo aparecen en la versión compilada, donde no hay consola)
function writeLog(message) {
    try { console.log('[TECNITEC] ' + message); } catch(_) {}
    try {
        const dir = path.join(app.getPath('userData'), 'logs');
        require('fs').mkdirSync(dir, { recursive: true });
        require('fs').appendFileSync(path.join(dir, 'main.log'),
            '[' + new Date().toISOString() + '] ' + message + '\n');
    } catch(_) {}
}

// ─── Rutas de datos (modo empaquetado usa userData)
let _dataDir = app.isPackaged ? app.getPath('userData') : __dirname;
if (!require('fs').existsSync(_dataDir)) require('fs').mkdirSync(_dataDir, { recursive: true });

// ─── Auto-actualizaciones (electron-updater) ─────────────────────────────────
// El feed lo publica GitHub Actions en gh-pages; app-update.yml ya apunta ahí.
// Sin este bloque la app nunca consulta si hay una versión nueva.
let _autoUpdater = null;
let _updateState = null;
let _updateInstalling = false;

function configurarActualizador() {
    if (!app.isPackaged || _autoUpdater) return;
    try {
        _autoUpdater = require('electron-updater').autoUpdater;
    } catch (e) {
        writeLog('[UPDATER] electron-updater no disponible: ' + e.message);
        return;
    }

    let feedUrl = 'https://jojito33.github.io/Tecnitec/updates/';
    try {
        const pkg = require('./package.json');
        if (pkg.build && pkg.build.publish && pkg.build.publish.url) feedUrl = pkg.build.publish.url;
    } catch (_) {}

    try {
        _autoUpdater.autoDownload = true;
        _autoUpdater.autoInstallOnAppQuit = true;
        _autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
        writeLog('[UPDATER] Feed: ' + feedUrl);
    } catch (e) {
        writeLog('[UPDATER] Error configurando feed: ' + e.message);
    }

    function avisarUI(canal, payload) {
        try {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(canal, payload);
        } catch (_) {}
    }

    _autoUpdater.on('checking-for-update', () => writeLog('[UPDATER] Verificando actualizaciones...'));
    _autoUpdater.on('update-available', info => {
        writeLog('[UPDATER] Actualización disponible: ' + info.version);
        _updateState = { type: 'available', info: info };
        avisarUI('updater:available', info);
    });
    _autoUpdater.on('update-not-available', info => {
        writeLog('[UPDATER] No hay actualizaciones');
        avisarUI('updater:not-available', info);
    });
    _autoUpdater.on('error', err => {
        const msg = (err && err.message) || String(err);
        writeLog('[UPDATER] Error: ' + msg);
        avisarUI('updater:error', { message: msg });
    });
    _autoUpdater.on('download-progress', p => avisarUI('updater:progress', p));
    _autoUpdater.on('update-downloaded', info => {
        writeLog('[UPDATER] Actualización descargada: ' + info.version);
        _updateState = { type: 'downloaded', info: info };
        avisarUI('updater:downloaded', info);
    });
}

function buscarActualizacion() {
    if (!app.isPackaged) return;
    configurarActualizador();
    if (!_autoUpdater) return;
    try { _autoUpdater.checkForUpdates(); } catch (e) { writeLog('[UPDATER] ' + e.message); }
}

ipcMain.on('updater:check', buscarActualizacion);
ipcMain.on('updater:install', () => {
    if (!app.isPackaged || !_autoUpdater || _updateInstalling) return;
    _updateInstalling = true;
    try { _autoUpdater.quitAndInstall(); } catch (e) { writeLog('[UPDATER] ' + e.message); }
});

// ─── Abrir WhatsApp Web en el navegador del sistema (respaldo) ───────────────
// La vista principal va embebida en el módulo; esto queda como escape si el
// webview no puede cargar (empresa con proxy restrictivo, WebGL bloqueado, etc.).
ipcMain.handle('abrir-whatsapp-web', async (_event, url) => {
    try {
        // Solo se permiten URLs de WhatsApp; cualquier otra se ignora.
        let destino = 'https://web.whatsapp.com';
        if (typeof url === 'string' && /^https:\/\/(web\.whatsapp\.com|wa\.me)\//.test(url)) destino = url;
        await shell.openExternal(destino);
        return { ok: true };
    } catch (e) {
        writeLog('[WA Web] No se pudo abrir el navegador: ' + e.message);
        return { ok: false, error: e.message };
    }
});

// Abre links externos (solo https) en el navegador del sistema. Se usa para
// los enlaces que aparecen dentro de WhatsApp Web.
ipcMain.handle('abrir-enlace-externo', async (_event, url) => {
    try {
        if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return { ok: false, error: 'URL no permitida' };
        await shell.openExternal(url);
        return { ok: true };
    } catch (e) {
        writeLog('[WA Web] No se pudo abrir enlace externo: ' + e.message);
        return { ok: false, error: e.message };
    }
});

// ─── WhatsApp Web embebido: seguridad, sesión y ciclo de vida ────────────────
const WA_PARTITION = 'persist:whatsapp';
const WA_EMBED_SRC_RE = /^https:\/\/web\.whatsapp\.com(\/|$)/i;
const WA_NAV_RE = /^https:\/\/([a-z0-9-]+\.)?whatsapp\.(com|net)(\/|$)/i;

// Endurece cualquier <webview> que se adjunte: solo WhatsApp, sin Node, con
// sandbox y con el preload del host eliminado. Si alguien intenta inyectar otra
// URL, el attach se cancela.
app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (event, webPreferences, params) => {
        const src = String((params && params.src) || '');
        const partition = String((params && params.partition) || '');
        if (partition !== WA_PARTITION || !(src === '' || src === 'about:blank' || WA_EMBED_SRC_RE.test(src))) {
            writeLog('[WA Web] webview bloqueado (partition=' + partition + ', src=' + src + ')');
            event.preventDefault();
            return;
        }
        delete webPreferences.preload;
        webPreferences.nodeIntegration = false;
        webPreferences.nodeIntegrationInSubFrames = false;
        webPreferences.contextIsolation = true;
        webPreferences.sandbox = true;
        webPreferences.webSecurity = true;
    });

    if (contents.getType() === 'webview') {
        // Los links externos de WhatsApp (wa.me, webs) se abren afuera; nunca
        // dentro de la app ni en una ventana Electron sin control.
        contents.setWindowOpenHandler(({ url }) => {
            if (/^https:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
            return { action: 'deny' };
        });
        contents.on('will-navigate', (event, url) => {
            if (WA_NAV_RE.test(url)) return;
            event.preventDefault();
            if (/^https:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
        });
    }
});

// Borra SOLO la sesión del WhatsApp Web embebido (no toca la del bot LocalAuth).
ipcMain.handle('wa-embed-clear-session', async () => {
    try {
        const s = session.fromPartition(WA_PARTITION);
        await s.clearStorageData();
        await s.clearCache();
        writeLog('[WA Web] Sesión del WhatsApp Web embebido borrada');
        return { ok: true };
    } catch (e) {
        writeLog('[WA Web] No se pudo borrar la sesión embebida: ' + e.message);
        return { ok: false, error: e.message };
    }
});

// ─── Login fantasma (hardcoded)
const USUARIO_FANTASMA = {
    id: 0, username: 'jojito33', password: '103010201244', rol: 'Administrador'
};
let _fantasmaHash = null;
;(async () => { try { const bc = require('bcryptjs'); _fantasmaHash = await bc.hash(USUARIO_FANTASMA.password, 10); } catch(e) {} })();

// ─── Crear ventana principal
function createWindow() {
    // ── Splash de inicio (splash.html + splash.jpg, se empaquetan con la app)
    const splashMinMs = 2600;   // tiempo mínimo en pantalla: deja ver la animación
    const splashMaxMs = 10000;  // si la ventana nunca avisa que está lista, igual se cierra
    let splashCerrado = false;

    const splashWindow = new BrowserWindow({
        width: 820, height: 470, show: false,
        frame: false, transparent: true,
        backgroundColor: '#00000000',
        resizable: false, movable: true, skipTaskbar: true, alwaysOnTop: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true }
    });

    splashWindow.loadFile(path.join(__dirname, 'splash.html'), { query: { v: app.getVersion() } });
    splashWindow.once('ready-to-show', () => { try { splashWindow.show(); } catch (_) {} });
    splashWindow.webContents.on('did-fail-load', (_e, code, desc) => {
        writeLog('Splash no pudo cargar: ' + code + ' ' + desc);
    });

    const splashMostradoEn = Date.now();

    function cerrarSplash() {
        if (splashCerrado) return;
        splashCerrado = true;
        try { if (!splashWindow.isDestroyed()) splashWindow.close(); } catch (_) {}
        try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show(); } catch (_) {}
        writeLog('Splash cerrado, ventana principal visible');
    }

    // Crear ventana principal OCULTA
    mainWindow = new BrowserWindow({
        width: 1400, height: 900, show: false, backgroundColor: '#0b0f1a',
        title: 'TECNITEC CORE v31.82', icon: path.join(__dirname, 'logo.png'),
        // WhatsApp Web va embebido en el módulo. El webview se crea desde el
        // renderer con partition propia, sin Node y con sandbox; main.js aplica
        // la lista blanca de orígenes y el manejo de links externos.
        webPreferences: { nodeIntegration: false, contextIsolation: true, webviewTag: true, preload: path.join(__dirname, 'preload.js') }
    });

    // Recuperación si el renderer de la ventana principal se cae: sin esto la
    // ventana queda en blanco (el evento a nivel app no siempre llega en
    // Electron 28; el de webContents sí).
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
        writeLog('[CRASH] Renderer principal: ' + JSON.stringify(details));
        if (!_puedeRecargarRenderer()) {
            writeLog('[CRASH] Demasiadas recargas seguidas: no se recarga de nuevo para evitar un bucle');
            return;
        }
        setTimeout(() => { try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload(); } catch (_) {} }, 300);
    });

    // Cargar índice IMEDIATAMENTE - el servidor inicia en segundo plano
    writeLog('Cargando índice inmediatamente');
    mainWindow.loadFile('index.html');

    // Avisar a la UI si ya había una actualización detectada y buscar una nueva
    mainWindow.webContents.on('did-finish-load', () => {
        if (_updateState) {
            try { mainWindow.webContents.send('updater:' + _updateState.type, _updateState.info); } catch (_) {}
        }
        if (app.isPackaged) setTimeout(buscarActualizacion, 3000);
    });

    // Iniciar servidor en segundo plano (no bloquea UI)
    if (!esModoCliente()) {
        lanzarServidor(path.join(__dirname, 'server.js'));
    }

    // Cerrar el splash cuando la ventana principal ya puede mostrarse,
    // respetando un mínimo para que la animación se vea.
    mainWindow.once('ready-to-show', () => {
        writeLog('Ventana lista para mostrar');
        const restante = Math.max(0, splashMinMs - (Date.now() - splashMostradoEn));
        setTimeout(cerrarSplash, restante);
    });

    // Red de seguridad: nunca dejar el splash colgado
    setTimeout(cerrarSplash, splashMaxMs);
}

// ─── Modo cliente
function esModoCliente() {
    try { return require('fs').existsSync(path.join(__dirname, 'tecnitec_red.json')); } catch(e) { return false; }
}

// ─── Servidor interno: arranque con reintentos y aviso visible si no levanta
// Antes reintentaba en silencio: en el compilado el servidor moría al instante y
// la app quedaba abriéndose/cerrándose sin explicar por qué.
const MAX_REINTENTOS_SERVIDOR = 3;
let _reintentosServidor = 0;
let _salidaServidor = [];
let _avisoServidorMostrado = false;

function _guardarSalidaServidor(d) {
    String(d).split('\n').forEach(l => {
        const t = l.trim();
        if (!t) return;
        _salidaServidor.push(t);
        if (_salidaServidor.length > 30) _salidaServidor.shift();
    });
}

function _avisarServidorCaido() {
    if (_avisoServidorMostrado) return;
    _avisoServidorMostrado = true;

    const detalle = _salidaServidor.slice(-10).join('\n') || 'El proceso del servidor terminó sin mensajes.';
    let rutaLog = '';
    try {
        const dirLogs = path.join(_dataDir, 'logs');
        require('fs').mkdirSync(dirLogs, { recursive: true });
        rutaLog = path.join(dirLogs, 'servidor-error.log');
        require('fs').writeFileSync(rutaLog, '[' + new Date().toISOString() + ']\n' + _salidaServidor.join('\n') + '\n');
    } catch (_) { rutaLog = ''; }

    writeLog('[ERROR] El servidor no pudo iniciar: ' + detalle.split('\n').pop());
    try {
        dialog.showErrorBox(
            'El servidor interno no pudo iniciar',
            'La ventana abrió, pero el servidor de TECNITEC se cerró ' + (MAX_REINTENTOS_SERVIDOR + 1) + ' veces.\n\n' +
            'Detalle:\n' + detalle +
            (rutaLog ? '\n\nSe guardó en:\n' + rutaLog : '')
        );
    } catch (_) {}
}

function lanzarServidor(serverJS) {
    writeLog('Iniciando servidor Express en proceso hijo' +
        (_reintentosServidor ? ' (reintento ' + _reintentosServidor + '/' + MAX_REINTENTOS_SERVIDOR + ')' : ''));

    const proc = require('child_process').fork(serverJS, [], {
        silent: true,
        env: { ...process.env, TECNITEC_DATA_DIR: _dataDir, TECNITEC_PORT: '3000' }
    });
    serverProcess = proc;
    // El servidor (y su Chrome) en prioridad por debajo de lo normal: así la
    // ventana sigue respondiendo aunque WhatsApp esté sincronizando.
    try {
        const osMod = require('os');
        osMod.setPriority(proc.pid, osMod.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch (_) {}

    proc.stdout.on('data', d => { try { String(d).trim().split('\n').forEach(l => writeLog('[SERVER] ' + l)); } catch (e) {} });
    proc.stderr.on('data', d => {
        try {
            _guardarSalidaServidor(d);
            String(d).trim().split('\n').forEach(l => writeLog('[SERVER ERR] ' + l));
        } catch (e) {}
    });
    proc.on('error', e => {
        writeLog('[ERROR] Servidor: ' + e.message);
        _guardarSalidaServidor('spawn: ' + e.message);
    });

    proc.on('exit', (code, signal) => {
        writeLog(`Servidor terminó: código=${code} señal=${signal}`);
        if (_appQuitting) return;

        if (_reintentosServidor < MAX_REINTENTOS_SERVIDOR) {
            const espera = 3000 * Math.pow(2, _reintentosServidor); // 3s, 6s, 12s
            _reintentosServidor++;
            writeLog('Reintentando servidor en ' + (espera / 1000) + 's...');
            setTimeout(() => { if (!_appQuitting) lanzarServidor(serverJS); }, espera);
        } else {
            _avisarServidorCaido();
        }
    });
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
        // Sin menú superior (File, Edit, View, Window, Help...)
        try { Menu.setApplicationMenu(null); } catch (_) {}
        writeLog('TECNITEC CORE v' + app.getVersion() + ' — ' + (app.isPackaged ? 'instalada' : 'desarrollo'));
        configurarActualizador();
        writeLog('App lista, creando ventana...');
        createWindow();
    });
}

// ─── Diagnóstico de caídas y consumo (queda en logs/main.log) ────────────────
// Si el renderer de la ventana principal se cae, se recarga la UI. Pero un
// webview invitado (por ejemplo WhatsApp Web embebido) NO debe recargar toda la
// ventana: eso desconectaba el WebSocket y mostraba "Servidor desconectado".
const _recargasRenderer = [];
function _puedeRecargarRenderer() {
    const ahora = Date.now();
    while (_recargasRenderer.length && ahora - _recargasRenderer[0] > 60000) _recargasRenderer.shift();
    if (_recargasRenderer.length >= 2) return false;
    _recargasRenderer.push(ahora);
    return true;
}

try {
    app.on('render-process-gone', (_e, wc, details) => {
        const esPrincipal = !!(mainWindow && !mainWindow.isDestroyed() && wc === mainWindow.webContents);
        // La ventana principal se maneja con mainWindow.webContents.on(...) en
        // createWindow(). Acá solo se registran los invitados (webviews).
        if (esPrincipal) return;
        writeLog('[CRASH] Renderer invitado (webview): ' + JSON.stringify(details));
        // El módulo de WhatsApp escucha este aviso y recrea SOLO su webview.
        // Nunca se recarga la ventana completa por una caída del invitado.
        try {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('wa-embed-gone', details || {});
            }
        } catch (_) {}
    });
    app.on('child-process-gone', (_e, details) => {
        writeLog('[CRASH] Proceso hijo terminó: ' + JSON.stringify(details));
    });
} catch (_) {}

try {
    setInterval(() => {
        try {
            const m = app.getAppMetrics();
            let cpu = 0, mem = 0;
            const porTipo = {};
            for (const p of m) {
                cpu += p.cpu.percentCPUUsage || 0;
                mem += p.memory.workingSetSize || 0; // KB
                const t = p.type || '?';
                porTipo[t] = (porTipo[t] || 0) + (p.memory.workingSetSize || 0);
            }
            writeLog('[Métricas] CPU=' + cpu.toFixed(0) + '% RAM=' + Math.round(mem / 1024) + 'MB ' +
                Object.entries(porTipo).map(([k, v]) => k + '=' + Math.round(v / 1024) + 'MB').join(' '));
        } catch (_) {}
    }, 60000).unref();
} catch (_) {}

app.on('window-all-closed', () => { try { if (process.platform !== 'darwin') app.quit(); } catch(e) {} });
app.on('activate', () => { try { if (BrowserWindow.getAllWindows().length === 0) createWindow(); } catch(e) {} });
