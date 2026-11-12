const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
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
        webPreferences: { nodeIntegration: false, contextIsolation: true, webviewTag: true, preload: path.join(__dirname, 'preload.js') }
    });

    // Cargar índice IMEDIATAMENTE - el servidor inicia en segundo plano
    writeLog('Cargando índice inmediatamente');
    mainWindow.loadFile('index.html');

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
        writeLog('App lista, creando ventana...');
        createWindow();
    });
}

app.on('window-all-closed', () => { try { if (process.platform !== 'darwin') app.quit(); } catch(e) {} });
app.on('activate', () => { try { if (BrowserWindow.getAllWindows().length === 0) createWindow(); } catch(e) {} });
