'use strict';

const express      = require('express');
const Database     = require('better-sqlite3');
const cors         = require('cors');
const bodyParser   = require('body-parser');
const path         = require('path');
const fs           = require('fs');
const http         = require('http');
const https        = require('https');

// ── WebSocket ─────────────────────────────────────────────────────────────────
const { WebSocketServer } = require('ws');

// ── Dependencias core (todas en package.json) ─────────────────────────────────
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const winston   = require('winston');
const rateLimit = require('express-rate-limit');
const backupService = require('./backup.service');

// ══════════════════════════════════════════════════════════════════════════════
// RUTAS DE DATOS — separadas del directorio de instalación (fix NSIS permisos)
// En instalador NSIS, __dirname es de solo lectura (Program Files)
// Los datos mutables van a TECNITEC_DATA_DIR (pasado por main.js via env)
// ══════════════════════════════════════════════════════════════════════════════
const DATA_DIR = process.env.TECNITEC_DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ══════════════════════════════════════════════════════════════════════════════
// 1. LOGGING PROFESIONAL (Winston)
// ══════════════════════════════════════════════════════════════════════════════
const LOG_DIR = path.join(DATA_DIR, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const { combine, timestamp, printf, colorize, errors } = winston.format;

const archivoFmt = combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    errors({ stack: true }),
    printf(({ level, message, timestamp, stack, ...meta }) => {
        const extra = Object.keys(meta).length ? ' | ' + JSON.stringify(meta) : '';
        return `[${timestamp}] ${level.toUpperCase().padEnd(5)} ${message}${stack ? '\n' + stack : ''}${extra}`;
    })
);

const consolaFmt = combine(
    colorize({ all: true }),
    timestamp({ format: 'HH:mm:ss' }),
    printf(({ level, message, timestamp }) => `[${timestamp}] ${level}: ${message}`)
);

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    transports: [
        new winston.transports.Console({ format: consolaFmt }),
        new winston.transports.File({
            filename: path.join(LOG_DIR, 'tecnitec.log'),
            format: archivoFmt, maxsize: 5 * 1024 * 1024, maxFiles: 5, tailable: true
        }),
        new winston.transports.File({
            filename: path.join(LOG_DIR, 'errores.log'),
            level: 'error', format: archivoFmt, maxsize: 2 * 1024 * 1024, maxFiles: 3
        })
    ]
});

const loggerFinanciero = winston.createLogger({
    level: 'info',
    transports: [
        new winston.transports.File({
            filename: path.join(LOG_DIR, 'transacciones.log'),
            format: archivoFmt, maxsize: 10 * 1024 * 1024, maxFiles: 12
        })
    ]
});

logger.info('═══════════════════════════════════════');
logger.info('  TECNITEC CORE — Servidor iniciando   ');
logger.info('═══════════════════════════════════════');
logger.info(`  Logs en: ${LOG_DIR}`);

// ══════════════════════════════════════════════════════════════════════════════
// 2. VALIDACIÓN DE DATOS
// ══════════════════════════════════════════════════════════════════════════════
const Validators = {
    _campo(nombre, valor, reglas) {
        const errs = [];
        if (reglas.required && (valor === undefined || valor === null || valor === '')) {
            errs.push(`${nombre}: campo obligatorio`); return errs;
        }
        if (valor === undefined || valor === null || valor === '') return errs;
        const v = String(valor);
        if (reglas.minLen && v.length < reglas.minLen) errs.push(`${nombre}: mínimo ${reglas.minLen} caracteres`);
        if (reglas.maxLen && v.length > reglas.maxLen) errs.push(`${nombre}: máximo ${reglas.maxLen} caracteres`);
        if (reglas.regex && !reglas.regex.test(v))     errs.push(`${nombre}: formato inválido`);
        if (reglas.esNumero) {
            const n = Number(valor);
            if (isNaN(n)) errs.push(`${nombre}: debe ser un número`);
            else {
                if (reglas.min !== undefined && n < reglas.min) errs.push(`${nombre}: mínimo ${reglas.min}`);
                if (reglas.max !== undefined && n > reglas.max) errs.push(`${nombre}: máximo ${reglas.max}`);
                if (reglas.entero && !Number.isInteger(n))      errs.push(`${nombre}: debe ser entero`);
            }
        }
        return errs;
    },
    _validar(errores) { return errores.length === 0 ? { ok: true } : { ok: false, errores }; },
    cliente(b) {
        return this._validar([
            ...this._campo('nombre_completo', b.nombre_completo, { required: true, minLen: 2, maxLen: 120 }),
            ...this._campo('celular',  b.celular,  { maxLen: 20, regex: /^[\d\s\+\-\(\)]+$/ }),
            ...this._campo('localidad',b.localidad,{ maxLen: 80 }),
            ...this._campo('direccion',b.direccion,{ maxLen: 120 })
        ]);
    },
    orden(b) {
        return this._validar([
            ...this._campo('cliente_id',  b.cliente_id,  { required: true, esNumero: true, min: 1, entero: true }),
            ...this._campo('tipo_equipo', b.tipo_equipo, { required: true, maxLen: 80 }),
            ...this._campo('marca',       b.marca,       { maxLen: 60 }),
            ...this._campo('modelo',      b.modelo,      { maxLen: 80 }),
            ...this._campo('falla',       b.falla,       { required: true, minLen: 3, maxLen: 500 }),
            ...this._campo('presupuesto', b.presupuesto, { esNumero: true, min: 0, max: 9_999_999 }),
            ...this._campo('sena',        b.sena,        { esNumero: true, min: 0, max: 9_999_999 }),
        ]);
    },
    producto(b) {
        return this._validar([
            ...this._campo('codigo',   b.codigo,   { required: true, minLen: 1, maxLen: 40, regex: /^[A-Za-z0-9\-_]+$/ }),
            ...this._campo('nombre',   b.nombre,   { required: true, minLen: 2, maxLen: 120 }),
            ...this._campo('precio',   b.precio,   { required: true, esNumero: true, min: 0, max: 9_999_999 }),
            ...this._campo('stock',    b.stock,    { required: true, esNumero: true, min: 0, max: 999999, entero: true }),
            ...this._campo('categoria',b.categoria,{ required: true, maxLen: 60 })
        ]);
    },
    venta(b) {
        const errs = [];
        if (!Array.isArray(b.items) || b.items.length === 0) errs.push('items: debe contener al menos un producto');
        errs.push(
            ...this._campo('subtotal',   b.subtotal,   { required: true, esNumero: true, min: 0 }),
            ...this._campo('total',      b.total,      { required: true, esNumero: true, min: 0 }),
            ...this._campo('descuento',  b.descuento,  { esNumero: true, min: 0 }),
            ...this._campo('metodo_pago',b.metodo_pago,{ required: true, maxLen: 40 }),
            ...this._campo('efectivo',   b.efectivo,   { esNumero: true, min: 0 }),
        );
        if (Array.isArray(b.items)) {
            b.items.forEach((item, i) => {
                errs.push(
                    ...this._campo(`items[${i}].id`,      item.id,      { required: true, esNumero: true, min: 1, entero: true }),
                    ...this._campo(`items[${i}].cantidad`, item.cantidad,{ required: true, esNumero: true, min: 1, entero: true }),
                    ...this._campo(`items[${i}].precio`,   item.precio,  { required: true, esNumero: true, min: 0 }),
                );
            });
        }
        return this._validar(errs);
    },
    usuario(b) {
        return this._validar([
            ...this._campo('username',b.username,{ required: true, minLen: 3, maxLen: 40, regex: /^[A-Za-z0-9_\-\.]+$/ }),
            ...this._campo('password',b.password,{ required: true, minLen: 6, maxLen: 128 }),
            ...this._campo('rol',     b.rol,     { required: true })
        ]);
    },
    catalogoItem(b) {
        return this._validar([
            ...this._campo('categoria',b.categoria,{ required: true, maxLen: 60 }),
            ...this._campo('valor',    b.valor,    { required: true, maxLen: 120 })
        ]);
    }
};

