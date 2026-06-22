const { app, BrowserWindow, dialog, ipcMain } = require('electron');

// ── Captura de errores críticos ANTES de que todo esté inicializado
// Escribe en __dirname que siempre es escribible en desarrollo
// y en el portable (en AppData lo sobreescribimos después)
process.on('uncaughtException', function(err) {
    var fallbackLog = require('path').join(__dirname, 'crash.log');
    var msg = '[' + new Date().toISOString() + '] CRASH: ' + err.stack + '\n';
    try { require('fs').appendFileSync(fallbackLog, msg); } catch(_) {}
    if (err.code === 'EPIPE') return; // EPIPE es inofensivo (pipe cerrado)
    try {
        require('electron').dialog.showErrorBox('Error crítico', err.message + '\n\n' + err.stack);
    } catch(_) {}
});
process.on('unhandledRejection', function(err) {
    var fallbackLog = require('path').join(__dirname, 'crash.log');
    try { require('fs').appendFileSync(fallbackLog, '[' + new Date().toISOString() + '] PROMISE: ' + (err && err.stack || err) + '\n'); } catch(_) {}
});
const path = require('path');
const { fork } = require('child_process');
const fs = require('fs');
const http = require('http'); // Para hacer ping al servidor antes de cargar la UI
const { autoUpdater } = require('electron-updater');

// Silenciar EPIPE en stdout/stderr (ocurre al cerrar la app)
if (process.stdout) process.stdout.on('error', function(e) { if (e.code === 'EPIPE') {} });
if (process.stderr) process.stderr.on('error', function(e) { if (e.code === 'EPIPE') {} });


let mainWindow;
let serverProcess;
let permitirCierre = false;
let _updateState = null;        // estado de actualización pendiente (available/downloaded)
let _updateInstalling = false;   // evita doble install

// ── Rutas de datos — inicializadas DESPUÉS de app.ready ──────────────────────
// app.getPath() NO puede llamarse antes de que app emita 'ready'
// Usamos __dirname como fallback seguro hasta que app esté listo
let logFile        = path.join(__dirname, 'electron-debug.log');
let NET_CONFIG_FILE = path.join(__dirname, 'tecnitec_red.json');
let _dataDir       = __dirname; // se actualiza en app.whenReady()

// ─── Configuración de red ────────────────────────────────────────────────────
// Guardada en: <userData>/tecnitec_red.json
// Campos: { modo: 'local'|'cliente', host: '192.168.x.x', port: 3000 }

function leerConfigRed() {
    try {
        if (fs.existsSync(NET_CONFIG_FILE)) {
            return JSON.parse(fs.readFileSync(NET_CONFIG_FILE, 'utf8'));
        }
    } catch(e) {}
    return { modo: 'local', host: '127.0.0.1', port: 3000 };
}

