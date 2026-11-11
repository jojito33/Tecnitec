'use strict';
// ══════════════════════════════════════════════════════════════════
// license.js — Validación contra Supabase
// Soporta múltiples dispositivos por licencia (max_devices)
// ══════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

// ── CONFIGURACIÓN ────────────────────────────────────────────────
const SB_URL  = process.env.SB_URL  || 'https://oyacyrkgvxmxwzfgwlco.supabase.co';
const SB_KEY  = process.env.SB_KEY  || 'sb_publishable_EAPpEw0Pf9objgMD_bdMQg_1is5aMyk';
const LICENSE_KEY = process.env.LICENSE_KEY || 'TECT-GZLC-XFYL-VLDW';

const GRACE_DAYS = 5;
const TIMEOUT_MS = 15000;
const CACHE_PATH = path.join(os.homedir(), '.tecnitec_license_cache');

// ── MACHINE ID ROBUSTO ───────────────────────────────────────────
// Usa múltiples fuentes para generar un ID estable entre dev y build
function getMachineId() {
  try {
    // Intentar leer un ID guardado localmente primero
    // Esto garantiza estabilidad entre reinstalaciones y builds
    const idPath = path.join(os.homedir(), '.tecnitec_mid');
    if (fs.existsSync(idPath)) {
      const saved = fs.readFileSync(idPath, 'utf8').trim();
      if (saved && saved.length === 32) return saved;
    }

    // Generar nuevo ID basado en hardware
    const nets = os.networkInterfaces();
    const macs = [];
    for (const ifaces of Object.values(nets)) {
      for (const i of (ifaces || [])) {
        if (!i.internal && i.mac && i.mac !== '00:00:00:00:00:00') {
          macs.push(i.mac);
        }
      }
    }
    // Ordenar MACs para que el resultado sea consistente
    // independientemente del orden que devuelva el OS
    macs.sort();

    const seed = `${os.hostname()}::${macs.join('|')}::${os.platform()}`;
    const id   = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32);

    // Guardar para uso futuro — garantiza estabilidad
    try { fs.writeFileSync(idPath, id, 'utf8'); } catch(_) {}

    return id;
  } catch(e) {
    // Fallback: solo hostname
    return crypto.createHash('sha256').update(os.hostname()).digest('hex').slice(0, 32);
  }
}

// ── CACHE CIFRADO ────────────────────────────────────────────────
const CACHE_ENC_KEY = crypto.createHash('sha256')
  .update(SB_KEY.slice(0, 20) + os.hostname())
  .digest();

function writeCache(data) {
  try {
    const iv  = crypto.randomBytes(16);
    const cip = crypto.createCipheriv('aes-256-cbc', CACHE_ENC_KEY, iv);
    const txt = JSON.stringify({ ...data, _cachedAt: Date.now(), _machineId: getMachineId() });
    const enc = Buffer.concat([cip.update(txt, 'utf8'), cip.final()]);
    fs.writeFileSync(CACHE_PATH, JSON.stringify({ v:3, iv: iv.toString('hex'), enc: enc.toString('hex') }), 'utf8');
  } catch(e) {}
}

function readCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (raw.v !== 3) return null;
    const iv  = Buffer.from(raw.iv,  'hex');
    const enc = Buffer.from(raw.enc, 'hex');
    const dec = crypto.createDecipheriv('aes-256-cbc', CACHE_ENC_KEY, iv);
    return JSON.parse(Buffer.concat([dec.update(enc), dec.final()]).toString('utf8'));
  } catch(e) { return null; }
}