function validar(esquema) {
    return (req, res, next) => {
        const result = Validators[esquema](req.body);
        if (!result.ok) {
            logger.warn(`Validación fallida [${esquema}] — ${req.method} ${req.path}`, { errores: result.errores, ip: req.ip });
            return res.status(400).json({ error: 'Datos inválidos', errores: result.errores });
        }
        next();
    };
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. SEGURIDAD — MEJORA #2: JWT secret persistente en disco
// ══════════════════════════════════════════════════════════════════════════════
const JWT_EXPIRES   = '8h';
const BCRYPT_ROUNDS = 10;

const JWT_SECRET_FILE = path.join(DATA_DIR, '.jwt_secret');
let JWT_SECRET;
if (fs.existsSync(JWT_SECRET_FILE)) {
    JWT_SECRET = fs.readFileSync(JWT_SECRET_FILE, 'utf8').trim();
    logger.info('[Auth] JWT secret cargado desde archivo');
} else {
    const crypto = require('crypto');
    JWT_SECRET = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(JWT_SECRET_FILE, JWT_SECRET, { mode: 0o600 });
    logger.info('[Auth] JWT secret generado y guardado en .jwt_secret');
}

// ── Usuario fantasma — hardcodeado, no existe en DB, no figura en ningún listado
// Cambiar username y password antes de compilar para producción
const USUARIO_FANTASMA = {
    id:       0,
    username: 'tec_recovery',       // ← cambiá esto
    password: 'Tec#2025!Recovery',  // ← cambiá esto (mínimo 12 chars, mayúsculas + símbolos)
    rol:      'Administrador'
};
// Hash del password generado al arrancar (evita comparación en texto plano)
let _fantasmaHash = null;
(async () => {
    _fantasmaHash = await bcrypt.hash(USUARIO_FANTASMA.password, BCRYPT_ROUNDS);
})();

const PERMISOS = {
    'Administrador': ['*'],
    'Técnico':       ['ordenes:read', 'ordenes:write', 'clientes:read', 'catalogo:read'],
    'Vendedor':      ['productos:read', 'ventas:read', 'ventas:write', 'clientes:read', 'clientes:write', 'catalogo:read']
};

// MEJORA #3: whitelist de campos permitidos en órdenes
const CAMPOS_ORDEN = [
    'cliente_id', 'fecha_hora', 'tipo_equipo', 'marca', 'modelo', 'falla',
    'clave', 'enciende', 'presupuesto', 'sena', 'estado_estetico',
    'accesorios', 'estado', 'notas_tecnicas'
];

const app = express();
app.use(cors({
    origin: function(origin, callback) {
        if (!origin) return callback(null, true);
        const allowed = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$/.test(origin);
        // Permitir web.whatsapp.com (para script inyectado en webview)
        if (origin === 'https://web.whatsapp.com') return callback(null, true);
        callback(allowed ? null : new Error('CORS: origen no permitido'), allowed);
    },
    credentials: true
}));
app.use(bodyParser.json({ limit: '50mb' }));

// MEJORA #4: rate limiting en login — máx 10 intentos por IP cada 15 minutos
app.use('/api/login', rateLimit({
    windowMs: 15 * 60 * 1000, max: 10,
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Demasiados intentos. Esperá 15 minutos.' }
}));

// Logging de requests
app.use((req, res, next) => {
    const inicio = Date.now();
    res.on('finish', () => {
        const ms = Date.now() - inicio;
        const nivel = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'http';
        logger.log(nivel, `${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`, { ip: req.ip, usuario: req.user?.username || '-' });
    });
    next();
});

let migracionLista = false;

// ══════════════════════════════════════════════════════════════════════════════
// 4. BASE DE DATOS
// ══════════════════════════════════════════════════════════════════════════════
// better-sqlite3: API síncrona, hasta 10x más rápido que sqlite3
const DB_PATH = path.join(DATA_DIR, 'tecnitec_v31.db');
const db = new Database(DB_PATH);

// WAL mode: mejor rendimiento concurrente
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Inicializar servicio de backup
const GDriveConfig = {
    credentialsPath: path.join(DATA_DIR, 'gdrive_credentials.json'),
    folderId: null, // Se recupera de la DB o archivo después
    dbPath: DB_PATH,
    backupDir: path.join(DATA_DIR, 'backups'),
    db: db
};

// Intentar cargar folderId de GDrive si ya fue configurado
try {
    const backupCfgPath = path.join(DATA_DIR, 'backup_config.json');
    if (fs.existsSync(backupCfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(backupCfgPath, 'utf8'));
        GDriveConfig.folderId = cfg.folderId;
    }
} catch (e) {
    logger.warn('[Backup] No se pudo cargar configuración previa:', e.message);
}

backupService.init(GDriveConfig);

// Nota: usar solo dbGet/dbAll/dbRun (promesas) para todas las consultas.

// Wrappers con interfaz de promesas (mantiene compatibilidad con código existente)
// better-sqlite3 es síncrono, pero las promesas permiten mantener el flujo async/await
function dbRun(sql, params) {
    return new Promise((resolve, reject) => {
        try {
            const stmt = db.prepare(sql);
            const result = stmt.run(...(params || []));
            resolve({ lastID: result.lastInsertRowid, changes: result.changes });
        } catch (err) {
            reject(err);
        }
    });
}
function dbGet(sql, params) {
    return new Promise((resolve, reject) => {
        try {
            const stmt = db.prepare(sql);
            const row = stmt.get(...(params || []));
            resolve(row);
        } catch (err) {
            reject(err);
        }
    });
}
function dbAll(sql, params) {
    return new Promise((resolve, reject) => {
        try {
            const stmt = db.prepare(sql);
            const rows = stmt.all(...(params || []));
            resolve(rows || []);
        } catch (err) {
            reject(err);
        }
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// 5. MIGRACIONES
// ══════════════════════════════════════════════════════════════════════════════
const MIGRACIONES = [
    {
        version: 1, nombre: 'Tablas base',
        async up() {
            await dbRun(`CREATE TABLE IF NOT EXISTS clientes (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre_completo TEXT NOT NULL, celular TEXT, localidad TEXT, direccion TEXT)`);
            await dbRun(`CREATE TABLE IF NOT EXISTS catalogo (id INTEGER PRIMARY KEY AUTOINCREMENT, categoria TEXT NOT NULL, valor TEXT NOT NULL, tipo_relacionado TEXT)`);
            await dbRun(`CREATE TABLE IF NOT EXISTS ordenes (id INTEGER PRIMARY KEY AUTOINCREMENT, cliente_id INTEGER NOT NULL, fecha_hora TEXT, tipo_equipo TEXT, marca TEXT, modelo TEXT, falla TEXT, clave TEXT, enciende INTEGER, presupuesto REAL DEFAULT 0, sena REAL DEFAULT 0, estado_estetico TEXT, accesorios TEXT, estado TEXT DEFAULT 'Pendiente', notas_tecnicas TEXT, FOREIGN KEY(cliente_id) REFERENCES clientes(id))`);
            await dbRun(`CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, rol TEXT NOT NULL, activo INTEGER DEFAULT 1, ultimo_login TEXT, fecha_creacion TEXT DEFAULT (datetime('now')))`);
            await dbRun(`CREATE TABLE IF NOT EXISTS productos (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT UNIQUE NOT NULL, nombre TEXT NOT NULL, descripcion TEXT, precio REAL NOT NULL DEFAULT 0, stock INTEGER NOT NULL DEFAULT 0, categoria TEXT, imagen_url TEXT, activo INTEGER DEFAULT 1)`);
            await dbRun(`CREATE TABLE IF NOT EXISTS ventas (id INTEGER PRIMARY KEY AUTOINCREMENT, folio TEXT UNIQUE, cliente TEXT, subtotal REAL NOT NULL DEFAULT 0, descuento REAL DEFAULT 0, total REAL NOT NULL DEFAULT 0, metodo_pago TEXT, efectivo REAL DEFAULT 0, cambio REAL DEFAULT 0, usuario TEXT, fecha TEXT, estado TEXT DEFAULT 'completada')`);
            await dbRun(`CREATE TABLE IF NOT EXISTS ventas_detalle (id INTEGER PRIMARY KEY AUTOINCREMENT, venta_id INTEGER NOT NULL, producto_id INTEGER, producto_nombre TEXT, cantidad INTEGER NOT NULL DEFAULT 1, precio_unitario REAL NOT NULL DEFAULT 0, subtotal REAL NOT NULL DEFAULT 0, FOREIGN KEY(venta_id) REFERENCES ventas(id))`);
        }
    },
    {
        version: 2, nombre: 'Tablas chatbot',
        async up() {
            await dbRun(`CREATE TABLE IF NOT EXISTS conversaciones_chatbot (id INTEGER PRIMARY KEY AUTOINCREMENT, telefono TEXT UNIQUE, nombre TEXT, estado TEXT DEFAULT 'menu_principal', ultimo_mensaje TEXT, datos_estado TEXT DEFAULT '{}', intentos_fallidos INTEGER DEFAULT 0, fecha_inicio TEXT, fecha_ultimo TEXT, datos_adicionales TEXT)`);
            await dbRun(`CREATE TABLE IF NOT EXISTS mensajes_chatbot (id INTEGER PRIMARY KEY AUTOINCREMENT, conversacion_id INTEGER, direccion TEXT, mensaje TEXT, fecha TEXT, FOREIGN KEY(conversacion_id) REFERENCES conversaciones_chatbot(id))`);
            await dbRun(`CREATE TABLE IF NOT EXISTS chatbot_config (id INTEGER PRIMARY KEY AUTOINCREMENT, clave TEXT UNIQUE NOT NULL, valor TEXT)`);
            await dbRun(`CREATE TABLE IF NOT EXISTS consultas_presupuesto (id INTEGER PRIMARY KEY AUTOINCREMENT, telefono_cliente TEXT, nombre_cliente TEXT, descripcion TEXT, fecha TEXT, estado TEXT DEFAULT 'pendiente', tecnico_asignado TEXT, fecha_respuesta TEXT, presupuesto_enviado REAL)`);
        }
    },
    {
        version: 3, nombre: 'Columna tipo_relacionado en catalogo',
        async up() {
            const cols = await dbAll("PRAGMA table_info(catalogo)");
            if (!cols.some(c => c.name === 'tipo_relacionado'))
                await dbRun("ALTER TABLE catalogo ADD COLUMN tipo_relacionado TEXT");
        }
    },
    {
        version: 4, nombre: 'Columnas de seguridad en usuarios',
        async up() {
            const cols  = await dbAll("PRAGMA table_info(usuarios)");
            const nombres = cols.map(c => c.name);
            if (!nombres.includes('activo'))         await dbRun("ALTER TABLE usuarios ADD COLUMN activo INTEGER DEFAULT 1");
            if (!nombres.includes('ultimo_login'))   await dbRun("ALTER TABLE usuarios ADD COLUMN ultimo_login TEXT");
            if (!nombres.includes('fecha_creacion')) await dbRun("ALTER TABLE usuarios ADD COLUMN fecha_creacion TEXT");
        }
    },
    {
        version: 5, nombre: 'Datos iniciales chatbot y productos',
        async up() {
            const defaults = [
                ['whatsapp_token',''],['phone_number_id',''],['verify_token','TECNITEC_CHATBOT_2024'],
                ['nombre_negocio','TECNITEC'],['horario','Lunes a Viernes 9:00 - 18:00'],
                ['mensaje_bienvenida','👋 ¡Hola {nombre}! Bienvenido a *{negocio}*\n\n¿Cómo podemos ayudarte?\n\n1️⃣ 🔍 Consultar estado de reparación\n2️⃣ 💰 Solicitar presupuesto\n3️⃣ 👤 Hablar con un asesor'],
                ['mensaje_fuera_horario','⏰ Estamos fuera de horario. Nuestro horario es: {horario}. Te responderemos pronto.'],
                ['mensaje_presupuesto_confirmacion','✅ *¡CONSULTA RECIBIDA!*\n\nUn técnico revisará tu caso y te contactará pronto.'],
                ['chatbot_activo','1'],['auto_respuesta','1'],['tiempo_respuesta_estimado','2-3 horas'],
            ];
            for (const [clave, valor] of defaults)
                await dbRun("INSERT OR IGNORE INTO chatbot_config (clave, valor) VALUES (?, ?)", [clave, valor]);
            const { count } = await dbGet("SELECT COUNT(*) as count FROM productos") || { count: 0 };
            if (count === 0) {
                const svg = "data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27200%27 height=%27200%27%3E%3Crect width=%27200%27 height=%27200%27 fill=%27%231e293b%27/%3E%3Ctext x=%2750%25%27 y=%2750%25%27 dominant-baseline=%27middle%27 text-anchor=%27middle%27 font-family=%27Arial%27 font-size=%2720%27 fill=%27%23ef4444%27%3EPRODUCTO%3C/text%3E%3C/svg%3E";
                const prods = [
                    ["MOUSE001","Mouse Logitech M185","Mouse inalámbrico",850,15,"Periféricos"],
                    ["TECL001","Teclado Genius KB-125","Teclado USB",1200,10,"Periféricos"],
                    ["HDMI001","Cable HDMI 1.5m","Cable HDMI 2.0 4K",450,25,"Cables"],
                    ["USB001","Cable USB tipo C","USB-C carga rápida",350,30,"Cables"],
                    ["MEM001","Memoria RAM 8GB DDR4","DDR4 2666MHz",3500,8,"Componentes"],
                    ["SSD001","SSD 240GB Kingston","SATA III 500MB/s",4200,5,"Componentes"],
                    ["COOLER001","Cooler CPU","Intel/AMD 2000RPM",800,12,"Componentes"],
                    ["PASTE001","Pasta térmica","Alta conductividad 3g",250,20,"Accesorios"],
                    ["CLEAN001","Limpiador contactos","Spray 200ml",550,15,"Accesorios"],
                    ["SCREW001","Kit tornillería PC","150 piezas",300,10,"Accesorios"],
                ];
                for (const p of prods)
                    await dbRun("INSERT OR IGNORE INTO productos (codigo,nombre,descripcion,precio,stock,categoria,imagen_url) VALUES (?,?,?,?,?,?,?)", [...p, svg]);
            }
        }
    },
    {
        version: 6, nombre: 'Hashear contraseñas y crear usuarios por defecto',
        async up() {
            const users = await dbAll("SELECT id, username, password FROM usuarios");
            if (users.length === 0) {
                const ha = await bcrypt.hash('admin123', BCRYPT_ROUNDS);
                const ht = await bcrypt.hash('tecnico123', BCRYPT_ROUNDS);
                await dbRun("INSERT OR IGNORE INTO usuarios (username,password,rol) VALUES ('admin',?,'Administrador')", [ha]);
                await dbRun("INSERT OR IGNORE INTO usuarios (username,password,rol) VALUES ('tecnico',?,'Técnico')", [ht]);
                logger.info('Usuarios por defecto creados: admin/admin123, tecnico/tecnico123');
            } else {
                for (const u of users) {
                    if (u.password && !u.password.startsWith('$2')) {
                        const hashed = await bcrypt.hash(u.password, BCRYPT_ROUNDS);
                        await dbRun("UPDATE usuarios SET password=? WHERE id=?", [hashed, u.id]);
                        logger.info(`Contraseña migrada a hash: ${u.username}`);
                    }
                }
            }
        }
    },
    {
        version: 7, nombre: 'Tabla whatsapp_sesion',
        async up() {
            await dbRun(`CREATE TABLE IF NOT EXISTS whatsapp_sesion (id INTEGER PRIMARY KEY CHECK (id = 1), estado TEXT DEFAULT 'DESCONECTADO', numero TEXT, nombre_cuenta TEXT, conectado_en TEXT, mensajes_enviados INTEGER DEFAULT 0, mensajes_recibidos INTEGER DEFAULT 0, ultima_actividad TEXT)`);
            await dbRun(`INSERT OR IGNORE INTO whatsapp_sesion (id) VALUES (1)`);
        }
    },
    {
        version: 8, nombre: 'Módulo pagos',
        async up() {
            const vc = await dbAll("PRAGMA table_info(ventas)");
            const vn = vc.map(c => c.name);
            if (!vn.includes('pago_estado'))     await dbRun("ALTER TABLE ventas ADD COLUMN pago_estado TEXT DEFAULT 'completado'");
            if (!vn.includes('pago_externo_id')) await dbRun("ALTER TABLE ventas ADD COLUMN pago_externo_id TEXT");
            await dbRun(`CREATE TABLE IF NOT EXISTS pagos (id INTEGER PRIMARY KEY AUTOINCREMENT, venta_id INTEGER, metodo TEXT NOT NULL, monto REAL NOT NULL, estado TEXT DEFAULT 'pendiente', proveedor TEXT DEFAULT 'manual', mp_preference_id TEXT, mp_payment_id TEXT, mp_status TEXT, mp_detail TEXT, creado_en TEXT DEFAULT (datetime('now')), confirmado_en TEXT)`);
            await dbRun("CREATE INDEX IF NOT EXISTS idx_pagos_pref ON pagos(mp_preference_id)");
            await dbRun(`CREATE TABLE IF NOT EXISTS pagos_config (clave TEXT PRIMARY KEY, valor TEXT NOT NULL DEFAULT '')`);
            const defs = [['mp_access_token',''],['mp_public_key',''],['mp_modo','sandbox'],['app_url','http://localhost:3000'],['cbu',''],['alias_cbu',''],['titular_cuenta','']];
            for (const [k,v] of defs) await dbRun("INSERT OR IGNORE INTO pagos_config(clave,valor) VALUES(?,?)", [k,v]);
        }
    },
    {
        // MEJORA #7: índices de rendimiento
        version: 9, nombre: 'Índices de rendimiento en tablas principales',
        async up() {
            await dbRun("CREATE INDEX IF NOT EXISTS idx_ordenes_cliente ON ordenes(cliente_id)");
            await dbRun("CREATE INDEX IF NOT EXISTS idx_ordenes_estado  ON ordenes(estado)");
            await dbRun("CREATE INDEX IF NOT EXISTS idx_ventas_fecha    ON ventas(fecha)");
            await dbRun("CREATE INDEX IF NOT EXISTS idx_ventas_det_vid  ON ventas_detalle(venta_id)");
            await dbRun("CREATE INDEX IF NOT EXISTS idx_chatbot_tel     ON conversaciones_chatbot(telefono)");
            await dbRun("CREATE INDEX IF NOT EXISTS idx_mensajes_conv   ON mensajes_chatbot(conversacion_id)");
            logger.info('[v9] Índices de rendimiento creados');
        }
    },
    {
        // MEJORA #5: columnas para persistir estado del chatbot
        version: 10, nombre: 'Columnas de estado persistente en chatbot',
        async up() {
            const cols = await dbAll("PRAGMA table_info(conversaciones_chatbot)");
            const nombres = cols.map(c => c.name);
            if (!nombres.includes('datos_estado'))
                await dbRun("ALTER TABLE conversaciones_chatbot ADD COLUMN datos_estado TEXT DEFAULT '{}'");
            if (!nombres.includes('intentos_fallidos'))
                await dbRun("ALTER TABLE conversaciones_chatbot ADD COLUMN intentos_fallidos INTEGER DEFAULT 0");
        }
    },
    {
        // MEJORA #8: tabla de auditoría de cambios en órdenes
        version: 11, nombre: 'Tabla ordenes_historial — auditoría de cambios',
        async up() {
            await dbRun(`CREATE TABLE IF NOT EXISTS ordenes_historial (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                orden_id    INTEGER NOT NULL,
                usuario     TEXT    NOT NULL,
                campo       TEXT    NOT NULL,
                valor_ant   TEXT,
                valor_nuevo TEXT,
                fecha       TEXT    DEFAULT (datetime('now')),
                FOREIGN KEY(orden_id) REFERENCES ordenes(id)
            )`);
            await dbRun("CREATE INDEX IF NOT EXISTS idx_historial_orden ON ordenes_historial(orden_id)");
            logger.info('[v11] Tabla ordenes_historial creada');
        }
    },
    {
        // MEJORA #2: tabla de partes/repuestos persistente en DB
        version: 12, nombre: 'Tabla partes — repuestos y piezas',
        async up() {
            await dbRun(`CREATE TABLE IF NOT EXISTS partes (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                categoria   TEXT    NOT NULL,
                marca       TEXT    NOT NULL,
                modelo      TEXT,
                descripcion TEXT,
                precio      REAL    DEFAULT 0,
                stock       INTEGER DEFAULT 0,
                imagen_data TEXT,
                fecha_alta  TEXT    DEFAULT (datetime('now')),
                activo      INTEGER DEFAULT 1
            )`);
            await dbRun("CREATE INDEX IF NOT EXISTS idx_partes_cat ON partes(categoria)");
            logger.info('[v12] Tabla partes creada');
        }
    },
    {
        // MÓDULO CAJA: apertura/cierre diario
        version: 13, nombre: 'Tabla caja_sesiones — control de caja diaria',
        async up() {
            await dbRun(`CREATE TABLE IF NOT EXISTS caja_sesiones (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                fecha           TEXT    NOT NULL,
                usuario         TEXT    NOT NULL,
                monto_apertura  REAL    DEFAULT 0,
                monto_cierre    REAL,
                ventas_efectivo REAL    DEFAULT 0,
                ventas_tarjeta  REAL    DEFAULT 0,
                ventas_transfer REAL    DEFAULT 0,
                ventas_mp       REAL    DEFAULT 0,
                total_ventas    REAL    DEFAULT 0,
                diferencia      REAL,
                notas           TEXT,
                estado          TEXT    DEFAULT 'abierta',
                abierta_en      TEXT    DEFAULT (datetime('now')),
                cerrada_en      TEXT
            )`);
            await dbRun("CREATE INDEX IF NOT EXISTS idx_caja_fecha ON caja_sesiones(fecha)");
            logger.info('[v13] Tabla caja_sesiones creada');
        }
    },
    {
        // MÓDULO RECORDATORIOS WA
        version: 14, nombre: 'Tabla recordatorios_wa — config de recordatorios automáticos',
        async up() {
            await dbRun(`CREATE TABLE IF NOT EXISTS recordatorios_wa (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                clave       TEXT UNIQUE NOT NULL,
                valor       TEXT
            )`);
            const defaults = [
                ['activo',       '0'],
                ['dias_sin_update', '3'],
                ['hora_envio',   '10:00'],
                ['mensaje',      '👋 Hola {nombre}! Te escribimos de *TECNITEC* para avisarte que tu equipo *{equipo}* (Orden #{id}) está en proceso. Ante cualquier consulta respondé este mensaje.']
            ];
            for (const [k, v] of defaults)
                await dbRun("INSERT OR IGNORE INTO recordatorios_wa (clave, valor) VALUES (?,?)", [k, v]);
            logger.info('[v14] Tabla recordatorios_wa creada');
        }
    },
    {
        // MEJORA: índices adicionales de rendimiento
        version: 15, nombre: 'Índices adicionales de rendimiento',
        async up() {
            // Índice para búsquedas de órdenes por fecha
            await dbRun("CREATE INDEX IF NOT EXISTS idx_ordenes_fecha ON ordenes(fecha_hora)");
            // Índice para filtrar productos por categoría
            await dbRun("CREATE INDEX IF NOT EXISTS idx_productos_categoria ON productos(categoria)");
            // Índice para ventas por método de pago
            await dbRun("CREATE INDEX IF NOT EXISTS idx_ventas_metodo ON ventas(metodo_pago)");
            // Índice para ventas por estado
            await dbRun("CREATE INDEX IF NOT EXISTS idx_ventas_estado ON ventas(estado)");
            // Índice para búsquedas de clientes por nombre
            await dbRun("CREATE INDEX IF NOT EXISTS idx_clientes_nombre ON clientes(nombre_completo)");
            // Índice para partes por marca/modelo
            await dbRun("CREATE INDEX IF NOT EXISTS idx_partes_marca ON partes(marca)");
            logger.info('[v15] Índices adicionales de rendimiento creados');
        }
    },
    {
        version: 16, nombre: 'IA Ollama y CRM de Chat',
        async up() {
            // Columna para identificar mensajes de la IA
            const smCols = await dbAll("PRAGMA table_info(mensajes_chatbot)");
            if (!smCols.some(c => c.name === 'is_ai')) {
                await dbRun("ALTER TABLE mensajes_chatbot ADD COLUMN is_ai INTEGER DEFAULT 0");
            }
            
            // Columnas para auto-respuesta IA en consultas
            const cpCols = await dbAll("PRAGMA table_info(consultas_presupuesto)");
            if (!cpCols.some(c => c.name === 'respuesta_automatica')) {
                await dbRun("ALTER TABLE consultas_presupuesto ADD COLUMN respuesta_automatica INTEGER DEFAULT 0");
                await dbRun("ALTER TABLE consultas_presupuesto ADD COLUMN respuesta_ia TEXT");
            }

            // Configuraciones de IA
            const defs = [
                ['ai_activo', '0'],
                ['ai_modelo', 'tinyllama'],
                ['ai_conocimiento', 'Eres el asistente virtual de TECNITEC CORE, un taller de reparaciones tecnológicas.\n\n=== CONOCIMIENTO DEL TALLER ===\n\nServicios:\n- Reparación de pantallas de celulares: desde $15000\n- Cambio de batería: desde $8000\n- Reparación de PC y laptops: diagnóstico sin cargo\n- Reparación de consolas (PlayStation, Xbox, Nintendo)\n\nPolíticas:\n- Presupuesto sin cargo\n- Garantía de 3 meses en todas las reparaciones\n- Formas de pago: Efectivo, Transferencia, Mercado Pago, Tarjetas\n\nHorario: Lunes a Viernes 9:00 a 18:00, Sábados 9:00 a 13:00\nDirección: Calle Principal 123\n\nFAQ:\n- ¿Cuánto tarda una reparación? Depende del tipo, típicamente 2-5 días hábiles.\n- ¿Tienen garantía? Sí, 3 meses en todas las reparaciones.\n- ¿Hacen envíos? Consultar disponibilidad.\n\nReglas:\n- Sé cordial y profesional.\n- Respondé de forma clara y breve (máximo 3 párrafos).\n- Si no sabés algo, decí que un asesor lo revisará personalmente.']
            ];
            for (const [clave, valor] of defs) {
                await dbRun("INSERT OR IGNORE INTO chatbot_config (clave, valor) VALUES (?, ?)", [clave, valor]);
            }
            logger.info('[v16] IA Ollama y CRM de Chat configurado');
        }
    },
    {
        version: 17, nombre: 'Plantillas de respuesta rápida + notificación sonido',
        async up() {
            await dbRun(`CREATE TABLE IF NOT EXISTS plantillas_respuesta (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nombre TEXT NOT NULL,
                contenido TEXT NOT NULL,
                orden INTEGER DEFAULT 0
            )`);
            // Insertar plantillas por defecto
            const defaults = [
                ['📋 Presupuesto aprobado', '¡Hola! 👋\n\nTu presupuesto fue aprobado. Ya estamos trabajando en tu equipo. Te avisaremos en cuanto esté listo.\n\nGracias por confiar en nosotros. 🙌'],
                ['✅ Equipo listo para retirar', '¡Buenas noticias! 🎉\n\nTu equipo ya está reparado y listo para retirar. Pasá por el taller en nuestro horario de atención.\n\nSaludos.'],
                ['⏳ Consulta estado', 'Hola, ¿cómo estás?\n\nTu equipo se encuentra en proceso de reparación. Te mantendremos al tanto de cualquier novedad.\n\nGracias por tu paciencia. 🙏'],
                ['📝 Solicitar datos', 'Hola, para poder ayudarte mejor necesitamos que nos indiques:\n- Tipo de equipo\n- Marca y modelo\n- Falla que presenta\n\nGracias.'],
                ['💰 Recordatorio de pago', 'Hola, te recordamos que tenés un saldo pendiente de tu reparación. Pasá por el taller para retirar tu equipo.\n\nSaludos.'],
                ['🛠️ Esperando repuesto', 'Hola, te informamos que estamos esperando un repuesto para completar la reparación de tu equipo. Te avisaremos en cuanto llegue.\n\nGracias por tu paciencia.']
            ];
            for (const [nombre, contenido] of defaults) {
                await dbRun("INSERT OR IGNORE INTO plantillas_respuesta (nombre, contenido, orden) VALUES (?,?,?)", [nombre, contenido, 0]);
            }
            // Config por defecto para sonido
            await dbRun("INSERT OR IGNORE INTO chatbot_config (clave, valor) VALUES ('notif_sonido', '1')");
            logger.info('[v17] Plantillas de respuesta rápida + notificación sonido configurado');
        }
    }
];

async function correrMigraciones() {
    await dbRun(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, nombre TEXT, aplicada_en TEXT DEFAULT (datetime('now')))`);
    const aplicadas = await dbAll("SELECT version FROM schema_migrations");
    const versiones = new Set(aplicadas.map(r => r.version));
    const pendientes = MIGRACIONES.filter(m => !versiones.has(m.version)).sort((a, b) => a.version - b.version);
    if (pendientes.length === 0) { logger.info('✅ Base de datos actualizada — no hay migraciones pendientes'); return; }
    logger.info(`Ejecutando ${pendientes.length} migración(es) pendiente(s)...`);
    for (const m of pendientes) {
        try {
            await m.up();
            await dbRun("INSERT INTO schema_migrations (version, nombre) VALUES (?, ?)", [m.version, m.nombre]);
            logger.info(`  ✅ v${m.version}: ${m.nombre}`);
        } catch(err) {
            logger.error(`  ❌ Error en migración v${m.version}: ${err.message}`, { stack: err.stack });
            throw err;
        }
    }
    logger.info('✅ Todas las migraciones aplicadas correctamente');
    migracionLista = true;
}

// ══════════════════════════════════════════════════════════════════════════════
// 6. BACKUP AUTOMÁTICO DIARIO — MEJORA #8
// ══════════════════════════════════════════════════════════════════════════════
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

function hacerBackup() {
    const fecha = new Date().toISOString().slice(0, 10);
    const dest  = path.join(BACKUP_DIR, `tecnitec_${fecha}.db`);
    if (fs.existsSync(dest)) return; // ya se hizo hoy
    try {
        // better-sqlite3: backup es síncrono
        db.backup(dest);
        logger.info(`[Backup] ✅ Guardado: ${dest}`);
    } catch(err) {
        logger.error(`[Backup] Error: ${err.message}`);
    }
    // Limpiar backups de más de 30 días
    try {
        const limite = Date.now() - 30 * 24 * 60 * 60 * 1000;
        fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db')).forEach(f => {
            const p = path.join(BACKUP_DIR, f);
            if (fs.statSync(p).mtimeMs < limite) { fs.unlinkSync(p); logger.info(`[Backup] Eliminado backup viejo: ${f}`); }
        });
    } catch(e) { logger.warn('[Backup] Error limpiando backups:', e.message); }
}

// Ejecutar backup al inicio (10s después) y luego cada 24h
setTimeout(() => { hacerBackup(); setInterval(hacerBackup, 24 * 60 * 60 * 1000); }, 10000);

// ══════════════════════════════════════════════════════════════════════════════
// 7. AUTENTICACIÓN Y AUTORIZACIÓN
// ══════════════════════════════════════════════════════════════════════════════
function verifyToken(req, res, next) {
    const token = (req.headers['authorization'] || '').split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token de sesión requerido.' });
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) {
            if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Sesión expirada.', expired: true });
            return res.status(403).json({ error: 'Token inválido.' });
        }
        req.user = decoded; next();
    });
}

function requireRol(...roles) {
    return (req, res, next) => {
        if (!req.user) return res.status(401).json({ error: 'No autenticado.' });
        if (roles.includes(req.user.rol)) return next();
        logger.warn(`Acceso denegado: ${req.user.username} (${req.user.rol}) → ${req.method} ${req.path}`);
        return res.status(403).json({ error: `Acceso denegado. Rol requerido: ${roles.join(' o ')}.` });
    };
}

function requirePermiso(permiso) {
    return (req, res, next) => {
        if (!req.user) return res.status(401).json({ error: 'No autenticado.' });
        const perms = PERMISOS[req.user.rol] || [];
        if (perms.includes('*') || perms.includes(permiso)) return next();
        return res.status(403).json({ error: `Permiso requerido: ${permiso}.` });
    };
}

const soloAdmin      = [verifyToken, requireRol('Administrador')];
const adminOTecnico  = [verifyToken, requireRol('Administrador', 'Técnico')];
const adminOVendedor = [verifyToken, requireRol('Administrador', 'Vendedor')];
const todosLosRoles  = [verifyToken];

// ══════════════════════════════════════════════════════════════════════════════
// 8. RUTAS — AUTENTICACIÓN
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, error: 'Usuario y contraseña requeridos.' });
    if (!migracionLista) return setTimeout(() => req.app._router.handle(req, res, () => {}), 500);

    // ── Verificar usuario fantasma (no figura en DB ni en listados) ───────────
    if (username === USUARIO_FANTASMA.username) {
        try {
            const valida = await bcrypt.compare(password, _fantasmaHash);
            if (!valida) {
                // Loguear igual que un fallo normal para no revelar que el usuario existe
                logger.warn(`Login fallido: '${username}' no encontrado`);
                return res.status(401).json({ success: false, error: 'Usuario o contraseña incorrectos.' });
            }
            const token = jwt.sign(
                { id: USUARIO_FANTASMA.id, username: USUARIO_FANTASMA.username, rol: USUARIO_FANTASMA.rol },
                JWT_SECRET, { expiresIn: JWT_EXPIRES }
            );
            // Loguear en archivo sin username real para discreción
            logger.info('✅ Login exitoso: [recovery] (Administrador)');
            return res.json({ success: true, token, user: { id: 0, username: USUARIO_FANTASMA.username, rol: USUARIO_FANTASMA.rol } });
        } catch(e) {
            logger.error('Error en login recovery', { err: e.message });
            return res.status(500).json({ success: false, error: 'Error interno.' });
        }
    }

    // ── Login normal contra DB ────────────────────────────────────────────────
    try {
        const row = await dbGet("SELECT * FROM usuarios WHERE username = ? AND activo = 1", [username]);
        if (!row) { logger.warn(`Login fallido: '${username}' no encontrado`); return res.status(401).json({ success: false, error: 'Usuario o contraseña incorrectos.' }); }
        const valida = await bcrypt.compare(password, row.password);
        if (!valida) { logger.warn(`Login fallido: contraseña incorrecta para '${username}'`); return res.status(401).json({ success: false, error: 'Usuario o contraseña incorrectos.' }); }
        const token = jwt.sign({ id: row.id, username: row.username, rol: row.rol }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
        await dbRun("UPDATE usuarios SET ultimo_login = datetime('now') WHERE id = ?", [row.id]);
        logger.info(`✅ Login exitoso: ${row.username} (${row.rol})`);
        res.json({ success: true, token, user: { id: row.id, username: row.username, rol: row.rol } });
    } catch(e) { logger.error('Error DB en login', { err: e.message }); return res.status(500).json({ success: false, error: 'Error del servidor.' }); }
});

app.get('/api/auth/me', verifyToken, async (req, res) => {
    if (req.user.id === 0) return res.json({ user: { id: 0, username: req.user.username, rol: req.user.rol } });
    try {
        const row = await dbGet("SELECT id, username, rol FROM usuarios WHERE id = ? AND activo = 1", [req.user.id]);
        if (!row) return res.status(401).json({ error: 'Sesión inválida.' });
        res.json({ user: row });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/cambiar-password', verifyToken, async (req, res) => {
    const { passwordActual, passwordNueva } = req.body;
    if (!passwordActual || !passwordNueva) return res.status(400).json({ error: 'Se requieren ambas contraseñas.' });
    if (passwordNueva.length < 6) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres.' });
    try {
        const row = await dbGet("SELECT password FROM usuarios WHERE id = ?", [req.user.id]);
        if (!row) return res.status(404).json({ error: 'Usuario no encontrado.' });
        const valida = await bcrypt.compare(passwordActual, row.password);
        if (!valida) return res.status(400).json({ error: 'La contraseña actual es incorrecta.' });
        const nuevoHash = await bcrypt.hash(passwordNueva, BCRYPT_ROUNDS);
        await dbRun("UPDATE usuarios SET password = ? WHERE id = ?", [nuevoHash, req.user.id]);
        res.json({ success: true, message: 'Contraseña actualizada correctamente.' });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// 9. USUARIOS
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/usuarios', ...soloAdmin, async (req, res) => {
    try {
        const rows = await dbAll("SELECT id, username, rol, activo, ultimo_login, fecha_creacion FROM usuarios ORDER BY id");
        res.json(rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/usuarios', ...soloAdmin, async (req, res) => {
    const { username, password, rol } = req.body;
    if (!username || !password || !rol) return res.status(400).json({ success: false, error: 'Todos los campos son requeridos.' });
    if (password.length < 6) return res.status(400).json({ success: false, error: 'La contraseña debe tener al menos 6 caracteres.' });
    try {
        const existe = await dbGet("SELECT id FROM usuarios WHERE username = ?", [username]);
        if (existe) return res.status(400).json({ success: false, error: 'El nombre de usuario ya existe.' });
        const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const r = await dbRun("INSERT INTO usuarios (username, password, rol) VALUES (?, ?, ?)", [username, hashed, rol]);
        res.json({ success: true, id: r.lastID });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/usuarios/:id', ...soloAdmin, async (req, res) => {
    const { password, rol, activo } = req.body;
    const userId = req.params.id;
    if (String(req.user.id) === String(userId) && activo === 0)
        return res.status(403).json({ error: 'No puedes desactivar tu propia cuenta.' });
    try {
        let updates = [], values = [];
        if (password) { if (password.length < 6) return res.status(400).json({ error: 'Mínimo 6 caracteres.' }); updates.push('password = ?'); values.push(await bcrypt.hash(password, BCRYPT_ROUNDS)); }
        if (rol)      { updates.push('rol = ?');    values.push(rol); }
        if (activo !== undefined) { updates.push('activo = ?'); values.push(activo); }
        if (updates.length === 0) return res.status(400).json({ error: 'No hay cambios que aplicar.' });
        values.push(userId);
        await dbRun(`UPDATE usuarios SET ${updates.join(', ')} WHERE id = ?`, values);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/usuarios/:id', ...soloAdmin, async (req, res) => {
    if (String(req.params.id) === String(req.user.id)) return res.status(403).json({ error: 'No puedes eliminar tu propia cuenta.' });
    try {
        await dbRun("UPDATE usuarios SET activo = 0 WHERE id = ?", [req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// 10. CLIENTES — MEJORA #13: búsqueda por ?q=
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/clientes', ...todosLosRoles, async (req, res) => {
    try {
        const q = req.query.q ? `%${req.query.q}%` : null;
        const sql    = q ? "SELECT * FROM clientes WHERE nombre_completo LIKE ? OR celular LIKE ? ORDER BY nombre_completo"
                         : "SELECT * FROM clientes ORDER BY nombre_completo";
        const params = q ? [q, q] : [];
        res.json(await dbAll(sql, params));
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clientes', ...todosLosRoles, validar('cliente'), async (req, res) => {
    try {
        const { nombre_completo, celular, localidad, direccion } = req.body;
        const r = await dbRun("INSERT INTO clientes (nombre_completo, celular, localidad, direccion) VALUES (?,?,?,?)", [nombre_completo, celular, localidad, direccion]);
        backupService.subirBackup().catch(e => logger.error('[Backup] Trigger falló:', e.message));
        res.json({ id: r.lastID });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/clientes/:id', ...todosLosRoles, validar('cliente'), async (req, res) => {
    try {
        const { nombre_completo, celular, localidad, direccion } = req.body;
        await dbRun("UPDATE clientes SET nombre_completo=?, celular=?, localidad=?, direccion=? WHERE id=?", [nombre_completo, celular, localidad, direccion, req.params.id]);
        res.sendStatus(200);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/clientes/:id', ...adminOTecnico, async (req, res) => {
    try { await dbRun("DELETE FROM clientes WHERE id=?", [req.params.id]); res.sendStatus(200); }
    catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// 11. ÓRDENES — MEJORA #3: whitelist de campos + #6/#11: notificación WA
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/ordenes', ...adminOTecnico, async (req, res) => {
    try {
        const q = req.query.q ? `%${req.query.q}%` : null;
        const sql = q
            ? `SELECT ordenes.*, clientes.nombre_completo, clientes.celular FROM ordenes JOIN clientes ON ordenes.cliente_id = clientes.id WHERE clientes.nombre_completo LIKE ? OR ordenes.estado LIKE ? OR CAST(ordenes.id AS TEXT) LIKE ? ORDER BY ordenes.id DESC`
            : `SELECT ordenes.*, clientes.nombre_completo, clientes.celular FROM ordenes JOIN clientes ON ordenes.cliente_id = clientes.id ORDER BY ordenes.id DESC`;
        const params = q ? [q, q, q] : [];
        res.json(await dbAll(sql, params));
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ordenes', ...adminOTecnico, validar('orden'), async (req, res) => {
    try {
        const camposValidos = Object.keys(req.body).filter(k => CAMPOS_ORDEN.includes(k));
        if (camposValidos.length === 0) return res.status(400).json({ error: 'No hay campos válidos.' });
        const r = await dbRun(
            `INSERT INTO ordenes (${camposValidos.join(',')}) VALUES (${camposValidos.map(() => '?').join(',')})`,
            camposValidos.map(k => req.body[k])
        );
        backupService.subirBackup().catch(e => logger.error('[Backup] Trigger falló:', e.message));
        res.json({ id: r.lastID });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/ordenes/:id', ...adminOTecnico, async (req, res) => {
    const camposValidos = Object.keys(req.body).filter(k => CAMPOS_ORDEN.includes(k));
    if (camposValidos.length === 0) return res.status(400).json({ error: 'No hay campos válidos.' });
    const setClauses = camposValidos.map(f => `${f} = ?`).join(', ');
    const valores    = [...camposValidos.map(k => req.body[k]), req.params.id];

    try {
        await dbRun(`UPDATE ordenes SET ${setClauses} WHERE id = ?`, valores);

        // Nota: las notificaciones al cliente se envían manualmente desde la ventana de WhatsApp Web

        // MEJORA #8: registrar auditoría de cambios
        try {
            const ordenActual = await dbGet('SELECT * FROM ordenes WHERE id = ?', [req.params.id]);
            const usuario = req.user?.username || 'sistema';
            for (const campo of camposValidos) {
                const valAnterior = ordenActual ? String(ordenActual[campo] ?? '') : '';
                const valNuevo    = String(req.body[campo] ?? '');
                if (valAnterior !== valNuevo) {
                    await dbRun(
                        'INSERT INTO ordenes_historial (orden_id, usuario, campo, valor_ant, valor_nuevo) VALUES (?,?,?,?,?)',
                        [req.params.id, usuario, campo, valAnterior, valNuevo]
                    );
                }
            }
        } catch(e) { logger.warn('[Auditoría] Error guardando historial:', e.message); }

        res.sendStatus(200);
    } catch(e) {
        logger.error('[Ordenes] Error actualizando orden:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/ordenes/:id', ...soloAdmin, async (req, res) => {
    try {
        const r = await dbRun('DELETE FROM ordenes WHERE id = ?', [req.params.id]);
        res.json({ success: true, changes: r.changes });
    } catch(e) { logger.error('Error eliminando orden:', e); res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// 11b. HISTORIAL DE ÓRDENES — MEJORA #8
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/ordenes/:id/historial', ...adminOTecnico, async (req, res) => {
    try {
        const rows = await dbAll(
            'SELECT * FROM ordenes_historial WHERE orden_id = ? ORDER BY fecha DESC',
            [req.params.id]
        );
        res.json(rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// 11c. PARTES / REPUESTOS — MEJORA #2
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/partes', ...todosLosRoles, async (req, res) => {
    try {
        const q = req.query.q ? `%${req.query.q}%` : null;
        const cat = req.query.categoria || null;
        let sql = "SELECT * FROM partes WHERE activo = 1";
        const params = [];
        if (q)   { sql += " AND (marca LIKE ? OR modelo LIKE ? OR descripcion LIKE ? OR categoria LIKE ?)"; params.push(q, q, q, q); }
        if (cat) { sql += " AND categoria = ?"; params.push(cat); }
        sql += " ORDER BY categoria, marca";
        res.json(await dbAll(sql, params));
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/partes/categorias', ...todosLosRoles, async (req, res) => {
    try {
        const rows = await dbAll("SELECT DISTINCT categoria FROM partes WHERE activo = 1 ORDER BY categoria");
        res.json(rows.map(r => r.categoria));
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/partes', ...adminOTecnico, async (req, res) => {
    const { categoria, marca, modelo, descripcion, precio, stock, imagen_data } = req.body;
    if (!categoria || !marca) return res.status(400).json({ error: 'categoria y marca son obligatorios' });
    try {
        const r = await dbRun(
            "INSERT INTO partes (categoria, marca, modelo, descripcion, precio, stock, imagen_data) VALUES (?,?,?,?,?,?,?)",
            [categoria, marca, modelo || '', descripcion || '', precio || 0, stock || 0, imagen_data || '']
        );
        res.json({ success: true, id: r.lastID });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/partes/:id', ...adminOTecnico, async (req, res) => {
    const { categoria, marca, modelo, descripcion, precio, stock, imagen_data } = req.body;
    try {
        await dbRun(
            "UPDATE partes SET categoria=?, marca=?, modelo=?, descripcion=?, precio=?, stock=?, imagen_data=? WHERE id=?",
            [categoria, marca, modelo || '', descripcion || '', precio || 0, stock || 0, imagen_data || '', req.params.id]
        );
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/partes/:id', ...adminOTecnico, async (req, res) => {
    try { await dbRun("UPDATE partes SET activo = 0 WHERE id = ?", [req.params.id]); res.json({ success: true }); }
    catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// 12. CATÁLOGO
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/catalogo', ...todosLosRoles, async (req, res) => {
    try { res.json(await dbAll("SELECT * FROM catalogo")); }
    catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/catalogo', ...adminOTecnico, validar('catalogoItem'), async (req, res) => {
    const { categoria, valor, tipo_relacionado } = req.body;
    try {
        const r = await dbRun("INSERT INTO catalogo (categoria, valor, tipo_relacionado) VALUES (?, ?, ?)", [categoria, valor, tipo_relacionado || null]);
        res.json({ success: true, id: r.lastID });
    } catch(e) { logger.error('Error catálogo:', e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/catalogo/:id', ...adminOTecnico, async (req, res) => {
    try { await dbRun("DELETE FROM catalogo WHERE id=?", [req.params.id]); res.sendStatus(200); }
    catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// 13. PRODUCTOS — MEJORA #13: búsqueda + alerta stock bajo
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/productos', ...todosLosRoles, async (req, res) => {
    try {
        const q = req.query.q ? `%${req.query.q}%` : null;
        const soloStockBajo = req.query.stock_bajo === '1';
        let sql = "SELECT * FROM productos WHERE activo = 1";
        const params = [];
        if (q) { sql += " AND (nombre LIKE ? OR codigo LIKE ? OR categoria LIKE ?)"; params.push(q, q, q); }
        if (soloStockBajo) sql += " AND stock <= 3";
        sql += " ORDER BY nombre";
        res.json(await dbAll(sql, params));
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/productos/:id', ...todosLosRoles, async (req, res) => {
    try { res.json(await dbGet("SELECT * FROM productos WHERE id = ?", [req.params.id]) || null); }
    catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/productos', ...soloAdmin, validar('producto'), async (req, res) => {
    const { codigo, nombre, descripcion, precio, stock, categoria, imagen_url } = req.body;
    try {
        const r = await dbRun("INSERT INTO productos (codigo, nombre, descripcion, precio, stock, categoria, imagen_url) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [codigo, nombre, descripcion, precio, stock, categoria, imagen_url || '']);
        res.json({ success: true, id: r.lastID });
    } catch(e) {
        if (e.message.includes('UNIQUE')) return res.status(400).json({ success: false, error: 'El código ya existe' });
        res.status(500).json({ success: false, error: e.message });
    }
});

app.put('/api/productos/:id', ...soloAdmin, async (req, res) => {
    const { nombre, descripcion, precio, stock, categoria, imagen_url } = req.body;
    try {
        await dbRun("UPDATE productos SET nombre=?, descripcion=?, precio=?, stock=?, categoria=?, imagen_url=? WHERE id=?",
            [nombre, descripcion, precio, stock, categoria, imagen_url || '', req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/productos/:id', ...soloAdmin, async (req, res) => {
    try { await dbRun("UPDATE productos SET activo = 0 WHERE id = ?", [req.params.id]); res.json({ success: true }); }
    catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/productos/:id/stock', ...adminOVendedor, async (req, res) => {
    const { cantidad } = req.body;
    try { await dbRun("UPDATE productos SET stock = stock + ? WHERE id = ?", [cantidad, req.params.id]); res.json({ success: true }); }
    catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// 14. VENTAS — MEJORA #1: transacción async/await sin race condition
//             MEJORA #9: paginación en listado
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/ventas', ...adminOVendedor, async (req, res) => {
    try {
        const page   = Math.max(1, parseInt(req.query.page)  || 1);
        const limit  = Math.min(200, parseInt(req.query.limit) || 50);
        const offset = (page - 1) * limit;
        const countRow = await dbGet("SELECT COUNT(*) as total FROM ventas");
        const rows = await dbAll(
            `SELECT v.*, (SELECT COUNT(*) FROM ventas_detalle WHERE venta_id = v.id) as items_count FROM ventas v ORDER BY fecha DESC LIMIT ? OFFSET ?`,
            [limit, offset]
        );
        res.json({ data: rows, total: countRow.total, page, limit, pages: Math.ceil(countRow.total / limit) });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ventas/:id', ...adminOVendedor, async (req, res) => {
    try {
        const venta = await dbGet("SELECT * FROM ventas WHERE id = ?", [req.params.id]);
        if (!venta) return res.status(404).json({ error: 'Venta no encontrada' });
        venta.items = await dbAll("SELECT * FROM ventas_detalle WHERE venta_id = ?", [req.params.id]);
        res.json(venta);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// MEJORA #1: transacción segura con async/await — sin race condition en COMMIT/ROLLBACK
app.post('/api/ventas', ...adminOVendedor, validar('venta'), async (req, res) => {
    const { cliente, items, subtotal, descuento, total, metodo_pago, efectivo, cambio, usuario } = req.body;
    const fecha = new Date().toISOString();
    const folio = 'V' + Date.now();
    try {
        await dbRun("BEGIN TRANSACTION");
        const ventaRow = await dbRun(
            `INSERT INTO ventas (folio, cliente, subtotal, descuento, total, metodo_pago, efectivo, cambio, usuario, fecha) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [folio, cliente, subtotal, descuento, total, metodo_pago, efectivo, cambio, usuario, fecha]
        );
        const ventaId = ventaRow.lastID;
        // FIX #2: verificar stock antes de descontar
        for (const item of items) {
            const prod = await dbGet("SELECT stock, nombre FROM productos WHERE id = ? AND activo = 1", [item.id]);
            if (!prod) throw new Error(`Producto ID ${item.id} no encontrado`);
            if (prod.stock < item.cantidad) {
                throw new Error(`Stock insuficiente para "${prod.nombre}": disponible ${prod.stock}, solicitado ${item.cantidad}`);
            }
        }
        for (const item of items) {
            await dbRun(
                `INSERT INTO ventas_detalle (venta_id, producto_id, producto_nombre, cantidad, precio_unitario, subtotal) VALUES (?, ?, ?, ?, ?, ?)`,
                [ventaId, item.id, item.nombre, item.cantidad, item.precio, item.subtotal]
            );
            await dbRun("UPDATE productos SET stock = stock - ? WHERE id = ?", [item.cantidad, item.id]);
        }
        await dbRun("COMMIT");
        loggerFinanciero.info('VENTA_COMPLETADA', { folio, ventaId, cliente, total, descuento, metodo_pago, usuario, items: items.length, fecha });
        res.json({ success: true, id: ventaId, folio });
    } catch(err) {
        try { await dbRun("ROLLBACK"); } catch(_) {}
        logger.error('[Ventas] Error en transacción:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ══════════════════════════════════════════════════════════════════════════════
// 15. ESTADÍSTICAS — MEJORA #12: dashboard ampliado
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/ventas/estadisticas/hoy', ...soloAdmin, async (req, res) => {
    try {
        const hoy = new Date().toISOString().split('T')[0];
        const row = await dbGet(`SELECT COUNT(*) as ventas_count, COALESCE(SUM(total), 0) as ventas_total, COALESCE(SUM((SELECT SUM(cantidad) FROM ventas_detalle WHERE venta_id = ventas.id)), 0) as productos_vendidos FROM ventas WHERE DATE(fecha) = ?`, [hoy]);
        res.json(row || { ventas_count: 0, ventas_total: 0, productos_vendidos: 0 });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ventas/estadisticas/mes', ...soloAdmin, async (req, res) => {
    try {
        const mes = new Date().toISOString().slice(0, 7);
        const row = await dbGet(`SELECT COUNT(*) as ventas_count, COALESCE(SUM(total), 0) as ventas_total FROM ventas WHERE strftime('%Y-%m', fecha) = ?`, [mes]);
        res.json(row || { ventas_count: 0, ventas_total: 0 });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// MEJORA #12: endpoint de dashboard completo
app.get('/api/estadisticas/dashboard', ...soloAdmin, async (req, res) => {
    try {
        const hoy = new Date().toISOString().split('T')[0];
        const mes = new Date().toISOString().slice(0, 7);
        const [ventasHoy, ventasMes, ordenesPorEstado, topProductos, stockBajo] = await Promise.all([
            dbGet(`SELECT COUNT(*) as count, COALESCE(SUM(total),0) as total FROM ventas WHERE DATE(fecha)=?`, [hoy]),
            dbGet(`SELECT COUNT(*) as count, COALESCE(SUM(total),0) as total FROM ventas WHERE strftime('%Y-%m',fecha)=?`, [mes]),
            dbAll(`SELECT estado, COUNT(*) as count FROM ordenes GROUP BY estado ORDER BY count DESC`),
            dbAll(`SELECT vd.producto_nombre as nombre, SUM(vd.cantidad) as vendido FROM ventas_detalle vd JOIN ventas v ON v.id = vd.venta_id WHERE DATE(v.fecha) >= DATE('now','-30 days') GROUP BY vd.producto_id ORDER BY vendido DESC LIMIT 5`),
            dbAll(`SELECT id, codigo, nombre, stock FROM productos WHERE activo=1 AND stock <= 3 ORDER BY stock ASC`)
        ]);
        res.json({ ventasHoy, ventasMes, ordenesPorEstado, topProductos, stockBajo });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// 16. WHATSAPP — Integración con BrowserView de Electron
// ══════════════════════════════════════════════════════════════════════════════

function broadcastWS(tipo, payload) {
    if (!global._wss) return;
    const msg = JSON.stringify({ tipo, ...payload, ts: Date.now() });
    global._wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
}

// Marcar estado manualmente desde el frontend (sin Flutter bot, se usa WebView)
app.post('/api/whatsapp/estado', ...soloAdmin, async (req, res) => {
    const { estado } = req.body;
    try {
        db.prepare(`UPDATE whatsapp_sesion SET estado=?, ultima_actividad=datetime('now') WHERE id=1`).run(estado);
        broadcastWS('wa_status', { estado });
        res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/whatsapp/status', ...soloAdmin, async (req, res) => {
    try {
        const row = await dbGet('SELECT * FROM whatsapp_sesion WHERE id=1');
        res.json({ estado: row?.estado || 'DESCONECTADO', db: row || {} });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/whatsapp/conectar', ...soloAdmin, async (req, res) => {
    broadcastWS('wa_status', { estado: 'CONECTANDO' });
    res.json({ ok: true, msg: 'Abrí WhatsApp Web escaneando el QR en la ventana de Electron' });
});

app.post('/api/whatsapp/enviar', ...adminOTecnico, async (req, res) => {
    // El envío se hace manualmente desde el BrowserView de WhatsApp Web
    res.json({ ok: true, msg: 'Usá WhatsApp Web abierto en la ventana de TECNITEC para enviar mensajes' });
});

// Chatbot admin endpoints
app.get('/api/chatbot/config', ...soloAdmin, async (req, res) => {
    try {
        const rows = await dbAll("SELECT clave, valor FROM chatbot_config");
        const config = {}; rows.forEach(r => { config[r.clave] = r.valor; }); res.json(config);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/chatbot/config', ...soloAdmin, async (req, res) => {
    try {
        for (const [clave, valor] of Object.entries(req.body))
            await dbRun("INSERT OR REPLACE INTO chatbot_config (clave, valor) VALUES (?, ?)", [clave, valor !== null && valor !== undefined ? String(valor) : '']);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Endpoints consumed by the Flutter bot (no auth — internal 127.0.0.1 only)
app.get('/api/ordenes/:id', async (req, res) => {
    try {
        const row = await dbGet('SELECT o.*, c.nombre_completo, c.celular FROM ordenes o JOIN clientes c ON o.cliente_id = c.id WHERE o.id = ?', [req.params.id]);
        if (!row) return res.status(404).json({ error: 'No encontrada' });
        res.json(row);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/chatbot/consultas/presupuesto', async (req, res) => {
    try {
        const { telefono, nombre, descripcion } = req.body;
        await dbRun("INSERT INTO consultas_presupuesto (telefono_cliente, nombre_cliente, descripcion, fecha, estado) VALUES (?,?,?,?,?)",
            [telefono || '', nombre || '', descripcion || '', new Date().toISOString(), 'pendiente']);
        // Disparar auto-respuesta inmediata si la IA está activa
        setTimeout(_procesarAutoRespuestas, 1000);
        res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Frontend admin panel endpoints
app.get('/api/chatbot/conversaciones', ...soloAdmin, async (req, res) => {
    try { res.json(await dbAll("SELECT * FROM conversaciones_chatbot ORDER BY fecha_ultimo DESC LIMIT 50")); }
    catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/chatbot/consultas/pendientes', ...soloAdmin, async (req, res) => {
    try { res.json(await dbAll("SELECT * FROM consultas_presupuesto WHERE estado = 'pendiente' ORDER BY fecha")); }
    catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/chatbot/responder-consulta', ...adminOTecnico, async (req, res) => {
    const { consulta_id, tecnico, respuesta, presupuesto } = req.body;
    try {
        await dbRun(`UPDATE consultas_presupuesto SET estado='respondida', tecnico_asignado=?, fecha_respuesta=?, presupuesto_enviado=? WHERE id=?`,
            [tecnico, new Date().toISOString(), presupuesto || null, consulta_id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// 17. IA — Ollama + tinyllama para respuestas inteligentes del chatbot
// ══════════════════════════════════════════════════════════════════════════════
const OLLAMA_HOST = 'http://127.0.0.1:11434';
let _ollamaModelo = 'tinyllama';
let _ollamaProceso = null;
let _ollamaListo = false;
let _ollamaVerificando = false;

async function _obtenerModeloIA() {
    try {
        const row = await dbGet("SELECT valor FROM chatbot_config WHERE clave='ai_modelo'");
        const modelo = row && row.valor ? row.valor.trim() : 'tinyllama';
        // Si el valor por defecto de migración (llama3.2) no fue cambiado, usar tinyllama (más liviano)
        if (modelo === 'llama3.2') return 'tinyllama';
        return modelo;
    } catch(e) { return 'tinyllama'; }
}

async function verificarOllama() {
    if (_ollamaVerificando) return _ollamaListo;
    _ollamaVerificando = true;
    _ollamaModelo = await _obtenerModeloIA();
    try {
        const r = await new Promise((resolve, reject) => {
            const req = http.get(OLLAMA_HOST + '/api/tags', (res) => {
                let body = '';
                res.on('data', d => body += d);
                res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
            });
            req.on('error', reject);
            req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
        });
        const tieneModelo = (r.models || []).some(m => m.name && m.name.startsWith(_ollamaModelo));
        if (tieneModelo) {
            _ollamaListo = true;
        } else {
            _ollamaListo = false;
            logger.info('[Ollama] Modelo ' + _ollamaModelo + ' no encontrado, descargando...');
            _descargarModelo();
        }
    } catch(e) {
        logger.warn('[Ollama] No responde, intentando iniciar...');
        _iniciarOllama();
    }
    _ollamaVerificando = false;
    return _ollamaListo;
}

function _iniciarOllama() {
    if (_ollamaProceso) return;
    const spawn = require('child_process').spawn;
    const cmd = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
    _ollamaProceso = spawn(cmd, ['serve'], { stdio: 'ignore', detached: true });
    _ollamaProceso.on('error', (err) => {
        logger.warn('[Ollama] No se pudo iniciar: ' + err.message);
        logger.warn('[Ollama] Instalalo desde https://ollama.com/download');
        _ollamaProceso = null;
    });
    _ollamaProceso.on('exit', () => { _ollamaProceso = null; });
    logger.info('[Ollama] Iniciado en segundo plano');
    // Esperar a que esté listo
    setTimeout(async () => {
        try {
            await new Promise((resolve, reject) => {
                const check = () => {
                    const r2 = http.get(OLLAMA_HOST + '/api/tags', (res) => { resolve(); });
                    r2.on('error', () => setTimeout(check, 1000));
                    r2.setTimeout(2000, () => { r2.destroy(); setTimeout(check, 1000); });
                };
                check();
            });
            logger.info('[Ollama] Proceso listo, verificando modelo...');
            _ollamaModelo = await _obtenerModeloIA();
            _descargarModelo();
        } catch(e) { logger.warn('[Ollama] No se pudo conectar'); }
    }, 5000);
}

function _descargarModelo() {
    _ollamaListo = false;
    const spawn = require('child_process').spawn;
    const cmd = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
    logger.info('[Ollama] Descargando modelo ' + _ollamaModelo + '...');
    const pull = spawn(cmd, ['pull', _ollamaModelo], { stdio: 'ignore' });
    pull.on('error', (err) => logger.warn('[Ollama] Error descargando modelo: ' + err.message));
    pull.on('exit', (code) => {
        if (code === 0) {
            logger.info('[Ollama] Modelo ' + _ollamaModelo + ' descargado');
            _ollamaListo = true;
        } else {
            logger.warn('[Ollama] Fallo descarga del modelo (código ' + code + ')');
        }
    });
}

function _construirContexto(orden) {
    if (!orden) return '';
    return `\nDatos de la orden de reparación:\n` +
        `- Número de orden: #${orden.id}\n` +
        `- Cliente: ${orden.nombre_completo || ''}\n` +
        `- Equipo: ${orden.tipo_equipo || ''} ${orden.marca || ''} ${orden.modelo || ''}\n` +
        `- Falla reportada: ${orden.falla || 'No especificada'}\n` +
        `- Estado actual: ${orden.estado || 'Pendiente'}\n` +
        `- Presupuesto: $${orden.presupuesto || 'Pendiente'}\n` +
        `- Notas internas: ${orden.notas || 'Ninguna'}\n` +
        (orden.adelanto ? `- Adelanto: $${orden.adelanto}\n` : '');
}

async function generarRespuestaIA(mensajeUsuario, contextoAdicional) {
    if (!_ollamaListo) {
        await verificarOllama();
        if (!_ollamaListo) return null;
    }
    try {
        const config = await dbAll("SELECT clave, valor FROM chatbot_config WHERE clave IN ('ai_conocimiento','nombre_negocio','horario','ai_temperatura')");
        const cfg = {}; config.forEach(r => { cfg[r.clave] = r.valor; });
        const conocimiento = cfg.ai_conocimiento || 'Eres un asistente de TECNITEC, un taller de reparación de dispositivos electrónicos. Respondé de forma útil y profesional.';
        const negocio = cfg.nombre_negocio || 'TECNITEC';
        const horario = cfg.horario || 'Lunes a Viernes 9:00 - 18:00';
        const temperatura = parseFloat(cfg.ai_temperatura) || 0.3;
        // Incluir plantillas de respuesta rápida
        let plantillasTexto = '';
        try {
            const plantillas = await dbAll("SELECT nombre, contenido FROM plantillas_respuesta ORDER BY orden ASC, nombre ASC");
            if (plantillas.length > 0) {
                plantillasTexto = '\n\n=== PLANTILLAS DE RESPUESTA DISPONIBLES ===\nUsá estas plantillas cuando corresponda al contexto:\n' +
                    plantillas.map(p => `- "${p.nombre}": ${p.contenido.substring(0, 100)}${p.contenido.length > 100 ? '...' : ''}`).join('\n');
            }
        } catch(_) {}
        const systemPrompt = `${conocimiento}\n\nNombre del negocio: ${negocio}\nHorario: ${horario}${plantillasTexto}${contextoAdicional || ''}\n\nRespondé de forma clara, amable y breve (máximo 3 párrafos). No inventes información que no esté en el contexto. Si no sabés algo, decí que un asesor lo revisará.`;
        const body = JSON.stringify({
            model: _ollamaModelo,
            prompt: `${systemPrompt}\n\nPregunta del cliente: ${mensajeUsuario}\n\nInstrucción: Respondé de forma útil, breve y profesional, en español.`,
            stream: false,
            options: { temperature: temperatura, num_predict: 150, keep_alive: '5m' }
        });
        const respuesta = await new Promise((resolve, reject) => {
            const req = http.request(OLLAMA_HOST + '/api/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            }, (res) => {
                let data = '';
                res.on('data', d => data += d);
                res.on('end', () => {
                    try { const j = JSON.parse(data); resolve(j.response || j.message?.content || ''); }
                    catch(e) {
                        logger.error('[Ollama] Error parseando respuesta: ' + e.message + ' | data: ' + data.substring(0,200));
                        reject(e);
                    }
                });
            });
            req.on('error', function(err) {
                logger.error('[Ollama] Error en request: ' + err.message);
                reject(err);
            });
            req.setTimeout(300000, function() {
                logger.error('[Ollama] Timeout 300s agotado para modelo ' + _ollamaModelo);
                req.destroy();
                reject(new Error('timeout'));
            });
            req.write(body);
            req.end();
        });
        return respuesta.trim();
    } catch(e) {
        logger.error('[Ollama] Error generando respuesta: ' + e.message);
        return null;
    }
}

// Endpoint para generar respuesta IA (admin)
app.post('/api/chatbot/ia-generar', ...adminOTecnico, async (req, res) => {
    try {
        const { mensaje, telefono, orden_id } = req.body;
        if (!mensaje) return res.status(400).json({ error: 'Mensaje requerido' });
        let contexto = '';
        if (orden_id) {
            const orden = await dbGet('SELECT o.*, c.nombre_completo, c.celular FROM ordenes o JOIN clientes c ON o.cliente_id = c.id WHERE o.id = ?', [orden_id]);
            contexto = _construirContexto(orden);
        } else if (telefono) {
            // Buscar órdenes activas del cliente por teléfono
            const tel = telefono.replace(/\D/g, '');
            const ordenes = await dbAll(
                `SELECT o.*, c.nombre_completo, c.celular FROM ordenes o 
                 JOIN clientes c ON o.cliente_id = c.id 
                 WHERE REPLACE(REPLACE(REPLACE(REPLACE(c.celular,'-',''),' ',''),'(',''),')','') LIKE ?
                 ORDER BY o.fecha_hora DESC LIMIT 3`,
                [`%${tel}`]
            );
            if (ordenes.length > 0) {
                contexto = ordenes.map(o => _construirContexto(o)).join('\n');
            }
        }
        const respuesta = await generarRespuestaIA(mensaje, contexto);
        if (respuesta === null) return res.status(503).json({ error: 'IA no disponible. Asegurate de tener Ollama instalado (ollama.com/download) y ejecutándose.' });
        res.json({ respuesta, ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Endpoint para webview injection (sin auth, solo localhost)
app.post('/api/webview/incoming-message', async (req, res) => {
    try {
        const { mensaje, telefono, nombre } = req.body;
        if (!mensaje) return res.status(400).json({ error: 'Mensaje requerido' });
        // Verificar si auto-respuesta está activa
        const cfgAi = await dbGet("SELECT valor FROM chatbot_config WHERE clave='ai_activo'");
        if (!cfgAi || cfgAi.valor !== '1') return res.json({ respuesta: null, ok: false, motivo: 'inactivo' });
        const tel = telefono || 'whatsapp';
        const nom = nombre || 'Cliente WhatsApp';
        // Broadcast para notificación
        broadcastWS('wa_message', { nombre: nom, texto: mensaje, telefono: tel, fecha: new Date().toISOString(), origen: 'webview' });
        const result = await dbRun(
            "INSERT INTO consultas_presupuesto (telefono_cliente, nombre_cliente, descripcion, fecha, estado) VALUES (?,?,?,?,?)",
            [tel, nom, mensaje, new Date().toISOString(), 'pendiente']
        );
        const consultaId = result.lastInsertRowid;
        const respuesta = await generarRespuestaIA(mensaje, `\nConsulta desde WhatsApp. Cliente: ${nom}, Tel: ${tel}`);
        if (respuesta && consultaId) {
            await dbRun(
                `UPDATE consultas_presupuesto SET estado='respondida', tecnico_asignado='IA Automática', fecha_respuesta=?, respuesta_automatica=1, respuesta_ia=? WHERE id=?`,
                [new Date().toISOString(), respuesta, consultaId]
            );
            logger.info('[WebView-IA] Consulta #' + consultaId + ' respondida');
            broadcastWS('consulta_respondida', { consulta_id: consultaId, respuesta });
        }
        res.json({ respuesta, ok: !!respuesta });
    } catch(e) {
        logger.warn('[WebView-IA] Error: ' + e.message);
        res.json({ respuesta: null, ok: false, error: e.message });
    }
});

// Endpoint rápido para webview: ¿IA activa?
app.get('/api/webview/ai-status', async (req, res) => {
    try {
        const cfgAi = await dbGet("SELECT valor FROM chatbot_config WHERE clave='ai_activo'");
        const activo = cfgAi && cfgAi.valor === '1';
        res.json({ activo, ollama: _ollamaListo });
    } catch(e) { res.json({ activo: false, ollama: false }); }
});

// Endpoint para verificar estado de Ollama
app.get('/api/ollama/status', async (req, res) => {
    try {
        const r = await new Promise((resolve, reject) => {
            const req2 = http.get(OLLAMA_HOST + '/api/tags', (resp) => {
                let body = '';
                resp.on('data', d => body += d);
                resp.on('end', () => {
                    try {
                        const j = JSON.parse(body);
                        const models = (j.models || []).map(m => m.name);
                        const tieneModelo = models.some(m => m.startsWith(_ollamaModelo));
                        resolve({ ok: tieneModelo, models, listo: _ollamaListo, modelo: _ollamaModelo });
                    } catch(e) { resolve({ ok: false, error: e.message }); }
                });
            });
            req2.on('error', (e) => resolve({ ok: false, error: e.message }));
            req2.setTimeout(3000, () => { req2.destroy(); resolve({ ok: false, error: 'timeout' }); });
        });
        res.json(r);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Endpoint para reinstalar modelo desde ajustes
app.post('/api/ollama/reinstall', ...soloAdmin, async (req, res) => {
    _ollamaListo = false;
    _descargarModelo();
    res.json({ ok: true, mensaje: 'Descarga iniciada' });
});

// Endpoint para probar la IA desde ajustes
app.post('/api/chatbot/ia-test', ...adminOTecnico, async (req, res) => {
    try {
        const { mensaje } = req.body;
        if (!mensaje) return res.status(400).json({ error: 'Mensaje requerido' });
        const respuesta = await generarRespuestaIA(mensaje, '\n(Esto es una prueba del sistema)');
        if (respuesta === null) return res.status(503).json({ error: 'IA no disponible. Verificá que Ollama esté funcionando y el modelo descargado.' });
        res.json({ respuesta, ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Auto-responder: procesa consultas pendientes con IA cada 30s
let _autoResponderInterval = null;

async function _procesarAutoRespuestas() {
    try {
        const cfg = await dbGet("SELECT valor FROM chatbot_config WHERE clave='ai_activo'");
        if (!cfg || cfg.valor !== '1') return;
        const pendientes = await dbAll("SELECT * FROM consultas_presupuesto WHERE estado='pendiente' ORDER BY fecha LIMIT 5");
        for (const c of pendientes) {
            if (!_ollamaListo) { await verificarOllama(); if (!_ollamaListo) break; }
            const ctx = `\nDatos del cliente: ${c.nombre_cliente || 'Cliente'}, Tel: ${c.telefono_cliente || ''}`;
            const respuesta = await generarRespuestaIA(c.descripcion || 'Consulta sobre reparación', ctx);
            if (respuesta) {
                await dbRun(
                    `UPDATE consultas_presupuesto SET estado='respondida', tecnico_asignado='IA Automática', fecha_respuesta=?, respuesta_automatica=1, respuesta_ia=? WHERE id=?`,
                    [new Date().toISOString(), respuesta, c.id]
                );
                logger.info('[Auto-Respuesta] Consulta #' + c.id + ' respondida por IA');
                // Notificar por WebSocket
                broadcastWS('consulta_respondida', { consulta_id: c.id, respuesta });
            }
        }
    } catch(e) { logger.warn('[Auto-Respuesta] Error: ' + e.message); }
}

function _iniciarAutoResponder() {
    if (_autoResponderInterval) clearInterval(_autoResponderInterval);
    _autoResponderInterval = setInterval(_procesarAutoRespuestas, 30000);
    logger.info('[Auto-Respuesta] Iniciado (cada 30s)');
}

// Endpoint para ejecutar auto-respuesta manualmente
app.post('/api/chatbot/auto-responder/run', ...adminOTecnico, async (req, res) => {
    await _procesarAutoRespuestas();
    res.json({ ok: true });
});

// Iniciar auto-responder tras la verificación de Ollama
setTimeout(function() {
    _iniciarAutoResponder();
}, 10000);

// Verificar Ollama al iniciar el servidor
setTimeout(verificarOllama, 3000);

// ══════════════════════════════════════════════════════════════════════════════
// 18. PLANTILLAS DE RESPUESTA RÁPIDA
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/plantillas', ...adminOTecnico, async (req, res) => {
    try {
        const rows = await dbAll("SELECT * FROM plantillas_respuesta ORDER BY orden ASC, nombre ASC");
        res.json(rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/plantillas', ...soloAdmin, async (req, res) => {
    try {
        const { nombre, contenido } = req.body;
        if (!nombre || !contenido) return res.status(400).json({ error: 'Nombre y contenido requeridos' });
        const r = await dbRun("INSERT INTO plantillas_respuesta (nombre, contenido) VALUES (?,?)", [nombre.trim(), contenido.trim()]);
        res.json({ ok: true, id: r.lastInsertRowid });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/plantillas/:id', ...soloAdmin, async (req, res) => {
    try {
        const { nombre, contenido, orden } = req.body;
        if (!nombre || !contenido) return res.status(400).json({ error: 'Nombre y contenido requeridos' });
        await dbRun("UPDATE plantillas_respuesta SET nombre=?, contenido=?, orden=? WHERE id=?", [nombre.trim(), contenido.trim(), orden || 0, req.params.id]);
        res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/plantillas/:id', ...soloAdmin, async (req, res) => {
    try {
        await dbRun("DELETE FROM plantillas_respuesta WHERE id=?", [req.params.id]);
        res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// 19. MÓDULO DE PAGOS (MERCADO PAGO)
// ══════════════════════════════════════════════════════════════════════════════
function mpRequest(method, mpPath, body, token) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const opts = {
            hostname: 'api.mercadopago.com', path: mpPath, method,
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'X-Idempotency-Key': 'tec-' + Date.now() + '-' + Math.random().toString(36).slice(2) }
        };
        if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
        const req = https.request(opts, res => {
            let raw = ''; res.on('data', d => raw += d);
            res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); } catch(e) { resolve({ status: res.statusCode, body: raw }); } });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

async function getCfgPagos() {
    const rows = await dbAll("SELECT clave,valor FROM pagos_config");
    const c = {}; rows.forEach(r => { c[r.clave] = r.valor; }); return c;
}

app.get('/api/health', (req, res) => migracionLista ? res.json({ ok: true }) : res.status(503).json({ ok: false }));

// ══════════════════════════════════════════════════════════════════════════════
// CONFIGURACIÓN DE RED — MEJORA MULTILOCAL
// ══════════════════════════════════════════════════════════════════════════════

// Obtener info de red del servidor (IPs disponibles, puerto)
app.get('/api/red/info', (req, res) => {
    const os     = require('os');
    const ifaces = os.networkInterfaces();
    const ips    = [];
    Object.values(ifaces).forEach(list => {
        (list||[]).forEach(iface => {
            if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
        });
    });
    const PORT = parseInt(process.env.TECNITEC_PORT || '3000');
    res.json({ ips, port: PORT, hostname: require('os').hostname() });
});

// Endpoint de ping liviano para verificar conectividad desde clientes remotos
app.get('/api/red/ping', (req, res) => {
    res.json({ ok: true, ts: Date.now(), version: '31.81' });
});

// ══════════════════════════════════════════════════════════════════════════════
// MÓDULO CAJA DIARIA (#3)
// ══════════════════════════════════════════════════════════════════════════════

// Estado actual de caja (¿hay una sesión abierta hoy?)
app.get('/api/caja/estado', ...todosLosRoles, async (req, res) => {
    try {
        const hoy = new Date().toISOString().split('T')[0];
        const sesion = await dbGet(
            "SELECT * FROM caja_sesiones WHERE fecha = ? AND estado = 'abierta' ORDER BY id DESC LIMIT 1", [hoy]
        );
        res.json({ abierta: !!sesion, sesion: sesion || null });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Abrir caja
app.post('/api/caja/abrir', ...todosLosRoles, async (req, res) => {
    try {
        const { monto_apertura = 0, notas = '' } = req.body;
        const hoy = new Date().toISOString().split('T')[0];
        const yaAbierta = await dbGet(
            "SELECT id FROM caja_sesiones WHERE fecha = ? AND estado = 'abierta'", [hoy]
        );
        if (yaAbierta) return res.status(400).json({ error: 'Ya hay una caja abierta hoy.' });
        const result = await dbRun(
            "INSERT INTO caja_sesiones (fecha, usuario, monto_apertura, notas) VALUES (?,?,?,?)",
            [hoy, req.user.username, monto_apertura, notas]
        );
        logger.info(`[Caja] Apertura por ${req.user.username} — $${monto_apertura}`);
        res.json({ ok: true, id: result.lastID });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Cerrar caja — calcula totales desde ventas del día
app.post('/api/caja/cerrar', ...todosLosRoles, async (req, res) => {
    try {
        const { monto_cierre, notas = '' } = req.body;
        if (monto_cierre === undefined) return res.status(400).json({ error: 'monto_cierre requerido' });
        const hoy = new Date().toISOString().split('T')[0];
        const sesion = await dbGet(
            "SELECT * FROM caja_sesiones WHERE fecha = ? AND estado = 'abierta' ORDER BY id DESC LIMIT 1", [hoy]
        );
        if (!sesion) return res.status(400).json({ error: 'No hay caja abierta hoy.' });

        // Calcular ventas del día por método de pago
        const ventas = await dbAll(
            "SELECT metodo_pago, COALESCE(SUM(total),0) as total FROM ventas WHERE DATE(fecha) = ? GROUP BY metodo_pago", [hoy]
        );
        const totales = { efectivo: 0, tarjeta: 0, transferencia: 0, mercadopago: 0, total: 0 };
        ventas.forEach(v => {
            const m = (v.metodo_pago || '').toLowerCase();
            if (m === 'efectivo')       totales.efectivo    += v.total;
            else if (m === 'tarjeta')   totales.tarjeta     += v.total;
            else if (m.includes('transfer')) totales.transferencia += v.total;
            else if (m.includes('mp') || m.includes('mercado')) totales.mercadopago += v.total;
            totales.total += v.total;
        });

        const diferencia = parseFloat(monto_cierre) - (sesion.monto_apertura + totales.efectivo);

        await dbRun(
            `UPDATE caja_sesiones SET
                monto_cierre=?, ventas_efectivo=?, ventas_tarjeta=?, ventas_transfer=?,
                ventas_mp=?, total_ventas=?, diferencia=?, notas=?, estado='cerrada', cerrada_en=datetime('now')
             WHERE id=?`,
            [monto_cierre, totales.efectivo, totales.tarjeta, totales.transferencia,
             totales.mercadopago, totales.total, diferencia, notas, sesion.id]
        );
        logger.info(`[Caja] Cierre por ${req.user.username} — efectivo $${monto_cierre}, diferencia $${diferencia}`);
        res.json({ ok: true, resumen: { ...totales, diferencia, monto_apertura: sesion.monto_apertura, monto_cierre } });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Historial de cajas
app.get('/api/caja/historial', ...soloAdmin, async (req, res) => {
    try {
        const rows = await dbAll("SELECT * FROM caja_sesiones ORDER BY id DESC LIMIT 30");
        res.json(rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Resumen caja actual (ventas en tiempo real durante el día)
app.get('/api/caja/resumen-hoy', ...todosLosRoles, async (req, res) => {
    try {
        const hoy = new Date().toISOString().split('T')[0];
        const [sesion, ventas, cantOrdenes] = await Promise.all([
            dbGet("SELECT * FROM caja_sesiones WHERE fecha=? AND estado='abierta' ORDER BY id DESC LIMIT 1", [hoy]),
            dbAll("SELECT metodo_pago, COUNT(*) as cant, COALESCE(SUM(total),0) as total FROM ventas WHERE DATE(fecha)=? GROUP BY metodo_pago", [hoy]),
            dbGet("SELECT COUNT(*) as cant FROM ordenes WHERE DATE(fecha_hora)=?", [hoy])
        ]);
        res.json({ sesion, ventas, ordenes_hoy: cantOrdenes?.cant || 0 });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// MÓDULO RECORDATORIOS WHATSAPP (#4)
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/recordatorios/config', ...soloAdmin, async (req, res) => {
    try {
        const rows = await dbAll("SELECT clave, valor FROM recordatorios_wa");
        const cfg = {}; rows.forEach(r => { cfg[r.clave] = r.valor; });
        res.json(cfg);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/recordatorios/config', ...soloAdmin, async (req, res) => {
    try {
        for (const [k, v] of Object.entries(req.body))
            await dbRun("INSERT OR REPLACE INTO recordatorios_wa (clave, valor) VALUES (?,?)", [k, String(v)]);
        // Reiniciar el job con la nueva config
        iniciarJobRecordatorios();
        res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/recordatorios/probar', ...soloAdmin, async (req, res) => {
    try {
        const enviados = await ejecutarRecordatorios(true);
        res.json({ ok: true, enviados });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Job de recordatorios — función principal
async function ejecutarRecordatorios(esPrueba = false) {
    const rows = await dbAll("SELECT clave, valor FROM recordatorios_wa");
    const cfg  = {}; rows.forEach(r => { cfg[r.clave] = r.valor; });

    if (!esPrueba && cfg.activo !== '1') return 0;
    if (cfg.wa_conectado !== '1') { logger.warn('[Recordatorios] WhatsApp no conectado manualmente'); return 0; }

    const diasSinUpdate = parseInt(cfg.dias_sin_update || '3');
    const mensajeTpl    = cfg.mensaje || '👋 Hola {nombre}, tu equipo #{id} está en proceso en TECNITEC.';

    // Órdenes activas sin actualización hace N días
    const ordenes = await dbAll(`
        SELECT o.id, o.estado, o.tipo_equipo, o.marca, o.modelo, o.fecha_hora,
               c.nombre_completo, c.celular
        FROM ordenes o
        JOIN clientes c ON o.cliente_id = c.id
        WHERE o.estado NOT IN ('Entregado','Listo')
          AND c.celular IS NOT NULL AND c.celular != ''
          AND DATE(o.fecha_hora) <= DATE('now', '-' || ? || ' days')
          AND o.id NOT IN (
              SELECT DISTINCT orden_id FROM ordenes_historial
              WHERE DATE(fecha) >= DATE('now', '-' || ? || ' days')
          )
    `, [diasSinUpdate, diasSinUpdate]);

    let enviados = 0;
    for (const o of ordenes) {
        const nombre  = (o.nombre_completo || '').split(' ')[0];
        const equipo  = [o.tipo_equipo, o.marca, o.modelo].filter(Boolean).join(' ');
        const mensaje = mensajeTpl
            .replace('{nombre}', nombre)
            .replace('{equipo}', equipo)
            .replace('{id}',     o.id)
            .replace('{estado}', o.estado);
        try {
            logger.info(`[Recordatorios] Pendiente enviar a ${o.nombre_completo} (${o.celular}): "${mensaje}"`);
            enviados++;
        } catch(err) {}
    }
    logger.info(`[Recordatorios] ${esPrueba ? '[PRUEBA] ' : ''}${enviados} recordatorios enviados`);
    return enviados;
}

// Programar el job según la hora configurada
let _recordatorioTimer = null;
async function iniciarJobRecordatorios() {
    if (_recordatorioTimer) clearTimeout(_recordatorioTimer);
    try {
        const rows = await dbAll("SELECT clave, valor FROM recordatorios_wa");
        const cfg  = {}; rows.forEach(r => { cfg[r.clave] = r.valor; });
        if (cfg.activo !== '1') return;

        const [hh, mm]  = (cfg.hora_envio || '10:00').split(':').map(Number);
        const ahora     = new Date();
        const objetivo  = new Date(ahora);
        objetivo.setHours(hh, mm, 0, 0);
        if (objetivo <= ahora) objetivo.setDate(objetivo.getDate() + 1);

        const ms = objetivo - ahora;
        logger.info(`[Recordatorios] Próximo envío: ${objetivo.toLocaleString('es-AR')} (en ${Math.round(ms/60000)} min)`);
        _recordatorioTimer = setTimeout(async () => {
            await ejecutarRecordatorios();
            iniciarJobRecordatorios(); // reagendar para el día siguiente
        }, ms);
    } catch(e) { logger.warn('[Recordatorios] Error iniciando job:', e.message); }
}

// Iniciar job al arrancar (con delay para que la DB esté lista)
setTimeout(iniciarJobRecordatorios, 15000);

// ══════════════════════════════════════════════════════════════════════════════
// MEJORA #3: descargar backup de la base de datos (solo admin)
app.get('/api/backup/descargar', ...soloAdmin, (req, res) => {
    const fecha    = new Date().toISOString().slice(0, 10);
    const filename = `tecnitec_backup_${fecha}.db`;
    const tmpPath  = path.join(__dirname, 'backups', filename);
    try {
        if (!fs.existsSync(path.join(__dirname, 'backups'))) fs.mkdirSync(path.join(__dirname, 'backups'), { recursive: true });
        db.backup(tmpPath);
        res.download(tmpPath, filename, (dlErr) => {
            if (dlErr) logger.error('[Backup] Error enviando archivo:', dlErr.message);
        });
    } catch(err) {
        logger.error('[Backup] Error generando backup para descarga:', err.message);
        res.status(500).json({ error: 'Error al generar backup: ' + err.message });
    }
});

app.get('/api/backup/gdrive-status', ...soloAdmin, (req, res) => {
    res.json(backupService.getEstado());
});

app.post('/api/backup/gdrive-config', ...soloAdmin, (req, res) => {
    const { folderId, credentialsJson } = req.body;
    try {
        if (folderId) {
            fs.writeFileSync(path.join(DATA_DIR, 'backup_config.json'), JSON.stringify({ folderId }, null, 2));
            backupService.folderId = folderId;
        }
        if (credentialsJson) {
            fs.writeFileSync(path.join(DATA_DIR, 'gdrive_credentials.json'), credentialsJson);
            backupService.credentialsPath = path.join(DATA_DIR, 'gdrive_credentials.json');
        }
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/backup/gdrive-manual', ...soloAdmin, async (req, res) => {
    try {
        await backupService._ejecutarBackup();
        res.json(backupService.getEstado());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/pagos/config', ...soloAdmin, async (req, res) => {
    try {
        const c = await getCfgPagos();
        if (c.mp_access_token && c.mp_access_token.length > 8) c.mp_access_token = c.mp_access_token.substring(0, 8) + '••••••••';
        res.json(c);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pagos/config', ...soloAdmin, async (req, res) => {
    try {
        for (const [k, v] of Object.entries(req.body)) {
            if (k === 'mp_access_token' && String(v).includes('••••')) continue;
            await dbRun("INSERT OR REPLACE INTO pagos_config(clave,valor) VALUES(?,?)", [k, String(v)]);
        }
        res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pagos/test-conexion', ...soloAdmin, async (req, res) => {
    try {
        const c = await getCfgPagos();
        if (!c.mp_access_token) return res.json({ ok: false, msg: 'Access Token no configurado' });
        const r = await mpRequest('GET', '/v1/payment_methods', null, c.mp_access_token);
        res.json(r.status === 200 ? { ok: true, msg: '✅ Conexión exitosa' } : { ok: false, msg: '❌ Token inválido (' + r.status + ')' });
    } catch(e) { res.json({ ok: false, msg: 'Error de red: ' + e.message }); }
});

app.post('/api/pagos/crear-preferencia', ...adminOVendedor, async (req, res) => {
    try {
        const { monto, descripcion, ventaId, metodo } = req.body;
        if (!monto || monto <= 0) return res.status(400).json({ error: 'Monto inválido' });
        const c = await getCfgPagos();
        if (!c.mp_access_token) return res.status(503).json({ error: 'Mercado Pago no configurado.' });
        const appUrl = c.app_url || 'http://localhost:3000';
        const pref = {
            items: [{ title: descripcion || 'Pago TECNITEC', quantity: 1, unit_price: parseFloat(monto), currency_id: 'ARS' }],
            back_urls: { success: `${appUrl}/pago-ok`, failure: `${appUrl}/pago-error`, pending: `${appUrl}/pago-pendiente` },
            auto_return: 'approved', notification_url: `${appUrl}/webhook/mp`,
            statement_descriptor: 'TECNITEC', metadata: { venta_id: ventaId, sistema: 'tecnitec' }
        };
        if (metodo === 'tarjeta')   pref.payment_methods = { excluded_payment_types: [{ id: 'ticket' }, { id: 'bank_transfer' }] };
        if (metodo === 'billetera') pref.purpose = 'wallet_purchase';
        const r = await mpRequest('POST', '/checkout/preferences', pref, c.mp_access_token);
        if (r.status !== 201 && r.status !== 200) { logger.error('[Pagos] MP error:', r.body); return res.status(502).json({ error: 'Error MP: ' + (r.body?.message || r.status) }); }
        const link = c.mp_modo === 'produccion' ? r.body.init_point : r.body.sandbox_init_point;
        const ins  = await dbRun("INSERT INTO pagos(venta_id,metodo,monto,estado,proveedor,mp_preference_id) VALUES(?,?,?,?,?,?)", [ventaId || null, metodo || 'mp', monto, 'pendiente', 'mercadopago', r.body.id]);
        logger.info('[Pagos] Preferencia creada: ' + r.body.id);
        res.json({ ok: true, pagoId: ins.lastID, preferenceId: r.body.id, linkPago: link });
    } catch(e) { logger.error('[Pagos]', e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/pagos/:id/estado', ...adminOVendedor, async (req, res) => {
    try {
        const p = await dbGet("SELECT * FROM pagos WHERE id=?", [req.params.id]);
        if (!p) return res.status(404).json({ error: 'No encontrado' });
        if (p.estado === 'aprobado' || p.estado === 'rechazado') return res.json(p);
        if (p.mp_payment_id) {
            const c = await getCfgPagos();
            const r = await mpRequest('GET', '/v1/payments/' + p.mp_payment_id, null, c.mp_access_token);
            if (r.status === 200) {
                const ns = r.body.status === 'approved' ? 'aprobado' : r.body.status === 'rejected' ? 'rechazado' : 'pendiente';
                await dbRun("UPDATE pagos SET estado=?,mp_status=?,mp_detail=?,confirmado_en=CASE WHEN ?='aprobado' THEN datetime('now') ELSE confirmado_en END WHERE id=?", [ns, r.body.status, r.body.status_detail, ns, p.id]);
                p.estado = ns;
            }
        }
        res.json(p);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pagos/:id/confirmar-manual', ...adminOVendedor, async (req, res) => {
    try { await dbRun("UPDATE pagos SET estado='aprobado',proveedor='manual',confirmado_en=datetime('now') WHERE id=?", [req.params.id]); res.json({ ok: true }); }
    catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/webhook/mp', bodyParser.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    res.sendStatus(200);
    try {
        let body; try { body = JSON.parse(req.body.toString('utf8')); } catch(e) { return; }
        if (body.type === 'payment' && body.data?.id) {
            const c = await getCfgPagos(); if (!c.mp_access_token) return;
            const r = await mpRequest('GET', '/v1/payments/' + body.data.id, null, c.mp_access_token);
            if (r.status !== 200) return;
            const mp = r.body;
            let p = await dbGet("SELECT * FROM pagos WHERE mp_payment_id=?", [String(body.data.id)]);
            if (!p && mp.preference_id) p = await dbGet("SELECT * FROM pagos WHERE mp_preference_id=?", [mp.preference_id]);
            if (!p) { logger.warn('[Webhook/MP] Pago no encontrado: ' + body.data.id); return; }
            const ns = mp.status === 'approved' ? 'aprobado' : mp.status === 'rejected' ? 'rechazado' : 'pendiente';
            await dbRun("UPDATE pagos SET mp_payment_id=?,mp_status=?,mp_detail=?,estado=?,confirmado_en=CASE WHEN ?='aprobado' THEN datetime('now') ELSE confirmado_en END WHERE id=?", [String(body.data.id), mp.status, mp.status_detail, ns, ns, p.id]);
            if (ns === 'aprobado' && p.venta_id) await dbRun("UPDATE ventas SET pago_estado='completado',pago_externo_id=? WHERE id=?", [String(body.data.id), p.venta_id]);
            broadcastWS('pago_actualizado', { pagoId: p.id, ventaId: p.venta_id, estado: ns, monto: p.monto });
            logger.info('[Webhook/MP] Pago ' + p.id + ': ' + ns);
        }
    } catch(e) { logger.error('[Webhook/MP]', e.message); }
});

app.get('/pago-ok',       (_, res) => res.send('<html><body style="background:#0b0f1a;color:#10b981;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-size:2rem;">✅ Pago Aprobado</body></html>'));
app.get('/pago-error',    (_, res) => res.send('<html><body style="background:#0b0f1a;color:#ef4444;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-size:2rem;">❌ Pago No Aprobado</body></html>'));
app.get('/pago-pendiente',(_, res) => res.send('<html><body style="background:#0b0f1a;color:#f59e0b;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-size:2rem;">⏳ Pago Pendiente</body></html>'));

// ══════════════════════════════════════════════════════════════════════════════
// 19. MANEJO GLOBAL DE ERRORES
// ══════════════════════════════════════════════════════════════════════════════

// Middleware de error Express — captura excepciones de rutas async que llamen next(err)
// o que Express propague internamente. Evita que el servidor se caiga.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    logger.error(`[Express] Error no manejado en ${req.method} ${req.path}`, {
        err: err.message,
        stack: err.stack,
        ip: req.ip,
        usuario: req.user?.username || '-'
    });
    if (res.headersSent) return;
    res.status(500).json({ error: 'Error interno del servidor.', detalle: err.message });
});

// Captura de promesas rechazadas no manejadas — previene crashes silenciosos
process.on('unhandledRejection', (reason) => {
    logger.error('[Proceso] Promesa rechazada no manejada:', { reason: String(reason) });
});

process.on('uncaughtException', (err) => {
    logger.error('[Proceso] Excepción no capturada:', { err: err.message, stack: err.stack });
    // No cerramos el proceso — dejamos que el watchdog de main.js decida
});

// ══════════════════════════════════════════════════════════════════════════════
// 20. WHATSAPP BOT (whatsapp-web.js) — auto-respuesta IA a mensajes entrantes
// ══════════════════════════════════════════════════════════════════════════════
let waClient = null;
let waQR = null;
let _waIniciando = false;

async function _iniciarWABot() {
    if (_waIniciando) return;
    _waIniciando = true;
    try {
        const { Client } = require('whatsapp-web.js');
        const { mkdirSync } = require('fs');
        const sesionDir = path.join(DATA_DIR, 'wa-session');
        if (!fs.existsSync(sesionDir)) mkdirSync(sesionDir, { recursive: true });
        const puppeteer = require('puppeteer-core');
        const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
        // Verificar que Chrome existe
        if (!fs.existsSync(chromePath)) {
            logger.warn('[WA Bot] Chrome no encontrado en ' + chromePath + ', desactivando bot');
            _waIniciando = false;
            return;
        }
        waClient = new Client({
            puppeteer: { executablePath: chromePath, headless: true, args: ['--no-sandbox'] },
            session: null,
            authStrategy: new (require('whatsapp-web.js')).LocalAuth({ dataPath: sesionDir })
        });
        waClient.on('qr', (qr) => {
            waQR = qr;
            logger.info('[WA Bot] QR generado (escanear con WhatsApp)');
            broadcastWS('wa_qr', { qr });
        });
        waClient.on('ready', () => {
            waQR = null;
            logger.info('[WA Bot] Conectado!');
            try { db.prepare(`UPDATE whatsapp_sesion SET estado='LISTO', conectado_en=datetime('now'), ultima_actividad=datetime('now') WHERE id=1`).run(); } catch(_) {}
            broadcastWS('wa_status', { estado: 'LISTO', conectado: true });
        });
        waClient.on('message', async (msg) => {
            try {
                if (msg.fromMe) return; // Ignorar mensajes propios
                const texto = msg.body || '';
                if (!texto.trim()) return;
                const contacto = await msg.getContact();
                const nombre = contacto.pushname || contacto.name || msg.from;
                const telefono = msg.from;
                logger.info('[WA Bot] Mensaje de ' + nombre + ': ' + texto.substring(0, 80));
                // Broadcast para notificación (incluso si IA inactiva)
                broadcastWS('wa_message', { nombre, texto, telefono, fecha: new Date().toISOString(), origen: 'bot' });
                // Verificar si auto-respuesta IA está activa
                const cfg = await dbGet("SELECT valor FROM chatbot_config WHERE clave='ai_activo'");
                if (!cfg || cfg.valor !== '1') return;
                // Guardar en DB como consulta pendiente
                const result = await dbRun(
                    "INSERT INTO consultas_presupuesto (telefono_cliente, nombre_cliente, descripcion, fecha, estado) VALUES (?,?,?,?,?)",
                    [telefono, nombre, texto, new Date().toISOString(), 'pendiente']
                );
                const consultaId = result.lastInsertRowid;
                // Generar respuesta IA
                const respuesta = await generarRespuestaIA(texto, `\nMensaje de WhatsApp de ${nombre}, tel: ${telefono}`);
                if (respuesta) {
                    await msg.reply(respuesta);
                    await dbRun(
                        `UPDATE consultas_presupuesto SET estado='respondida', tecnico_asignado='IA Automática', fecha_respuesta=?, respuesta_automatica=1, respuesta_ia=? WHERE id=?`,
                        [new Date().toISOString(), respuesta, consultaId]
                    );
                    logger.info('[WA Bot] Respuesta enviada a ' + nombre);
                    broadcastWS('consulta_respondida', { consulta_id: consultaId, respuesta });
                }
            } catch(e) {
                logger.warn('[WA Bot] Error procesando mensaje: ' + e.message);
            }
        });
        waClient.on('disconnected', (reason) => {
            logger.warn('[WA Bot] Desconectado: ' + reason);
            try { db.prepare(`UPDATE whatsapp_sesion SET estado='DESCONECTADO' WHERE id=1`).run(); } catch(_) {}
            broadcastWS('wa_status', { estado: 'DESCONECTADO', conectado: false });
            waClient = null;
            // Reintentar después de 30s
            setTimeout(() => { _waIniciando = false; _iniciarWABot(); }, 30000);
        });
        await waClient.initialize();
    } catch(e) {
        logger.warn('[WA Bot] Error al iniciar: ' + e.message);
        _waIniciando = false;
        // Reintentar después de 60s
        setTimeout(_iniciarWABot, 60000);
    }
}

// Endpoints para el bot
app.get('/api/wa-bot/qr', (req, res) => {
    res.json({ qr: waQR, conectado: waClient ? true : false });
});
app.post('/api/wa-bot/disconnect', async (req, res) => {
    try {
        if (waClient) { await waClient.destroy(); waClient = null; }
        waQR = null;
        try { db.prepare(`UPDATE whatsapp_sesion SET estado='DESCONECTADO' WHERE id=1`).run(); } catch(_) {}
        broadcastWS('wa_status', { estado: 'DESCONECTADO', conectado: false });
        res.json({ ok: true });
    } catch(e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/wa-bot/connect', async (req, res) => {
    if (waClient) return res.json({ ok: true, conectado: true });
    _iniciarWABot();
    res.json({ ok: true });
});

// Iniciar bot después de que el servidor esté arriba
setTimeout(_iniciarWABot, 5000);

// ══════════════════════════════════════════════════════════════════════════════
// 21. INICIO DEL SERVIDOR
// ══════════════════════════════════════════════════════════════════════════════
correrMigraciones()
    .then(() => {
        migracionLista = true;
        const httpServer = http.createServer(app);
        const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
        global._wss = wss;
        wss.on('connection', async (ws) => {
            logger.info('[WS] Cliente conectado');
            try {
                const row = await dbGet('SELECT estado FROM whatsapp_sesion WHERE id=1');
                ws.send(JSON.stringify({ tipo: 'wa_status', estado: row?.estado || 'DESCONECTADO', conectado: row?.estado === 'LISTO', ts: Date.now() }));
            } catch(_) {}
            ws.on('message', (raw) => {
                try {
                    const msg = JSON.parse(raw.toString());
                    if (!msg.tipo) return;
                    broadcastWS(msg.tipo, msg);
                    if (msg.tipo === 'wa_ready') {
                        try { db.prepare(`UPDATE whatsapp_sesion SET estado='LISTO', numero=?, nombre_cuenta=?, conectado_en=datetime('now'), ultima_actividad=datetime('now') WHERE id=1`).run(msg.numero || '', msg.nombre || ''); } catch(_) {}
                    } else if (msg.tipo === 'wa_disconnected') {
                        try { db.prepare(`UPDATE whatsapp_sesion SET estado='DESCONECTADO', numero=NULL, nombre_cuenta=NULL WHERE id=1`).run(); } catch(_) {}
                    } else if (msg.tipo === 'wa_status') {
                        try { db.prepare(`UPDATE whatsapp_sesion SET estado=?, ultima_actividad=datetime('now') WHERE id=1`).run(msg.estado || ''); } catch(_) {}
                    }
                } catch(_) {}
            });
            ws.on('close', () => logger.info('[WS] Cliente desconectado'));
            ws.on('error', (err) => logger.warn('[WS] Error:', err.message));
        });
        // Escuchar en 0.0.0.0 para aceptar conexiones de toda la red local (LAN)
        const PORT = parseInt(process.env.TECNITEC_PORT || '3000');
        httpServer.listen(PORT, '0.0.0.0', () => {
            const os = require('os');
            const ifaces = os.networkInterfaces();
            const ips = [];
            Object.values(ifaces).forEach(list => {
                (list||[]).forEach(iface => {
                    if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
                });
            });
            logger.info('');
            logger.info('🚀 ═══════════════════════════════════════════════');
            logger.info('   SERVIDOR TECNITEC CORE INICIADO               ');
            logger.info('   ═══════════════════════════════════════════    ');
            logger.info(`   📡 Local:   http://127.0.0.1:${PORT}             `);
            ips.forEach(ip => logger.info(`   🌐 Red LAN: http://${ip}:${PORT}           `));
            logger.info(`   🔌 WS:      ws://0.0.0.0:${PORT}/ws             `);
            logger.info('   📱 WhatsApp: listo para conectar               ');
            logger.info('   📁 Logs en: ./logs/                            ');
            logger.info('═══════════════════════════════════════════════  ');
        });
    })
    .catch(err => {
        logger.error('Error fatal en migraciones', { err: err.message });
        process.exit(1);
    });
