# Plan de Optimización Integral del Sistema

**Proyecto:** TECNITEC CORE v31.81.12 — Electron + Node/Express + SQLite + WhatsApp  
**Host:** Windows 10 Enterprise LTSC 2021 · Intel Core i3-4130 · 8 GB RAM · SSD NVMe 477 GB + HDD 932 GB  
**Fecha:** 03/11/2026  
**Estado:** propuesta para aprobación  
**Alcance:** rendimiento de la aplicación, uso de memoria, arranque, base de datos, empaquetado y higiene del sistema operativo.

---

## 1. Resumen ejecutivo

El sistema funciona, pero acumula cuatro cuellos de botella que explican la lentitud percibida y el consumo de recursos:

1. **Almacenamiento:** el proyecto y la sesión de WhatsApp viven en `G:` (HDD Toshiba). El SSD `C:` tiene 331 GB libres. Node y SQLite hacen miles de lecturas pequeñas: en HDD cuestan órdenes de magnitud más.
2. **Memoria:** 8 GB en un solo módulo (single-channel), con solo **1,27 GB libres** al momento de la medición. Chrome, Edge y Ollama se inician con Windows y suman ~650 MB antes de abrir la app.
3. **Trabajo redundante:** el servidor levanta un Chrome headless con `whatsapp-web.js` a los 5 segundos **y** la UI abre un `<webview>` de WhatsApp Web. Son dos sesiones completas de WhatsApp. A eso se suman 5 bucles de polling solapados y logging síncrono a disco.
4. **Deuda de empaquetado:** Electron 28 (sin soporte), `asar: false`, se incluye todo `node_modules`, un bot Flutter muerto de 377 MB y dependencias que ya no se usan.

**Resultado esperado (estimado, a validar con medición T0):**

| Métrica | Hoy | Meta | Mejora |
|---|---|---|---|
| Arranque en frío (modo .bat) | ~15–25 s (estimado) | ≤ 8 s | −50 % o más |
| RAM de la app sin panel WhatsApp | Por medir | ≤ 500 MB | — |
| RAM con WhatsApp abierto | Por medir | ≤ 1,2 GB | — |
| Escrituras síncronas de log | ~35.000/día | < 1.000/día | −97 % |
| WAL de SQLite tras cerrar | 684 KB | ≤ 256 KB | −60 % |
| Paquete descomprimido | 343 MB | ≤ 200 MB | −40 % |
| Errores no controlados en 72 h | Por medir | 0 | — |

**Mayor retorno por hora invertida:** Fase 0 (2–3 h) + mover el proyecto al SSD (1 h) + desactivar el bot headless cuando no se use (1 h).

---

## 2. Línea base medida

### 2.1 Host

| Elemento | Valor |
|---|---|
| CPU | Intel Core i3-4130 — 2 núcleos / 4 hilos, 3,40 GHz (2013) |
| RAM | 8 GB DDR3-1600, **un solo módulo**; 4 ranuras; máximo 32 GB |
| RAM libre al medir | **1,27 GB** (con herramientas de desarrollo abiertas) |
| Placa | Intel H81 |
| Disco sistema | NVMe Micron 2210, 477 GB — libre 331,1 GB |
| Disco proyecto | HDD Toshiba MQ04ABF1, 932 GB — partición `G:` 443 GB, libre 211,3 GB |
| Pagefile | 10 GB en `C:` (SSD), 1,58 GB en uso |
| Plan de energía | **Equilibrado** |
| Arranque automático | Ollama, Chrome, Edge, SPDriverInstall |
| Servicios | SysMain activo; WSearch y DiagTrack ya desactivados |

### 2.2 Aplicación

| Elemento | Valor |
|---|---|
| Tamaño del proyecto | ~1,52 GB |
| `node_modules` | 710,7 MB |
| `flutter_whatsapp_bot` (incluye `build`) | 376,7 MB |
| `dist` | 343,1 MB |
| `wa-session` | 49,4 MB |
| `logs` | 30,2 MB (20 MB rotados de julio) |
| `.wwebjs_cache` | 6,6 MB |
| Base de datos | `tecnitec_v31.db` 296 KB · WAL 684 KB · SHM 32 KB |
| Tablas / índices | 22 tablas · 16 índices · integridad `ok` · freelist 6/88 páginas (6,8 %) |
| Código | `server.js` 2.523 líneas · `main.js` 894 · `index.html` 10.602 líneas / 643 KB |
| Electron / builder | Electron 28 · electron-builder 24 |
| Splash | mínimo forzado de **5 s** |
| Polling activo | QR 5 s (×2 requests) · métricas 10 s (×2) · webview 3 s · `scan()` 3 s + MutationObserver · IA 30 s · auto-respuestas 30 s · plantillas 60 s |
| Bot WhatsApp | `setTimeout(_iniciarWABot, 5000)` en `server.js:2463` (headless) + `<webview>` en la UI |