// ── HTTP helpers ──────────────────────────────────────────────────
function sbRequest(method, urlStr, body) {
  return new Promise((resolve, reject) => {
    const u       = new URL(urlStr);
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      'apikey':        SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=representation',
    };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method, headers, timeout: TIMEOUT_MS },
      res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: raw ? JSON.parse(raw) : null }); }
          catch(e) { reject(new Error('Respuesta inválida de Supabase')); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sbGet   = (url)       => sbRequest('GET',   url, null);
const sbPatch = (url, body) => sbRequest('PATCH', url, body);
const sbPost  = (url, body) => sbRequest('POST',  url, body);

// ── Log de eventos (best-effort) ──────────────────────────────────
function logEvent(type, detail = {}) {
  sbPost(`${SB_URL}/rest/v1/events`, {
    type, lic_key: LICENSE_KEY,
    client: detail.client || null,
    detail: detail.detail || null,
    ip:     os.hostname(),
    ts:     new Date().toISOString(),
  }).catch(() => {});
}

// ══════════════════════════════════════════════════════════════════
// validate()
// ══════════════════════════════════════════════════════════════════
async function validate() {
  const machineId = getMachineId();
  const daysLeft  = (exp) => Math.ceil((new Date(exp + 'T23:59:59Z') - Date.now()) / 86400000);

  try {
    const enc = encodeURIComponent(LICENSE_KEY.trim().toUpperCase());
    const { status, data } = await sbGet(
      `${SB_URL}/rest/v1/licenses?key=ilike.${enc}&select=*&limit=1`
    );

    if (status !== 200 || !Array.isArray(data) || !data.length) {
      logEvent('not_found');
      return { valid: false, source: 'server', code: 'NOT_FOUND', error: 'Licencia no encontrada.' };
    }

    const lic = data[0];

    if (lic.status === 'suspended') {
      logEvent('suspended', { client: lic.client_name });
      return { valid: false, source: 'server', code: 'SUSPENDED', error: 'Licencia suspendida.' };
    }
    if (lic.status === 'revoked') {
      return { valid: false, source: 'server', code: 'REVOKED', error: 'Licencia revocada.' };
    }

    const dl = lic.plan === 'permanente' ? null : daysLeft(lic.expires_at);
    if (dl !== null && dl < 0) {
      logEvent('expired', { client: lic.client_name });
      return {
        valid: false, source: 'server', code: 'EXPIRED',
        error: `Licencia vencida el ${lic.expires_at}.\n\nContactá a tu proveedor para renovarla.`,
        expiresAt: lic.expires_at, daysLeft: dl,
      };
    }

    // ── Lógica multi-dispositivo ─────────────────────────────────
    const maxDevices  = lic.max_devices || 3;
    const machineIds  = Array.isArray(lic.machine_ids) ? lic.machine_ids : [];

    const alreadyRegistered = machineIds.includes(machineId);

    if (!alreadyRegistered) {
      // Este dispositivo es nuevo para esta licencia
      if (machineIds.length >= maxDevices) {
        // Ya se alcanzó el límite de dispositivos
        logEvent('machine_mismatch', {
          client: lic.client_name,
          detail: `Límite de ${maxDevices} dispositivos alcanzado. IDs: ${machineIds.join(', ')}`
        });
        return {
          valid: false, source: 'server', code: 'DEVICE_LIMIT',
          error: `Esta licencia ya está en uso en ${maxDevices} dispositivo${maxDevices !== 1 ? 's' : ''}.\n\nContactá a tu proveedor para ampliar el límite o liberar un dispositivo.`,
        };
      }

      // Hay lugar — registrar este dispositivo
      const newIds = [...machineIds, machineId];
      await sbPatch(
        `${SB_URL}/rest/v1/licenses?id=eq.${lic.id}`,
        { machine_ids: newIds, updated_at: new Date().toISOString() }
      );
      logEvent('machine_bound', {
        client: lic.client_name,
        detail: `Dispositivo ${machineIds.length + 1}/${maxDevices} — ${os.hostname()}`
      });
    }

    // Actualizar stats en background
    sbPatch(`${SB_URL}/rest/v1/licenses?id=eq.${lic.id}`, {
      validations: (lic.validations || 0) + 1,
      last_seen:   new Date().toISOString(),
      last_ip:     os.hostname(),
      updated_at:  new Date().toISOString(),
    }).catch(() => {});

    logEvent('ok', {
      client: lic.client_name,
      detail: `${os.hostname()} — ${dl === null ? '∞' : dl + 'd'}`
    });

    const result = {
      valid:         true,
      source:        'server',
      offline:       false,
      code:          'OK',
      clientName:    lic.client_name,
      clientCompany: lic.client_company,
      plan:          lic.plan,
      daysLeft:      dl,
      expiresAt:     lic.plan === 'permanente' ? null : lic.expires_at,
      graceDays:     GRACE_DAYS,
    };

    writeCache(result);
    return result;

  } catch(networkErr) {
    console.log('[license] Sin conexión a Supabase:', networkErr.message);

    const cache = readCache();
    if (!cache) {
      return {
        valid: false, source: 'error', code: 'NO_CACHE',
        error: 'No se pudo conectar al servidor de licencias\ny no hay datos de validación local.\n\nVerificá tu conexión a internet.',
      };
    }

    // Cache: no verificamos machine_id porque en red varios
    // dispositivos pueden tener cache de la misma licencia
    const daysSince = Math.floor((Date.now() - (cache._cachedAt || 0)) / 86400000);
    const grace     = cache.graceDays || GRACE_DAYS;

    if (daysSince > grace) {
      return {
        valid: false, source: 'cache', code: 'GRACE_EXPIRED',
        error: `Sin conexión al servidor de licencias\npor más de ${grace} días.\n\nConectate a internet y reiniciá la aplicación.`,
        graceDays: grace, daysOffline: daysSince,
      };
    }

    if (cache.expiresAt && cache.plan !== 'permanente') {
      const dl = Math.ceil((new Date(cache.expiresAt + 'T23:59:59Z') - Date.now()) / 86400000);
      if (dl < 0) {
        return {
          valid: false, source: 'cache', code: 'EXPIRED_OFFLINE',
          error: `Licencia vencida el ${cache.expiresAt}.\n\nContactá a tu proveedor para renovarla.`,
          expiresAt: cache.expiresAt,
        };
      }
    }

    return {
      ...cache, valid: true, source: 'cache', offline: true,
      daysOffline: daysSince, graceDays: grace,
      daysLeft: cache.daysLeft != null ? Math.max(0, cache.daysLeft - daysSince) : cache.daysLeft,
    };
  }
}

module.exports = { validate, getMachineId };
