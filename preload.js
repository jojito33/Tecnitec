const { contextBridge, ipcRenderer } = require('electron');

// Exponemos una API segura al frontend mediante contextBridge.
// Esto evita que el frontend tenga acceso directo a Node.js (fs, child_process, etc.)
contextBridge.exposeInMainWorld('electronAPI', {
    // Enviar mensajes al proceso principal y recibir respuesta (invoke)
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),

    // Enviar mensajes sin esperar respuesta (send)
    send: (channel, ...args) => ipcRenderer.send(channel, ...args),

    // Escuchar eventos del proceso principal
    on: (channel, callback) => {
        const subscription = (event, ...args) => callback(...args);
        ipcRenderer.on(channel, subscription);
        return () => ipcRenderer.removeListener(channel, subscription);
    }
});