**No medido todavía:** tiempo de arranque real, RSS de la app, latencia p95 de API y CPU en reposo. La Fase 0 incluye capturar esa línea base antes de tocar nada.

---

## 3. Hallazgos priorizados

| ID | Hallazgo | Evidencia | Impacto | Esfuerzo | Prioridad |
|---|---|---|---|---|---|
| H-01 | Proyecto y datos en HDD | `G:` es Toshiba HDD; 711 MB de `node_modules`; `wa-session` y DB en `G:` en modo dev/portable | Alto | Bajo | **P0** |
| H-02 | RAM escasa y single-channel + bloat de arranque | 1,27 GB libres; Chrome+Edge ≈ 650 MB; Ollama en startup | Alto | Bajo | **P0** |
| H-03 | Dos stacks de WhatsApp simultáneos | `server.js:2463` inicia Chrome headless; `index.html:8324` crea webview de WhatsApp Web | Alto | Medio | **P0** |
| H-04 | Lanzador reconstruye el módulo nativo en cada inicio | `LANZAR_TECNITEC.bat:32-43` ejecuta `npm run rebuild` siempre | Alto | Bajo | **P0** |
| H-05 | `--disable-disk-cache` en Chromium | `LANZAR_TECNITEC.bat:60` | Medio | Bajo | **P0** |
| H-06 | Logging síncrono por cada `console` del renderer | `main.js:76-81` (`appendFileSync`) + `main.js:664-668`; los polls imprimen cada 5 s | Alto | Bajo | **P0** |
| H-07 | Splash fijo de 5 s | `main.js:261` | Medio | Bajo | **P0** |
| H-08 | SQLite sin pragmas de rendimiento ni cierre limpio | `server.js:331-335`; WAL 684 KB > DB 296 KB; no hay handler `SIGTERM` | Medio | Bajo | **P0** |
| H-09 | Polling redundante | `index.html:8354` (3 s), `:8395` (30 s), `:8402` (10 s), `:8474` (5 s), `:10583` (3 s) + MutationObserver | Alto | Medio | **P1** |
| H-10 | Electron 28 EOL y paquete sin `asar` | `package.json`; `asar: false`; `node_modules/**/*` en `files` | Medio | Alto | **P1** |
| H-11 | Dependencias y bot Flutter muertos | `flutter_whatsapp_bot` apunta a `wa-engine.js` inexistente; UI nunca llama a `/api/wa-bot/connect` | Medio | Bajo | **P1** |
| H-12 | Backup diario síncrono al iniciar | `server.js:760-782`; `db.backup()` bloquea el event loop | Medio | Bajo | **P1** |
| H-13 | `index.html` monolítico | 643 KB, 10.602 líneas, 227 handlers inline, 94 KB en base64 | Medio | Alto | **P2** |
| H-14 | Búsquedas con `LIKE '%texto%'` | `server.js:978`, `:1014`, `:1413` no pueden usar índice | Bajo hoy | Medio | **P2** |
| H-15 | Sin observabilidad | No hay `/api/health` ni métricas de RSS/WAL/clientes WS | Medio | Bajo | **P1** |
| H-16 | Higiene de disco | 30 MB de logs viejos, 343 MB de `dist`, 377 MB de build Flutter, DB de 0 bytes | Bajo | Bajo | **P0** |
| H-17 | Plan de energía Equilibrado | `powercfg` | Bajo | Bajo | **P0** |

> **Nota H-03:** el bot headless no se inicia desde la UI, sino automáticamente desde `server.js:2463`. La UI solo consulta su QR (`index.html:8474`). Es intencional, pero conviene hacerlo opt-in.

---

## 4. Plan de acción por fases

### Fase 0 — Quick wins (día 1, 2–3 h)

