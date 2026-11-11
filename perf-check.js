// Presupuesto de rendimiento TECNITEC CORE
// Mide p50/p95 de los endpoints principales y reporta métricas.
// Uso: node perf-check.js [baseUrl] [repeticiones]
// Ejemplo: node perf-check.js http://127.0.0.1:3000 200
'use strict';

const http = require('http');

const baseUrl = process.argv[2] || 'http://127.0.0.1:3000';
const repeticiones = parseInt(process.argv[3] || '200', 10);
const endpoints = ['/api/health'];

function request(path) {
    return new Promise((resolve, reject) => {
        const inicio = process.hrtime.bigint();
        const req = http.request(`${baseUrl}${path}`, { method: 'GET', timeout: 5000 }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                const fin = process.hrtime.bigint();
                const ms = Number(fin - inicio) / 1_000_000;
                resolve({ status: res.statusCode, ms, ok: res.statusCode < 400 });
            });
        });
        req.on('error', (e) => { reject({ path, error: e.message }); });
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.end();
    });
}

function percentile(sorted, p) {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

async function main() {
    console.log(`Presupuesto de rendimiento TECNITEC CORE`);
    console.log(`Base: ${baseUrl} | Repeticiones: ${repeticiones}`);
    console.log(`Fecha: ${new Date().toISOString()}`);
    console.log('');

    const resultados = {};

    for (const ep of endpoints) {
        const tiempos = [];
        let fallos = 0;
        for (let i = 0; i < repeticiones; i++) {
            try {
                const r = await request(ep);
                tiempos.push(r.ms);
                if (!r.ok) fallos++;
            } catch (e) {
                fallos++;
            }
        }
        tiempos.sort((a, b) => a - b);
        const suma = tiempos.reduce((a, b) => a + b, 0);
        resultados[ep] = {
            n: tiempos.length,
            fallos,
            min: tiempos[0] || 0,
            max: tiempos[tiempos.length - 1] || 0,
            promedio: tiempos.length ? (suma / tiempos.length) : 0,
            p50: percentile(tiempos, 50),
            p95: percentile(tiempos, 95),
            p99: percentile(tiempos, 99)
        };
    }

    console.log('Endpoint        n     fallos  min(ms)  max(ms)  prom(ms)  p50(ms)  p95(ms)  p99(ms)');
    for (const [ep, r] of Object.entries(resultados)) {
        console.log(
            `${ep.padEnd(16)} ${String(r.n).padEnd(6)} ${String(r.fallos).padEnd(8)} ` +
            `${r.min.toFixed(2).padEnd(8)} ${r.max.toFixed(2).padEnd(8)} ` +
            `${r.promedio.toFixed(2).padEnd(9)} ${r.p50.toFixed(2).padEnd(8)} ` +
            `${r.p95.toFixed(2).padEnd(8)} ${r.p99.toFixed(2)}`
        );
    }

    const salud = resultados['/api/health'];
    const p95Ok = salud && salud.p95 <= 100;
    console.log('');
    console.log(`Umbral p95 API local: ≤ 100 ms → ${p95Ok ? 'CUMPLE' : 'NO CUMPLE'}`);
    console.log(`Resultado guardado: comparar contra línea base T0 antes/después de cada release.`);
}

main().catch((e) => { console.error('Error:', e); process.exit(1); });
