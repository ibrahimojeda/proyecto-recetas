const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = 8001;
const DATA_DIR = path.join(__dirname, 'data-recetas');

// Middleware
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname));

// Asegurar que existe el directorio de datos
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const RECETAS_FILE = path.join(DATA_DIR, 'recetas.json');
const MPS_FILE = path.join(DATA_DIR, 'materias-primas.json');
const RECOVERY_STATE_FILE = path.join(DATA_DIR, 'recovery-state.json');

// Helpers
const loadJSON = (file, def) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : def;
const saveJSON = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

// Ruta de estado para comprobaciones del frontend
app.get('/status', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Recovery bridge state (for migration from file:// localStorage to localhost)
app.get('/api/recovery-state', (req, res) => {
    if (!fs.existsSync(RECOVERY_STATE_FILE)) {
        return res.status(404).json({ error: 'No recovery state available' });
    }
    try {
        const payload = JSON.parse(fs.readFileSync(RECOVERY_STATE_FILE, 'utf8'));
        res.json(payload);
    } catch {
        res.status(500).json({ error: 'Recovery state is corrupted' });
    }
});

app.post('/api/recovery-state', (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object') {
        return res.status(400).json({ error: 'Invalid recovery payload' });
    }

    const state = body.state && typeof body.state === 'object' ? body.state : body;
    if (!Array.isArray(state.recetas) || !Array.isArray(state.materiasPrimas)) {
        return res.status(400).json({ error: 'Recovery payload missing recetas/materiasPrimas arrays' });
    }

    const payload = {
        source: String(body.source || 'unknown'),
        savedAt: new Date().toISOString(),
        state
    };

    fs.writeFileSync(RECOVERY_STATE_FILE, JSON.stringify(payload, null, 2));
    res.json({ success: true, recetas: state.recetas.length, materiasPrimas: state.materiasPrimas.length });
});

app.delete('/api/recovery-state', (req, res) => {
    if (fs.existsSync(RECOVERY_STATE_FILE)) {
        fs.unlinkSync(RECOVERY_STATE_FILE);
    }
    res.json({ success: true });
});

// Rutas API - Materias Primas
app.get('/api/mps', (req, res) => res.json(loadJSON(MPS_FILE, [])));
app.post('/api/mps', (req, res) => {
    const mps = loadJSON(MPS_FILE, []);
    const newMp = { ...req.body, id: uuidv4() };
    mps.push(newMp);
    saveJSON(MPS_FILE, mps);
    res.json(newMp);
});
app.delete('/api/mps/:id', (req, res) => {
    let mps = loadJSON(MPS_FILE, []);
    mps = mps.filter(m => m.id !== req.params.id);
    saveJSON(MPS_FILE, mps);
    res.json({ success: true });
});

// Rutas API - Recetas
app.get('/api/recetas', (req, res) => res.json(loadJSON(RECETAS_FILE, [])));

app.post('/api/recetas', (req, res) => {
    const recetas = loadJSON(RECETAS_FILE, []);
    const nueva = { ...req.body, id: uuidv4() };
    recetas.push(nueva);
    saveJSON(RECETAS_FILE, recetas);
    res.json(nueva);
});

app.put('/api/recetas/:id', (req, res) => {
    let recetas = loadJSON(RECETAS_FILE, []);
    recetas = recetas.map(r => r.id === req.params.id ? req.body : r);
    saveJSON(RECETAS_FILE, recetas);
    res.json({ success: true });
});

app.delete('/api/recetas/:id', (req, res) => {
    let recetas = loadJSON(RECETAS_FILE, []);
    recetas = recetas.filter(r => r.id !== req.params.id);
    saveJSON(RECETAS_FILE, recetas);
    res.json({ success: true });
});

// Servir index.html de recetas por defecto
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const server = app.listen(PORT, () => {
    console.log(`🍎 Sistema de Recetas activo en http://localhost:${PORT}`);
}).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n[!] ERROR: El puerto ${PORT} ya está siendo usado por otro programa.`);
        console.error(`[!] Por favor, cierra cualquier otra ventana de comandos o servidor y reintenta.\n`);
        process.exit(1);
    } else {
        console.error(`[!] Error al iniciar el servidor:`, err);
    }
});