| # | Acción | Dónde | Verificación |
|---|---|---|---|
| 0.1 | Crear copia de seguridad de la DB y un punto de restauración | `backups\pre-optimizacion.db` + `Checkpoint-Computer` | Archivo existe y abre |
| 0.2 | Medir línea base (script de la sección 10) | — | CSV/registro con T0 |
| 0.3 | Quitar Chrome, Edge y Ollama del arranque automático | Ver comandos §9.2 | `Win32_StartupCommand` sin esas entradas |
| 0.4 | Cambiar plan de energía a Alto rendimiento | `powercfg /setactive SCHEME_MIN` | `powercfg /getactivescheme` |
| 0.5 | Limpiar ~750 MB | Logs >30 días, `dist\win-unpacked`, `flutter_whatsapp_bot\build`, `.wwebjs_cache`, `tecnitec.db` (0 bytes) | Espacio liberado |
| 0.6 | Bajar splash de 5 s a 1,5 s | `main.js:261` | Arranque visible más rápido |
| 0.7 | Quitar `npm run rebuild` del lanzador y `--disable-disk-cache` | `LANZAR_TECNITEC.bat:32-43` y `:60` | Segundo arranque no recompila |
| 0.8 | Añadir pragmas SQLite y cierre limpio | `server.js:331-335` + handler `SIGTERM` | WAL ≤ 256 KB tras cerrar |
| 0.9 | Filtrar logs del renderer y escribir de forma asíncrona | `main.js:76-81`, `:664-668` | `electron-debug.log` deja de crecer por polls |
| 0.10 | Pausar polling cuando la ventana está oculta | `index.html` (helper §5.5) | CPU en reposo baja |

**Criterio de salida:** arranque perceptiblemente más rápido, sin regresiones funcionales, WAL limpio y logs acotados.

### Fase 1 — Semana 1: base de rendimiento (6–8 h)

1. **Mover el proyecto al SSD** (`C:\TECNITEC`), excluyendo `node_modules`, `dist` y `build` (se regeneran). Mantener `G:` intacto como respaldo hasta validar. Reinstalar dependencias y reconstruir el módulo nativo una sola vez.
2. **Logger asíncrono con rotación** en `main.js`: `fs.createWriteStream`, buffer, rotación a 5 MB, nivel `warn` en producción y sin `[RENDERER LOG]`.
3. **Consolidar polling** en `index.html`: QR 5 s → 20 s; métricas 10 s → 30 s; eliminar el `setInterval(scan, 3000)` y dejar solo MutationObserver con debounce de 500 ms; pausar todo con `document.hidden`.
4. **Mantenimiento de SQLite:** `PRAGMA optimize` al iniciar y semanal; `VACUUM` solo si freelist > 10 %; checkpoint `TRUNCATE` al cerrar; backup programado a las 03:00.
5. **Backup verificable:** probar restauración real en una carpeta temporal y documentar el procedimiento. Retención 14 diarios + 4 semanales.

**Criterio de salida:** cold start ≤ 10 s; WAL ≤ 256 KB; logs ≤ 40 MB; backup restaurado con éxito.

### Fase 2 — Semana 2: WhatsApp y empaquetado (8–12 h)

1. **Decidir un solo stack de WhatsApp** (decisión de producto, ver §7):
   - **Opción A (recomendada):** webview + monitor IA ya existente (`/api/webview/incoming-message`). Desactivar el bot headless.
   - **Opción B:** bot headless + UI propia, sin webview.
   - **Opción C (conservadora):** mantener ambos, pero arrancar el headless solo si `chatbot_config.bot_activo = '1'`, con apagado por inactividad y reciclado cada 24 h.
2. **Hacer opt-in el bot headless:** eliminar `setTimeout(_iniciarWABot, 5000)` y arrancarlo desde el endpoint o desde configuración.
3. **Eliminar dependencias muertas** tras validar: `whatsapp-web.js`, `puppeteer-core`, `qrcode` (si se elige A) y el proyecto Flutter completo (conservar solo fuente si se quiere archivar).
4. **Empaquetado:** `asar: true` con `asarUnpack` para `better-sqlite3`; quitar `node_modules/**/*` de `files`; `npm ci --omit=dev` en staging; excluir `dist`, `logs`, `backups`, `wa-session`, `.git`, Flutter.
5. **Actualizar Electron** (28 → última estable soportada) y `electron-builder`; reconstruir `better-sqlite3`; probar webview, SQLite y actualizaciones.
6. **No incluir la DB con datos reales** en el instalador: enviar esquema vacío y crear/migrar en el primer arranque.

**Criterio de salida:** una sola sesión de WhatsApp activa; paquete ≤ 200 MB descomprimido; instalador probado en máquina limpia.

### Fase 3 — Semana 3–4: mantenibilidad y observabilidad (12–16 h)

