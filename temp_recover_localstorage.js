const fs = require('fs');
const files = [
  'C:/Users/venta/AppData/Local/Google/Chrome/User Data/Default/Local Storage/leveldb/007855.ldb',
  'C:/Users/venta/AppData/Local/Google/Chrome/User Data/Default/Local Storage/leveldb/007860.ldb'
];

function tryExtract(text) {
  const marker = '{"materiasPrimas":';
  let start = text.indexOf(marker);
  while (start >= 0) {
    let inStr = false;
    let esc = false;
    let depth = 0;
    for (let i = start; i < Math.min(text.length, start + 50000000); i++) {
      const ch = text[i];
      const code = ch.charCodeAt(0);
      if (code === 0) break;
      if (!inStr && (code < 9 || (code > 13 && code < 32))) break;
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') { inStr = false; continue; }
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') depth += 1;
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          const cand = text.slice(start, i + 1);
          try {
            const obj = JSON.parse(cand);
            if (obj && Array.isArray(obj.recetas) && Array.isArray(obj.materiasPrimas)) {
              return cand;
            }
          } catch {}
          break;
        }
      }
    }
    start = text.indexOf(marker, start + marker.length);
  }
  return null;
}

let recovered = null;
for (const f of files) {
  if (!fs.existsSync(f)) continue;
  const buf = fs.readFileSync(f);
  const text = buf.toString('latin1');
  const out = tryExtract(text);
  if (out) { recovered = out; break; }
}

if (!recovered) {
  console.log('RECOVERY_FAILED');
  process.exit(0);
}

const outFile = 'C:/Users/venta/OneDrive/Aplicaciones/proyecto-recetas/data-recetas/recovered-localstorage.json';
fs.mkdirSync('C:/Users/venta/OneDrive/Aplicaciones/proyecto-recetas/data-recetas', { recursive: true });
fs.writeFileSync(outFile, recovered);
const obj = JSON.parse(recovered);
console.log('RECOVERY_OK');
console.log('OUT=' + outFile);
console.log('RECETAS=' + (obj.recetas||[]).length);
console.log('MPS=' + (obj.materiasPrimas||[]).length);