function guardarConfigRed(cfg) {
    try { fs.writeFileSync(NET_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8'); } catch(e) {}
}

function getServidorHost() {
    var cfg = leerConfigRed();
    return cfg.modo === 'cliente' ? cfg.host : '127.0.0.1';
}

function getServidorPort() {
    var cfg = leerConfigRed();
    return cfg.port || 3000;
}

function esModoCliente() {
    return leerConfigRed().modo === 'cliente';
}


// ─── Logging ────────────────────────────────────────────────────────────────
function writeLog(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    try { console.log(message); } catch(e) {}
    try { fs.appendFileSync(logFile, logMessage, 'utf8'); } catch(e) {}
}

if (fs.existsSync(logFile)) {
    try { fs.unlinkSync(logFile); } catch(e) {}
}

writeLog('=== INICIO DE ELECTRON ===');

// ─── Esperar a que el servidor Express esté listo ────────────────────────────
// Hace pings a localhost:3000 hasta recibir respuesta.
// Resuelve en cuanto hay conexión TCP (cualquier status HTTP vale).
function esperarServidor(host, port, maxAttempts, delay) {
    maxAttempts = maxAttempts || 120;  // hasta ~60 segundos
    delay = delay || 500;

    return new Promise(function(resolve, reject) {
        var attempts = 0;

        function ping() {
            attempts++;
            writeLog('Ping al servidor intento ' + attempts + '/' + maxAttempts + '...');

            var req = http.request(
                { host: host, port: port, path: '/api/login', method: 'POST' },
                function(res) {
                    writeLog('Servidor respondio con status ' + res.statusCode);
                    resolve();
                }
            );

            req.on('error', function() {
                if (attempts >= maxAttempts) {
                    reject(new Error(
                        'El servidor no respondio despues de ' + maxAttempts + ' intentos.\n\n' +
                        'Causa probable: falta instalar dependencias.\n' +
                        'Solucion: abrir una terminal en la carpeta del proyecto y ejecutar:\n\n' +
                        '    npm install\n\n' +
                        'Luego reiniciar la aplicacion.'
                    ));
                } else {
                    setTimeout(ping, delay);
                }
            });

            req.setTimeout(800, function() {
                req.destroy();
                if (attempts >= maxAttempts) {
                    reject(new Error('Timeout esperando al servidor'));
                } else {
                    setTimeout(ping, delay);
                }
            });

            req.end();
        }

        ping();
    });
}

// ─── Crear ventana principal ─────────────────────────────────────────────────
function createWindow() {
    // En modo cliente no lanzamos servidor local
    if (esModoCliente()) {
        writeLog('[RED] Modo CLIENTE — conectando a servidor remoto: ' + getServidorHost() + ':' + getServidorPort());
    } else {
        writeLog('Iniciando servidor Express...');
    }

    // 1. Lanzar servidor en proceso hijo (solo en modo local)
    if (!esModoCliente()) {
    serverProcess = fork(path.join(__dirname, 'server.js'), [], {
        silent: true,   // ← true = capturamos stdout/stderr del hijo
        env: {
            ...process.env,
            // Pasar el directorio de datos al servidor para que no use __dirname
            // (en NSIS, __dirname = Program Files = solo lectura)
            TECNITEC_DATA_DIR: _dataDir,
            TECNITEC_PORT:     process.env.TECNITEC_PORT || '3000'
            // NOTA: TECNITEC_CHROMIUM_PATH eliminado - whatsapp.service.js
            // busca Chrome/Edge automáticamente. Usar process.execPath causaba
            // error "--allow-pre-commit-input" al intentar lanzar TECNITEC CORE.exe
        }
    });

    // Mostrar output del servidor en el log de Electron
    serverProcess.stdout.on('data', function(data) {
        try {
            String(data).trim().split('\n').forEach(function(line) {
                if (line) writeLog('[SERVER] ' + line);
            });
        } catch(e) { /* EPIPE si el pipe se rompe */ }
    });
    serverProcess.stdout.on('error', function(err) {
        if (err.code !== 'EPIPE') writeLog('[SERVER] Error en stdout: ' + err.message);
    });

    serverProcess.stderr.on('data', function(data) {
        try {
            String(data).trim().split('\n').forEach(function(line) {
                if (line) writeLog('[SERVER ERROR] ' + line);
            });
        } catch(e) { /* EPIPE si el pipe se rompe */ }
    });
    serverProcess.stderr.on('error', function(err) {
        if (err.code !== 'EPIPE') writeLog('[SERVER] Error en stderr: ' + err.message);
    });

    serverProcess.on('error', function(err) {
        writeLog('[ERROR] Error en proceso servidor: ' + err.message);
    });

    // ── Watchdog: reinicia el servidor si se cae con error ──────────────────
    var _servidorReintentos = 0;
    var _MAX_REINICIOS      = 5;

    function manejarCaidaServidor(code, signal) {
        writeLog('Proceso servidor termino - codigo: ' + code + ' señal: ' + signal);

        // Cierre normal (código 0) o señal de kill deliberada → no reiniciar
        if (code === 0 || signal === 'SIGTERM' || signal === 'SIGKILL') {
            writeLog('Servidor cerrado normalmente — no se reinicia.');
            return;
        }

        if (_servidorReintentos >= _MAX_REINICIOS) {
            writeLog('[WATCHDOG] Límite de reinicios alcanzado (' + _MAX_REINICIOS + '). Revisar electron-debug.log.');
            return;
        }

        _servidorReintentos++;
        writeLog('[WATCHDOG] Servidor caído con error. Reiniciando en 2s... (intento ' + _servidorReintentos + '/' + _MAX_REINICIOS + ')');

        setTimeout(function() {
            var nuevoServidor = require('child_process').fork(
                require('path').join(__dirname, 'server.js'), [],
                {
                    silent: true,
                    env: { ...process.env, TECNITEC_DATA_DIR: _dataDir, TECNITEC_PORT: process.env.TECNITEC_PORT || '3000' }
                }
            );

            nuevoServidor.stdout.on('data', function(data) {
                try { String(data).trim().split('\n').forEach(function(line) { if (line) writeLog('[SERVER] ' + line); }); } catch(e) {}
            });
            nuevoServidor.stdout.on('error', function(err) { if (err.code !== 'EPIPE') writeLog('[SERVER] Error stdout: ' + err.message); });
            nuevoServidor.stderr.on('data', function(data) {
                try { String(data).trim().split('\n').forEach(function(line) { if (line) writeLog('[SERVER ERROR] ' + line); }); } catch(e) {}
            });
            nuevoServidor.stderr.on('error', function(err) { if (err.code !== 'EPIPE') writeLog('[SERVER] Error stderr: ' + err.message); });
            nuevoServidor.on('exit', manejarCaidaServidor);

            serverProcess = nuevoServidor;
            writeLog('[WATCHDOG] Servidor reiniciado con PID ' + nuevoServidor.pid);

            // Recargar la ventana principal para reconectar al servidor
            setTimeout(function() {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.loadFile('index.html');
                    writeLog('[WATCHDOG] Ventana recargada tras reinicio del servidor.');
                }
            }, 3000);
        }, 2000);
    }

    serverProcess.on('exit', manejarCaidaServidor);

    } // fin if (!esModoCliente())

    // ─── Splash Screen ──────────────────────────────────────────────────────────
    // Ventana splash independiente: se muestra ANTES de que arranque el servidor.
    // Dura mínimo 5 segundos y se cierra cuando la app principal esté lista.
    var LOGO_DATA = 'data:image/png;base64,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';
    var splashMinMs = 5000;          // duración mínima garantizada
    var splashShownAt = Date.now();

    var splashWindow = new BrowserWindow({
        width:  520,
        height: 340,
        frame:        false,         // sin bordes — ventana flotante limpia
        transparent:  true,          // fondo transparente para bordes redondeados
        resizable:    false,
        movable:      true,
        skipTaskbar:  true,
        alwaysOnTop:  true,
        backgroundColor: '#00000000',
        webPreferences: { nodeIntegration: false, contextIsolation: true }
    });

    splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:100%; height:100%; overflow:hidden; }

  .splash {
    width: 100%;
    height: 100%;
    background: linear-gradient(145deg, #0d1421 0%, #111827 40%, #0f172a 100%);
    border-radius: 20px;
    border: 1px solid rgba(99,102,241,0.25);
    box-shadow:
      0 32px 80px rgba(0,0,0,0.8),
      0 0 0 1px rgba(255,255,255,0.04),
      inset 0 1px 0 rgba(255,255,255,0.06);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 28px;
    position: relative;
    overflow: hidden;
    -webkit-app-region: drag;
  }

  /* Glow ambiental de fondo */
  .splash::before {
    content: '';
    position: absolute;
    width: 320px;
    height: 320px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(99,102,241,0.12) 0%, transparent 70%);
    top: -80px; left: 50%;
    transform: translateX(-50%);
    pointer-events: none;
  }

  /* Línea decorativa superior */
  .splash::after {
    content: '';
    position: absolute;
    top: 0; left: 20%; right: 20%;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(99,102,241,0.6), transparent);
  }

  .logo-wrap {
    position: relative;
    width: 100px;
    height: 100px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /* Anillo exterior pulsante */
  .logo-ring {
    position: absolute;
    inset: -10px;
    border-radius: 50%;
    border: 1.5px solid rgba(99,102,241,0.35);
    animation: ring-pulse 2s ease-in-out infinite;
  }
  .logo-ring-2 {
    position: absolute;
    inset: -20px;
    border-radius: 50%;
    border: 1px solid rgba(99,102,241,0.15);
    animation: ring-pulse 2s ease-in-out 0.4s infinite;
  }

  @keyframes ring-pulse {
    0%, 100% { opacity: 0.5; transform: scale(1); }
    50%       { opacity: 1;   transform: scale(1.05); }
  }

  .logo-bg {
    width: 100px;
    height: 100px;
    border-radius: 24px;
    background: rgba(15,23,42,0.9);
    border: 1px solid rgba(99,102,241,0.3);
    box-shadow:
      0 0 30px rgba(99,102,241,0.2),
      inset 0 1px 0 rgba(255,255,255,0.08);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    animation: logo-appear 0.6s cubic-bezier(0.34,1.56,0.64,1) both;
  }

  @keyframes logo-appear {
    from { opacity:0; transform: scale(0.6); }
    to   { opacity:1; transform: scale(1); }
  }

  .logo-img {
    width: 80px;
    height: 80px;
    object-fit: contain;
    filter: drop-shadow(0 0 12px rgba(99,102,241,0.5)) brightness(1.1);
  }

  .brand {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    animation: text-rise 0.7s 0.2s cubic-bezier(0.22,1,0.36,1) both;
  }

  @keyframes text-rise {
    from { opacity:0; transform: translateY(16px); }
    to   { opacity:1; transform: translateY(0); }
  }

  .brand-name {
    font-family: -apple-system, 'Segoe UI', sans-serif;
    font-size: 26px;
    font-weight: 800;
    letter-spacing: 4px;
    text-transform: uppercase;
    background: linear-gradient(135deg, #e2e8f0 0%, #94a3b8 50%, #6366f1 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  .brand-sub {
    font-family: -apple-system, 'Segoe UI', sans-serif;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 3px;
    text-transform: uppercase;
    color: rgba(148,163,184,0.6);
  }

  .progress-wrap {
    width: 200px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    animation: text-rise 0.7s 0.4s cubic-bezier(0.22,1,0.36,1) both;
  }

  .progress-track {
    width: 100%;
    height: 3px;
    background: rgba(255,255,255,0.06);
    border-radius: 10px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    width: 0%;
    border-radius: 10px;
    background: linear-gradient(90deg, #6366f1, #818cf8, #6366f1);
    background-size: 200% 100%;
    animation:
      progress-load 5s cubic-bezier(0.4,0,0.2,1) forwards,
      shimmer 1.5s linear infinite;
  }

  @keyframes progress-load {
    0%   { width: 0%; }
    10%  { width: 15%; }
    30%  { width: 40%; }
    60%  { width: 70%; }
    85%  { width: 88%; }
    100% { width: 100%; }
  }

  @keyframes shimmer {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  .status-text {
    font-family: -apple-system, 'Segoe UI', sans-serif;
    font-size: 10px;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: rgba(148,163,184,0.45);
    animation: blink 2s ease-in-out infinite;
  }

  @keyframes blink {
    0%, 100% { opacity: 0.45; }
    50%       { opacity: 0.9;  }
  }

  .version-tag {
    position: absolute;
    bottom: 16px;
    right: 20px;
    font-family: 'Courier New', monospace;
    font-size: 9px;
    letter-spacing: 1px;
    color: rgba(99,102,241,0.35);
  }
</style>
</head>
<body>
<div class="splash">
  <div class="logo-wrap">
    <div class="logo-ring"></div>
    <div class="logo-ring-2"></div>
    <div class="logo-bg">
      <img class="logo-img" src="${LOGO_DATA}" alt="Logo">
    </div>
  </div>

  <div class="brand">
    <div class="brand-name">Tecnitec</div>
    <div class="brand-sub">Sistema de Gestión</div>
  </div>

  <div class="progress-wrap">
    <div class="progress-track">
      <div class="progress-fill"></div>
    </div>
    <div class="status-text">Iniciando sistema...</div>
  </div>

  <div class="version-tag">v31.81</div>
</div>
</body>
</html>
`));

    // ── WhatsApp Bot (Flutter) se inicia desde el .bat externamente ──────────
    writeLog('[Bot] El bot WhatsApp Flutter debe iniciarse desde LANZAR_TECNITEC.bat');

    // 2. Crear la ventana principal OCULTA mientras el servidor arranca
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        show: false,
        backgroundColor: '#0b0f1a',
        title: 'TECNITEC CORE v31.81',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webSecurity: true,
            webviewTag: true,
        },
        autoHideMenuBar: true,
        frame: true
    });

    // 3a. Configurar webviews para que puedan cargar WhatsApp Web correctamente
    mainWindow.webContents.on('will-attach-webview', function(event, webPreferences, params) {
        // Eliminar restricciones de seguridad para el webview de WhatsApp
        webPreferences.webSecurity = false;
        webPreferences.allowRunningInsecureContent = true;
        // Permitir notificaciones, medios, etc.
        params.permissions = [
            'notifications', 'geolocation', 'media', 'midi', 'midiSysex',
            'pointerLock', 'fullscreen', 'openExternal', 'clipboardRead',
            'clipboardSanitizedWrite'
        ];
        // Forzar user agent moderno
        params.useragent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
        writeLog('[WebView] will-attach-webview: seguridad desactivada para webview');
    });

    // 3b. Sobreescribir la CSP a nivel de sesión para garantizar
    //    que connect-src incluya localhost, independientemente del HTML
    var sesionesCSP = {};
    function overrideCSP(session) {
        if (sesionesCSP[session.id]) return;
        sesionesCSP[session.id] = true;
        session.webRequest.onHeadersReceived(function(details, callback) {
            callback({
                responseHeaders: Object.assign({}, details.responseHeaders, {
                    'Content-Security-Policy': [
                        "default-src 'self' data: blob:; " +
                        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; " +
                        "style-src 'self' 'unsafe-inline'; " +
                        "img-src 'self' data: blob: https:; " +
                        "connect-src 'self' http://localhost:* http://127.0.0.1:* " +
                        (function(){ var cfg=leerConfigRed(); return cfg.modo==='cliente'?'http://'+cfg.host+':'+cfg.port+' ws://'+cfg.host+':'+cfg.port+' ':''; })() +
                        "ws://localhost:* ws://127.0.0.1:* https://graph.facebook.com " +
                        "https://jojito33.github.io https://raw.githubusercontent.com; " +
                        "media-src 'self' blob:; " +
                        "font-src 'self' data:; " +
                        "frame-src https://web.whatsapp.com https://*.whatsapp.com https://*.whatsapp.net wss://web.whatsapp.com; " +
                        "child-src https://web.whatsapp.com https://*.whatsapp.com https://*.whatsapp.net;"
                    ]
                })
            });
        });
    }
    overrideCSP(mainWindow.webContents.session);
    // También aplicar a la sesión del webview (persist:whatsapp)
    try {
        overrideCSP(require('electron').session.fromPartition('persist:whatsapp'));
    } catch(e) {
        writeLog('[CSP] No se pudo aplicar CSP al webview: ' + (e.message||''));
    }

    // 5. Esperar servidor y luego cargar la app
    writeLog('Esperando que el servidor este listo...');

    var _srvHost = esModoCliente() ? getServidorHost() : '127.0.0.1';
    var _srvPort = getServidorPort();
    esperarServidor(_srvHost, _srvPort)
        .then(function() {
            writeLog('Servidor listo. Cargando index.html...');
            mainWindow.loadFile('index.html');
        })
        .catch(function(err) {
            writeLog('[ERROR] ' + err.message);
            if (splashWindow && !splashWindow.isDestroyed()) {
                splashWindow.close();
                splashWindow = null;
            }
            dialog.showErrorBox(
                'Error al iniciar TECNITEC',
                'El servidor interno no pudo iniciarse.\n\n' +
                'Detalle: ' + err.message + '\n\n' +
                'Verificá que:\n' +
                '• Node.js esté instalado correctamente\n' +
                '• El puerto 3000 no esté ocupado por otro programa\n' +
                '• Los archivos del proyecto estén completos'
            );
            app.quit();
        });

    // 5. Mostrar ventana principal cuando esté lista, cerrando el splash
    //    Se garantiza un mínimo de 5 segundos de splash antes de transición
    mainWindow.once('ready-to-show', function() {
        var elapsed = Date.now() - splashShownAt;
        var remaining = Math.max(0, splashMinMs - elapsed);

        writeLog('App lista para mostrar — splash restante: ' + remaining + 'ms');

        setTimeout(function() {
            // Fade-out del splash antes de cerrar
            if (splashWindow && !splashWindow.isDestroyed()) {
                splashWindow.webContents.executeJavaScript(
                    'document.querySelector(".splash").style.transition="opacity 0.5s ease";' +
                    'document.querySelector(".splash").style.opacity="0";'
                ).catch(function() {});
                setTimeout(function() {
                    if (splashWindow && !splashWindow.isDestroyed()) {
                        splashWindow.close();
                        splashWindow = null;
                    }
                    mainWindow.show();
                    writeLog('Ventana principal visible — splash cerrado');
                }, 500);
            } else {
                mainWindow.show();
                writeLog('Ventana visible');
            }
        }, remaining);
    });

    // 6. DevTools — desactivados en producción por defecto
    //    Para activarlos: lanzar con argumento --devtools o variable TECNITEC_DEV=1
    var devMode = process.argv.indexOf('--devtools') !== -1 ||
                  process.env.TECNITEC_DEV === '1';

    if (devMode) {
        mainWindow.webContents.openDevTools();
        writeLog('DevTools abiertos (modo desarrollo)');
    } else {
        writeLog('DevTools desactivados (produccion). Usar --devtools para activarlos.');
    }

    // 7. Loggear mensajes del renderer
    mainWindow.webContents.on('console-message', function(event, level, message, line, sourceId) {
        var levelStr = ['LOG', 'WARN', 'ERROR'][level] || 'INFO';
        var src = sourceId ? path.basename(sourceId) : '';
        writeLog('[RENDERER ' + levelStr + '] ' + message + ' (' + src + ':' + line + ')');
    });

    mainWindow.webContents.on('did-fail-load', function(event, errorCode, errorDescription, url) {
        writeLog('[ERROR] Fallo carga: ' + errorCode + ' - ' + errorDescription + ' - ' + url);
    });

    mainWindow.webContents.on('did-finish-load', function() {
        writeLog('Pagina cargada completamente');
        // Reenviar estado de actualización acumulado si el renderer recargó
        if (_updateState && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('updater:' + _updateState.type, _updateState.info);
        }
        // Iniciar verificación de actualizaciones 2s después de cargar la UI
        if (app.isPackaged) {
            setTimeout(function() { autoUpdater.checkForUpdates(); }, 2000);
        }
    });

    // 8. IPC: actualización automática con autoUpdater
    ipcMain.on('updater:check', function(event) {
        if (app.isPackaged && !_updateInstalling) {
            autoUpdater.checkForUpdates();
        }
    });
    ipcMain.on('updater:install', function() {
        if (app.isPackaged) {
            _updateInstalling = true;
            autoUpdater.quitAndInstall();
        }
    });

    // IPC: cierre limpio desde el renderer
    // IPC: cierre limpio desde el renderer
    ipcMain.on('cerrar-app', function() {
        writeLog('Senal de cierre desde renderer');
        permitirCierre = true;
        mainWindow.destroy();
    });

    // 9. Interceptar cierre con confirmación
    mainWindow.on('close', function(e) {
        if (permitirCierre) return;

        e.preventDefault();
        writeLog('Interceptando cierre');

        mainWindow.webContents.executeJavaScript(
            '(function() {' +
            '  try {' +
            '    if (typeof window.mostrarModalSalir === "function") {' +
            '      window.mostrarModalSalir(); return true;' +
            '    }' +
            '    return false;' +
            '  } catch(e) { return false; }' +
            '})();',
            true
        ).then(function(showed) {
            if (!showed) mostrarDialogoNativo();
        }).catch(function() {
            mostrarDialogoNativo();
        });
    });

    function mostrarDialogoNativo() {
        var choice = dialog.showMessageBoxSync(mainWindow, {
            type: 'question',
            buttons: ['Salir', 'Cancelar'],
            defaultId: 1,
            cancelId: 1,
            title: 'Confirmar salida',
            message: '¿Estás seguro de que querés cerrar TECNITEC?',
            detail: 'Todos los cambios han sido guardados.'
        });

        if (choice === 0) {
            writeLog('Usuario confirmo salida');
            permitirCierre = true;
            mainWindow.destroy();
        } else {
            writeLog('Usuario cancelo salida');
        }
    }

    // 10. Limpieza al cerrar la ventana
    mainWindow.on('closed', function() {
        writeLog('Ventana cerrada');
        if (serverProcess) {
            try {
                serverProcess.kill();
                writeLog('Proceso servidor terminado correctamente');
            } catch (err) {
                writeLog('[ERROR] Error cerrando servidor: ' + err.message);
            }
        }
        mainWindow = null;
    });
}

// ─── Ciclo de vida de la app ─────────────────────────────────────────────────
// app.disableHardwareAcceleration(); // REMOVIDO: causa crash en Windows

// Fix network service crash en Windows (Electron 31+)
app.commandLine.appendSwitch('allow-insecure-localhost');
app.commandLine.appendSwitch('disable-features', 'NetworkServiceSandbox'); // REMOVIDO: causa crash en Windows

const { validate: validateLicense } = require('./license');

// ─── IPC: configuración de red ──────────────────────────────────────────────
ipcMain.handle('licencia:info', function() {
    return global._licenciaInfo || null;
});

ipcMain.handle('red:leer', function() {
    return leerConfigRed();
});

ipcMain.handle('red:guardar', function(event, cfg) {
    guardarConfigRed(cfg);
    return { ok: true };
});

ipcMain.handle('red:probar', async function(event, host, port) {
    return new Promise(function(resolve) {
        var req = http.request(
            { host: host, port: port, path: '/api/red/ping', method: 'GET' },
            function(res) {
                var body = '';
                res.on('data', function(d) { body += d; });
                res.on('end', function() {
                    try { resolve({ ok: true, data: JSON.parse(body) }); }
                    catch(e) { resolve({ ok: true }); }
                });
            }
        );
        req.setTimeout(3000, function() { req.destroy(); resolve({ ok: false, error: 'Timeout' }); });
        req.on('error', function(e) { resolve({ ok: false, error: e.message }); });
        req.end();
    });
});

app.whenReady().then(async function() {
    writeLog('Licencia omitida (modo desarrollo)');

    global._licenciaInfo = {
        clientName: 'TECNITEC',
        plan:       'mensual',
        daysLeft:   365,
        offline:    false
    };

    // ── Inicializar directorio de datos ──
    if (app.isPackaged) {
        _dataDir = app.getPath('userData');
        logFile = path.join(_dataDir, 'electron-debug.log');
        NET_CONFIG_FILE = path.join(_dataDir, 'tecnitec_red.json');
        // Migrar archivos existentes desde __dirname (instalación previa)
        ['tecnitec_v31.db', 'gdrive_credentials.json'].forEach(function(f) {
            var src = path.join(__dirname, f);
            var dst = path.join(_dataDir, f);
            if (fs.existsSync(src) && !fs.existsSync(dst)) {
                try {
                    if (!fs.existsSync(_dataDir)) fs.mkdirSync(_dataDir, { recursive: true });
                    fs.copyFileSync(src, dst);
                    writeLog('[MIGRATE] ' + f + ' copiado a ' + dst);
                } catch(e) { writeLog('[MIGRATE] Error copiando ' + f + ': ' + e.message); }
            }
        });
    }

    writeLog('App lista, creando ventana...');
    createWindow();

    // ── Configurar autoUpdater (solo en modo empaquetado) ──
    if (app.isPackaged) {
        autoUpdater.setFeedURL({ provider: 'generic', url: 'https://jojito33.github.io/tecnitec/updates/' });

        autoUpdater.on('checking-for-update', function() {
            writeLog('[UPDATER] Verificando actualizaciones...');
        });
        autoUpdater.on('update-available', function(info) {
            writeLog('[UPDATER] Actualización disponible: ' + info.version);
            _updateState = { type: 'available', info: info };
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('updater:available', info);
            }
        });
        autoUpdater.on('update-not-available', function(info) {
            writeLog('[UPDATER] No hay actualizaciones');
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('updater:not-available', info);
            }
        });
        autoUpdater.on('error', function(err) {
            writeLog('[UPDATER] Error: ' + (err.message || err));
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('updater:error', { message: err.message || String(err) });
            }
        });
        autoUpdater.on('download-progress', function(progress) {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('updater:progress', progress);
            }
        });
        autoUpdater.on('update-downloaded', function(info) {
            writeLog('[UPDATER] Actualización descargada: ' + info.version);
            _updateState = { type: 'downloaded', info: info };
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('updater:downloaded', info);
            }
        });
    }
});

app.on('window-all-closed', function() {
    writeLog('Todas las ventanas cerradas');
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', function() {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', function() {
    permitirCierre = true;
});

writeLog('=== MAIN.JS CARGADO ===');
