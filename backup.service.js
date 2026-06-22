const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

class BackupService {
    constructor() {
        this.credentialsPath = null;
        this.folderId = null;
        this.dbPath = null;
        this.backupDir = null;
        this.lastBackup = null;
        this.status = 'IDLE'; // IDLE, BUSY, ERROR
        this.error = null;
        this._debounceTimer = null;
    }

    init(config) {
        this.credentialsPath = config.credentialsPath;
        this.folderId = config.folderId;
        this.dbPath = config.dbPath;
        this.backupDir = config.backupDir;
        this.db = config.db; // Recibimos la instancia de better-sqlite3
        
        if (!fs.existsSync(this.backupDir)) {
            fs.mkdirSync(this.backupDir, { recursive: true });
        }
    }

    async subirBackup() {
        if (this._debounceTimer) clearTimeout(this._debounceTimer);
        
        this._debounceTimer = setTimeout(async () => {
            await this._ejecutarBackup();
        }, 60000); // Debounce de 60 segundos
    }

    async _ejecutarBackup() {
        if (!this.credentialsPath || !fs.existsSync(this.credentialsPath)) {
            this.status = 'ERROR';
            this.error = 'Credenciales no encontradas';
            return;
        }

        try {
            this.status = 'BUSY';
            this.error = null;

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const fileName = `tecnitec_backup_${timestamp}.db`;
            const localPath = path.join(this.backupDir, fileName);
            const gzipPath = `${localPath}.gz`;

            // 1. Crear backup local
            this.db.backup(localPath);

            // 2. Comprimir
            const inp = fs.createReadStream(localPath);
            const out = fs.createWriteStream(gzipPath);
            const gzip = zlib.createGzip();

            await new Promise((resolve, reject) => {
                inp.pipe(gzip).pipe(out).on('finish', resolve).on('error', reject);
            });

            // 3. Subir a Google Drive
            const { google } = require('googleapis');
            const auth = new google.auth.GoogleAuth({
                keyFile: this.credentialsPath,
                scopes: ['https://www.googleapis.com/auth/drive.file'],
            });

            const drive = google.drive({ version: 'v3', auth });
            
            const fileMetadata = {
                name: `${fileName}.gz`,
                parents: [this.folderId],
            };
            const media = {
                mimeType: 'application/gzip',
                body: fs.createReadStream(gzipPath),
            };

            const response = await drive.files.create({
                resource: fileMetadata,
                media: media,
                fields: 'id',
            });

            console.log('[Backup] Archivo subido a Drive con ID:', response.data.id);
            this.lastBackup = new Date().toISOString();
            this.status = 'IDLE';

            // 4. Limpieza: eliminar archivos locales temporales
            fs.unlinkSync(localPath);
            // Mantenemos el gzip local por si acaso, o lo borramos?
            // El plan dice mantener los últimos 10 locales viejos.
            this._limpiarBackupsLocales();

        } catch (err) {
            console.error('[Backup] Error:', err);
            this.status = 'ERROR';
            this.error = err.message;
        }
    }

    _limpiarBackupsLocales() {
        const files = fs.readdirSync(this.backupDir)
            .filter(f => f.endsWith('.gz'))
            .map(f => ({ name: f, time: fs.statSync(path.join(this.backupDir, f)).mtime.getTime() }))
            .sort((a, b) => b.time - a.time);

        if (files.length > 10) {
            for (let i = 10; i < files.length; i++) {
                fs.unlinkSync(path.join(this.backupDir, files[i].name));
            }
        }
    }

    getEstado() {
        return {
            status: this.status,
            lastBackup: this.lastBackup,
            error: this.error
        };
    }
}

module.exports = new BackupService();
