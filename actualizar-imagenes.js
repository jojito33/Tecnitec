// Script para actualizar imágenes placeholder en la base de datos
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'tecnitec_v31.db');
const db = new sqlite3.Database(dbPath);

// SVG placeholder local
const placeholder_svg = "data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27200%27 height=%27200%27%3E%3Crect width=%27200%27 height=%27200%27 fill=%27%231e293b%27/%3E%3Ctext x=%2750%25%27 y=%2750%25%27 dominant-baseline=%27middle%27 text-anchor=%27middle%27 font-family=%27Arial%27 font-size=%2720%27 fill=%27%23ef4444%27%3EPRODUCTO%3C/text%3E%3C/svg%3E";

console.log('🔄 Actualizando imágenes placeholder...');

// Actualizar todos los productos con via.placeholder.com
db.run(`
    UPDATE productos 
    SET imagen_url = ? 
    WHERE imagen_url LIKE '%via.placeholder.com%'
`, [placeholder_svg], function(err) {
    if (err) {
        console.error('❌ Error:', err.message);
        db.close();
        return;
    }
    
    console.log(`✅ ${this.changes} productos actualizados`);
    
    // Verificar productos
    db.all('SELECT codigo, nombre, imagen_url FROM productos LIMIT 5', [], (err, rows) => {
        if (err) {
            console.error('❌ Error:', err.message);
        } else {
            console.log('\n📋 Productos actualizados:');
            rows.forEach(row => {
                const imgPreview = row.imagen_url ? row.imagen_url.substring(0, 50) + '...' : 'Sin imagen';
                console.log(`  - ${row.codigo}: ${row.nombre}`);
                console.log(`    ${imgPreview}`);
            });
        }
        
        db.close();
        console.log('\n✅ Base de datos actualizada correctamente');
        console.log('💡 Reinicia la aplicación: npm start');
    });
});