1. **Modularizar `index.html`:** extraer CSS y JS a `assets/`, separar por dominio (ventas, órdenes, WhatsApp, configuración). No es solo estética: reduce el parseo inicial y hace medible cada módulo.
2. **Observabilidad:** añadir `GET /api/health` con uptime, RSS, heap, tamaño de DB/WAL, clientes WS y estado de WhatsApp. Log de arranque con tiempos por etapa.
3. **Presupuesto de rendimiento:** script que mida cold start, RSS y p95 de los 10 endpoints principales; ejecutarlo antes/después de cada release.
4. **CI de build:** `npm ci`, rebuild, smoke test de arranque y publicación del artefacto. Evita que el lanzador tenga que recompilar en la máquina del usuario.
5. **FTS5** para búsquedas de clientes/órdenes cuando la tabla supere ~10.000 filas; añadir índices compuestos según consultas reales (`ordenes(estado, fecha_hora)`, `ventas(fecha, estado)`).

### Fase 4 — Hardware y SO (paralelo, 1–2 h + compra)

1. **16 GB RAM (2×8 GB DDR3-1600):** la mejora más rentable. Pasa de single-channel a dual-channel y elimina el pagefile como muleta. La placa H81 tiene 4 ranuras y admite 32 GB.
2. **Mantener proyecto y datos en SSD.** Si el HDD se usa para backups, verificar SMART y reemplazarlo si aparecen sectores reasignados.
3. **Mantenimiento Windows:** actualizaciones acumulativas, `cleanmgr`/Storage Sense, TRIM semanal en `C:`, revisar temperatura y pasta térmica del i3-4130 (2013).
4. **Opcional:** un i5-4570/4670 o i7-4770 de segunda mano duplica los núcleos reales y estira la vida del equipo.

---

## 5. Cambios concretos de código

### 5.1 `server.js` — pragmas de SQLite

```js
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');   // seguro con WAL; no protege la última transacción ante corte de luz
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('cache_size = -16000');    // ~16 MB
db.pragma('temp_store = MEMORY');
db.pragma('mmap_size = 67108864');   // 64 MB
```

### 5.2 `server.js` — cierre limpio

```js
let _cerrando = false;

async function cerrarServidor(signal) {
  if (_cerrando) return;
  _cerrando = true;
  logger.info(`[Proceso] Cerrando por ${signal}...`);
  try { if (waClient) await waClient.destroy(); } catch (_) {}
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
  try { db.close(); } catch (_) {}
  if (global._wss) {
    for (const ws of global._wss.clients) {
      try { ws.close(1001, 'Servidor cerrando'); } catch (_) {}
    }
  }
  process.exit(0);
}

process.on('SIGTERM', () => cerrarServidor('SIGTERM'));
process.on('SIGINT',  () => cerrarServidor('SIGINT'));
```

> `main.js` ya envía `serverProcess.kill()` (SIGTERM) al cerrar; hoy el servidor no lo escucha, por eso queda WAL sucio.

### 5.3 `server.js` — bot headless opt-in

```js
// Reemplazar: setTimeout(_iniciarWABot, 5000);
const botActivo = await dbGet("SELECT valor FROM chatbot_config WHERE clave='bot_activo'");
if (botActivo?.valor === '1') setTimeout(_iniciarWABot, 5000);
```

Añadir apagado por inactividad (por ejemplo, 30 min sin mensajes) y reciclado diario para liberar memoria de Chromium.

### 5.4 `main.js` — logger asíncrono y filtrado

```js
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

function writeLog(message) {
  try { logStream.write(`[${new Date().toISOString()}] ${message}\n`); } catch (_) {}
}

// En producción, no volcar cada console.log del renderer:
mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
  if (level < 2) return; // solo WARN y ERROR
  writeLog(`[RENDERER] ${message} (${path.basename(sourceId)}:${line})`);
});
```

Añadir rotación: si `electron-debug.log` supera 5 MB, renombrar a `.1` y truncar.

### 5.5 `index.html` — polling consciente de visibilidad

```js
function crearPoll(fn, ms) {
  let id = null;
  const tick = () => { if (!document.hidden) fn(); };
  const start = () => { if (!id) id = setInterval(tick, ms); };
  const stop  = () => { if (id) { clearInterval(id); id = null; } };
  document.addEventListener('visibilitychange', () => document.hidden ? stop() : start());
  start();
  return { stop, start };
}
```

Aplicarlo a QR (20 s), métricas (30 s) y estado de IA (60 s).

### 5.6 `LANZAR_TECNITEC.bat`

