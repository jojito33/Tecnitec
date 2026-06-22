const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const ver = '28.3.3';
const url = 'https://github.com/electron/electron/releases/download/v' + ver + '/electron-v' + ver + '-win32-x64.zip';
const zipPath = path.join(__dirname, 'electron-tmp.zip');
const distPath = path.join(__dirname, 'node_modules/electron/dist');

if (fs.existsSync(path.join(distPath, 'electron.exe'))) {
    console.log('Electron ya instalado');
    process.exit(0);
}

if (!fs.existsSync(distPath)) {
    fs.mkdirSync(distPath, { recursive: true });
}

function download(u) {
    https.get(u, { headers: { 'Accept': 'application/octet-stream' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            console.log('Redirigiendo...');
            download(res.headers.location);
            return;
        }
        if (res.statusCode !== 200) {
            console.error('Error HTTP: ' + res.statusCode);
            process.exit(1);
        }
        console.log('Descargando Electron ' + ver + ' (' + (res.headers['content-length'] || '?') + ' bytes)...');
        const file = fs.createWriteStream(zipPath);
        res.pipe(file);
        file.on('finish', () => {
            file.close();
            console.log('Descomprimiendo...');
            try {
                execSync('tar -xf "' + zipPath + '" -C "' + distPath + '"', { shell: true, timeout: 60000 });
                fs.unlinkSync(zipPath);
                console.log('Electron instalado correctamente');
                process.exit(0);
            } catch (e) {
                console.error('Error al descomprimir: ' + e.message);
                process.exit(1);
            }
        });
    }).on('error', (e) => {
        console.error('Error de descarga: ' + e.message);
        process.exit(1);
    });
}

download(url);
