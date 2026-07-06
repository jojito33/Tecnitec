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
    // Leer logo.png y convertir a base64 data URI
    var LOGO_SRC = '';
    try {
        var _buf = require('fs').readFileSync(require('path').join(__dirname, 'logo.png'));
        LOGO_SRC = 'data:image/png;base64,' + _buf.toString('base64');
    } catch(e) {
        writeLog('[Splash] Error cargando logo.png: ' + (e.message||e));
    }
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
    width: 140px;
    height: 140px;
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
    inset: -23px;
    border-radius: 50%;
    border: 1px solid rgba(99,102,241,0.15);
    animation: ring-pulse 2s ease-in-out 0.4s infinite;
  }

  @keyframes ring-pulse {
    0%, 100% { opacity: 0.5; transform: scale(1); }
    50%       { opacity: 1;   transform: scale(1.05); }
  }

  .logo-img {
    width: 130px;
    height: 130px;
    object-fit: contain;
    filter: drop-shadow(0 0 20px rgba(99,102,241,0.45));
    animation: logo-appear 0.6s cubic-bezier(0.34,1.56,0.64,1) both;
  }

  @keyframes logo-appear {
    from { opacity:0; transform: scale(0.6); }
    to   { opacity:1; transform: scale(1); }
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
    <img class="logo-img" src="${LOGO_SRC}" alt="Tecnitec">
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
<script>
// Remover fondo blanco del logo con Canvas (se ejecuta apenas carga la imagen)
window.addEventListener('load',function(){
  var img=document.querySelector('.logo-img');
  if(!img)return;
  var proc=function(){
    var c=document.createElement('canvas');
    c.width=img.naturalWidth||130;
    c.height=img.naturalHeight||130;
    var ctx=c.getContext('2d');
    ctx.drawImage(img,0,0,c.width,c.height);
    var d=ctx.getImageData(0,0,c.width,c.height);
    var px=d.data,t=220;
    for(var i=0;i<px.length;i+=4){
      if(px[i]>t&&px[i+1]>t&&px[i+2]>t)px[i+3]=0;
    }
    ctx.putImageData(d,0,0);
    img.src=c.toDataURL('image/png');
  };
  if(img.complete&&img.naturalWidth)proc();else{img.onload=proc;}
});
</script>
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
        autoUpdater.setFeedURL({ provider: 'generic', url: 'https://jojito33.github.io/Tecnitec/updates/' });

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
