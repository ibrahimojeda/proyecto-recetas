const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = 8000;
const DATA_DIR = path.join(__dirname, 'data');

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb' }));
app.use(express.static(__dirname));

// Serve dojo-system.html as default
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dojo-system.html'));
});

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Helper: Get dojo folder path
const getDojoPath = (dojoId) => path.join(DATA_DIR, dojoId);

// Helper: Ensure dojo folder exists
const ensureDojoFolder = (dojoId) => {
  const dojoPath = getDojoPath(dojoId);
  if (!fs.existsSync(dojoPath)) {
    fs.mkdirSync(dojoPath, { recursive: true });
  }
  return dojoPath;
};

// Helper: Get config file path
const getConfigPath = () => path.join(DATA_DIR, 'config.json');

// Helper: Load config
const loadConfig = () => {
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  return {
    dojos: [{ id: uuidv4(), name: 'Mi Dojo', logo: '' }],
    users: [{ user: 'admin', pass: '1234', role: 'admin', dojoId: '' }],
    selectedDojo: ''
  };
};

// Helper: Save config
const saveConfig = (config) => {
  const configPath = getConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
};

// Helper: Get student file path
const getStudentPath = (dojoId, studentId) => {
  return path.join(ensureDojoFolder(dojoId), `${studentId}.json`);
};

// Helper: Load student
const loadStudent = (dojoId, studentId) => {
  const studentPath = getStudentPath(dojoId, studentId);
  if (fs.existsSync(studentPath)) {
    return JSON.parse(fs.readFileSync(studentPath, 'utf8'));
  }
  return null;
};

// Helper: Save student
const saveStudent = (dojoId, student) => {
  const studentPath = getStudentPath(dojoId, student.id);
  fs.writeFileSync(studentPath, JSON.stringify(student, null, 2));
};

// Helper: List students in dojo
const listStudents = (dojoId) => {
  const dojoPath = ensureDojoFolder(dojoId);
  try {
    const files = fs.readdirSync(dojoPath);
    return files
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const content = fs.readFileSync(path.join(dojoPath, f), 'utf8');
        return JSON.parse(content);
      });
  } catch {
    return [];
  }
};

// Routes

// GET /api/config - Load full config
app.get('/api/config', (req, res) => {
  const config = loadConfig();
  res.json(config);
});

// POST /api/config - Save config
app.post('/api/config', (req, res) => {
  const config = req.body;
  saveConfig(config);
  res.json({ success: true });
});

// POST /api/dojos - Create dojo
app.post('/api/dojos', (req, res) => {
  const { name, logo } = req.body;
  const config = loadConfig();
  const newDojo = { id: uuidv4(), name, logo };
  config.dojos.push(newDojo);
  saveConfig(config);
  ensureDojoFolder(newDojo.id);
  res.json(newDojo);
});

// DELETE /api/dojos/:dojoId - Delete dojo (only if no students)
app.delete('/api/dojos/:dojoId', (req, res) => {
  const { dojoId } = req.params;
  const config = loadConfig();
  
  const students = listStudents(dojoId);
  if (students.length > 0) {
    return res.status(400).json({ error: 'No se puede eliminar el Dojo: hay estudiantes asignados.' });
  }
  
  config.dojos = config.dojos.filter(d => d.id !== dojoId);
  if (config.selectedDojo === dojoId) {
    config.selectedDojo = config.dojos[0] ? config.dojos[0].id : '';
  }
  saveConfig(config);
  
  // Delete dojo folder
  const dojoPath = getDojoPath(dojoId);
  if (fs.existsSync(dojoPath)) {
    fs.rmSync(dojoPath, { recursive: true });
  }
  
  res.json({ success: true });
});

// GET /api/dojos/:dojoId/students - List students
app.get('/api/dojos/:dojoId/students', (req, res) => {
  const { dojoId } = req.params;
  const students = listStudents(dojoId);
  res.json(students);
});

// POST /api/dojos/:dojoId/students - Create student
app.post('/api/dojos/:dojoId/students', (req, res) => {
  const { dojoId } = req.params;
  const student = req.body;
  student.id = student.id || uuidv4();
  student.dojoId = dojoId;
  saveStudent(dojoId, student);
  res.json(student);
});

// GET /api/dojos/:dojoId/students/:studentId - Get student
app.get('/api/dojos/:dojoId/students/:studentId', (req, res) => {
  const { dojoId, studentId } = req.params;
  const student = loadStudent(dojoId, studentId);
  if (!student) {
    return res.status(404).json({ error: 'Estudiante no encontrado' });
  }
  res.json(student);
});

// PUT /api/dojos/:dojoId/students/:studentId - Update student
app.put('/api/dojos/:dojoId/students/:studentId', (req, res) => {
  const { dojoId, studentId } = req.params;
  const student = req.body;
  student.id = studentId;
  student.dojoId = dojoId;
  saveStudent(dojoId, student);
  res.json(student);
});

// DELETE /api/dojos/:dojoId/students/:studentId - Delete student
app.delete('/api/dojos/:dojoId/students/:studentId', (req, res) => {
  const { dojoId, studentId } = req.params;
  const studentPath = getStudentPath(dojoId, studentId);
  if (fs.existsSync(studentPath)) {
    fs.unlinkSync(studentPath);
  }
  res.json({ success: true });
});

// Start server
app.listen(PORT, () => {
  console.log(`🥋 Dojo System servidor activo en http://localhost:${PORT}`);
  console.log(`📁 Datos almacenados en: ${DATA_DIR}`);
});