- Eliminar el bloque `npm run rebuild` de cada arranque. Dejarlo como paso manual (`npm run rebuild`) o dentro de `postinstall`, y ejecutarlo solo cuando cambie la versión de Electron.
- Quitar `--disable-disk-cache` de la línea 60.
- Mantener `--no-sandbox` solo si es imprescindible; idealmente probar sin él.

---

## 6. KPIs y criterios de aceptación

| KPI | Base T0 | Meta | Método |
|---|---|---|---|
| Arranque en frío (hasta ventana visible) | Por medir | ≤ 8 s | Cronómetro + log de etapas |
| Servidor listo | Por medir | ≤ 2,5 s | Timestamp en `server.js` |
| RSS app sin panel WhatsApp | Por medir | ≤ 500 MB | Administrador de tareas / `Get-Process` |
| RSS app con WhatsApp | Por medir | ≤ 1,2 GB | Ídem |
| Latencia p95 API local | Por medir | ≤ 100 ms | Script de carga §10 |
| WAL tras cierre limpio | 684 KB | ≤ 256 KB | `PRAGMA wal_checkpoint` / tamaño de archivo |
| Escrituras de log por día | ~35.000 | < 1.000 | Contar líneas de `electron-debug.log` |
| Carpeta `logs` estable | 30,2 MB | ≤ 40 MB | Tamaño en disco |
| Paquete descomprimido | 343 MB | ≤ 200 MB | `dist\win-unpacked` |
| Errores no controlados en 72 h | Por medir | 0 | `errores.log` + `crash.log` |

**Aceptación global:** dos semanas consecutivas sin caídas del watchdog, sin crecimiento sostenido de RAM y con backups restaurables.

---

## 7. Decisiones pendientes y riesgos

### Decisión de producto: un solo stack de WhatsApp

| Opción | Ventaja | Coste | Riesgo |
|---|---|---|---|
| **A. Webview + monitor IA** (recomendada) | Una sola sesión; −250/450 MB; ya implementada | Revisar estabilidad del monitor inyectado | Medio: depende del DOM de WhatsApp Web |
| B. Solo bot headless | Más robusto para automatización | Hay que reconstruir la UI de chat manual | Alto esfuerzo |
| C. Ambos, con arranque condicional | Conserva funciones actuales | Complejidad y consumo | Bajo si se apaga por inactividad |

### Riesgos y mitigación

| Riesgo | Probabilidad | Impacto | Mitigación / rollback |
|---|---|---|---|
| Mover el proyecto rompe rutas o Git | Media | Alto | Copiar, no mover; validar; conservar `G:`; `git config --global --add safe.directory C:/TECNITEC` |
| Actualizar Electron rompe `better-sqlite3` o el webview | Media | Alto | Rama aparte; rebuild; prueba en máquina limpia; rollback al instalador anterior |
| `synchronous=NORMAL` pierde la última transacción ante corte | Baja | Medio | Si se exige durabilidad total, mantener `FULL`; el backup diario cubre el resto |
| Eliminar `whatsapp-web.js` deja funciones sin soporte | Media | Medio | Validar que ningún cliente externo llame a `/api/wa-bot/*`; conservar rama de rollback |
| `asar` rompe el módulo nativo | Baja | Medio | `asarUnpack` para `better-sqlite3`; probar instalador |
| Limpieza borra artefactos necesarios | Baja | Bajo | `-WhatIf` primero; `dist` y `build` son regenerables |

---

## 8. Cronograma

| Semana | Fase | Esfuerzo | Entregable |
|---|---|---|---|
| 1 | Fase 0 + inicio Fase 1 | 6–8 h | Quick wins, línea base, proyecto en SSD |
| 2 | Fase 1 | 6–8 h | Logging, polling, DB y backups optimizados |
| 3 | Fase 2 | 8–12 h | Un solo WhatsApp, dependencias limpias, paquete ≤ 200 MB |
| 4 | Fase 3 | 12–16 h | UI modular, `/api/health`, CI y presupuesto de rendimiento |
| Paralelo | Fase 4 | 1–2 h + compra | 16 GB RAM, mantenimiento del host |

**Total estimado:** 30–40 h de trabajo técnico distribuidas en 4 semanas.

---

## 9. Checklist de ejecución

### 9.1 Antes de tocar nada

```powershell
# Copia de seguridad de la base y del proyecto
Copy-Item G:\30.03.26\tecnitec_v31.db G:\30.03.26\backups\pre-optimizacion.db
Checkpoint-Computer -Description "Antes de optimizacion TECNITEC" -RestorePointType MODIFY_SETTINGS
```

### 9.2 Arranque de Windows y energía

```powershell
# Ver entradas de inicio
Get-CimInstance Win32_StartupCommand | Format-Table Name, Command -AutoSize

# Quitar auto-inicio de Chrome y Edge (HKCU)
$run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
(Get-Item $run).Property |
  Where-Object { $_ -match 'ChromeAutoLaunch|EdgeAutoLaunch' } |
  ForEach-Object { Remove-ItemProperty $run -Name $_ }

# Quitar Ollama del arranque (si no se usa a diario)
Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Ollama.lnk" -ErrorAction SilentlyContinue

# Plan de energía Alto rendimiento
powercfg /setactive SCHEME_MIN
powercfg /getactivescheme
```

### 9.3 Limpieza (usar `-WhatIf` primero)

```powershell
$root = 'G:\30.03.26'

Get-ChildItem "$root\logs" -File |
  Where-Object LastWriteTime -lt (Get-Date).AddDays(-30) |
  Remove-Item -WhatIf

Remove-Item "$root\dist\win-unpacked" -Recurse -WhatIf
Remove-Item "$root\flutter_whatsapp_bot\build" -Recurse -WhatIf
Remove-Item "$root\.wwebjs_cache" -Recurse -WhatIf
Remove-Item "$root\tecnitec.db" -WhatIf   # 0 bytes
```

### 9.4 Migración al SSD

```powershell
# Con la aplicación cerrada
robocopy "G:\30.03.26" "C:\TECNITEC" /E /COPYALL /R:1 /W:1 `
  /XD node_modules dist ".git" "flutter_whatsapp_bot\build"

cd C:\TECNITEC
npm ci
npm run rebuild
git config --global --add safe.directory C:/TECNITEC
```

### 9.5 Verificación posterior

```powershell
# WAL y tamaño de la base
Get-ChildItem C:\TECNITEC\tecnitec_v31.db* | Select-Object Name, Length

# RAM de la app
Get-Process electron, "TECNITEC CORE" -ErrorAction SilentlyContinue |
  Select-Object Name, @{n='RAM_MB';e={[math]::Round($_.WorkingSet64/1MB)}}

# Logs
Get-ChildItem C:\TECNITEC\logs -File | Measure-Object Length -Sum |
  Select-Object @{n='MB';e={[math]::Round($_.Sum/1MB,1)}}
```

---

## 10. Anexo: protocolo de medición

Para que las metas sean verificables, medir siempre en las mismas condiciones (app cerrada, 2 minutos de reposo, sin herramientas de desarrollo):

1. **Cold start:** cronometrar desde el doble clic hasta que la ventana principal es visible. Repetir 3 veces y promediar.
2. **RSS:** `Get-Process` sobre el proceso principal + hijos (`electron`/`TECNITEC CORE`, `node`, `chrome` del bot). Medir a los 2 y a los 10 minutos.
3. **API:** script con 200 requests a `/api/health`, `/api/clientes`, `/api/ordenes`, `/api/ventas`; reportar p50/p95.
4. **Disco:** tamaño de `tecnitec_v31.db`, `-wal`, `-shm` y `logs` antes/después de un cierre limpio.
5. **Errores:** contar líneas `ERROR` en `logs\errores.log` y en `crash.log` durante 72 h.

Guardar cada corrida en `logs\perf-YYYY-MM-DD.json` para comparar releases.

---

## 11. Hallazgos colaterales (no son rendimiento, pero conviene atender)

- **`tecnitec_v31.db` con datos reales se incluye en el instalador** (`package.json`, `files`). Debería enviarse un esquema vacío.
- **`.jwt_secret` está en la raíz del proyecto.** Sacarlo del repositorio y rotarlo.
- **`will-attach-webview` desactiva `webSecurity` para todos los webviews** (`main.js:543-556`). Acotarlo solo al dominio de WhatsApp.
- **La validación de licencia está omitida en `main.js:809`** (`global._licenciaInfo` falso). Si es intencional para desarrollo, aislarlo con `app.isPackaged`.
- **El repositorio Git reporta "dubious ownership"** al ejecutar comandos; agregar `safe.directory` para evitar fallos en scripts.

---

**Próximo paso sugerido:** aprobar Fase 0 y ejecutarla en una sola sesión de 2–3 h. Al finalizar, comparar contra la línea base y decidir la Opción A/B/C de WhatsApp antes de entrar en la Fase 2.
