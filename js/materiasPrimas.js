let materiasPrimas = [];

// --- Módulo de Servicio de Inventario (API) ---
const MPS_SERVICE = {
  async getAll() {
    try {
      const res = await fetch(`${API_URL}/mps`);
      if (!res.ok) {
        throw new Error(`Error del servidor: ${res.status}`);
      }
      const data = await res.json();
      materiasPrimas = Array.isArray(data) ? data : [];
      return materiasPrimas;
    } catch (err) {
      console.error("Fallo al cargar inventario:", err);
      return [];
    }
  },
  async save(data) {
    const res = await fetch(`${API_URL}/mps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return await res.json();
  },
  async delete(id) {
    const res = await fetch(`${API_URL}/mps/${id}`, { method: 'DELETE' });
    return await res.json();
  }
};

async function cargarMateriasPrimas() {
  return await MPS_SERVICE.getAll();
}

async function cargarSelectMaterias() {
  await MPS_SERVICE.getAll();
  const select = document.getElementById("ingredienteMP");
  if (!select) return;

  select.innerHTML = materiasPrimas.map(mp => 
    `<option value="${mp.id}">${mp.nombre}</option>`
  ).join('');
}

async function agregarMateriaPrimaUI() {
  const nombre = document.getElementById("mpNombre").value;
  const proveedor = document.getElementById("mpProveedor").value;
  const unidadBase = document.getElementById("mpUnidad").value || "u";
  const cantidadEmpaque = parseFloat(document.getElementById("mpCantidadEmpaque").value) || 1;
  const precioEmpaque = parseFloat(document.getElementById("mpPrecioEmpaque").value) || 0;

  if (!nombre) { alert("El nombre es obligatorio"); return; }

  const nuevaMp = { nombre, proveedor, unidadBase, cantidadEmpaque, precioEmpaque };
  await MPS_SERVICE.save(nuevaMp);

  renderMateriasPrimas();
  cargarSelectMaterias();
}

async function eliminarMP(id) {
  if (!confirm("¿Está seguro de eliminar esta materia prima? Esta acción no se puede deshacer.")) return;
  await MPS_SERVICE.delete(id);
  renderMateriasPrimas();
  cargarSelectMaterias();
}

async function renderMateriasPrimas(filtro = "") {
  await MPS_SERVICE.getAll();
  const cont = document.getElementById("listaMaterias");
  if (!cont) return;

  const mpsFiltradas = materiasPrimas.filter(m => 
    m.nombre?.toLowerCase().includes(filtro.toLowerCase()) ||
    m.proveedor?.toLowerCase().includes(filtro.toLowerCase())
  );

  let html = `
    <div class="flex flex-col gap-6 mb-8 bg-white p-8 rounded-3xl border border-emerald-100 shadow-sm relative overflow-hidden">
      <div class="absolute -right-4 -top-4 p-8 opacity-5 text-organic-green">
        <i data-lucide="package" class="w-24 h-24"></i>
      </div>
      
      <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 class="text-2xl font-black text-slate-800 tracking-tight">Inventario de Materias Primas</h2>
          <p class="text-sm text-slate-400 font-medium">Gestiona los insumos base para tus costeros.</p>
        </div>
        <button onclick="importarMateriasPrimasCSV()" class="bg-white text-organic-green border-2 border-organic-green px-6 py-3 rounded-2xl font-bold hover:bg-emerald-50 transition-all flex items-center gap-3 shadow-sm group">
          <i data-lucide="upload-cloud" class="w-5 h-5 group-hover:-translate-y-1 transition-transform"></i> Carga Masiva (CSV)
        </button>
      </div>

      <div class="relative w-full md:w-96">
        <div class="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-slate-400">
          <i data-lucide="search" class="w-4 h-4"></i>
        </div>
        <input type="text" 
               placeholder="Buscar por nombre o proveedor..." 
               class="pl-11 pr-4 py-3 w-full border border-emerald-100 rounded-xl bg-emerald-50/30 focus:bg-white focus:ring-2 focus:ring-organic-green outline-none transition-all text-sm"
               oninput="renderMateriasPrimas(this.value)"
               value="${filtro}">
      </div>
    </div>
  `;

  if (mpsFiltradas.length === 0) {
    html += `
      <div class="text-center py-20 bg-white rounded-3xl border border-dashed border-slate-200">
        <i data-lucide="package-search" class="w-12 h-12 mx-auto text-slate-300 mb-4"></i>
        <p class="text-slate-400 font-medium">No se encontraron materias primas en el inventario.</p>
      </div>
    `;
  }

  html += mpsFiltradas.map(m => `
    <div class="flex items-center justify-between p-4 bg-white border border-emerald-50 rounded-xl mb-3 hover:border-emerald-200 transition-all shadow-sm">
      <div class="flex items-center gap-4">
        <div class="w-10 h-10 bg-emerald-50 rounded-lg flex items-center justify-center text-organic-green">
          <i data-lucide="beaker" class="w-5 h-5"></i>
        </div>
        <div>
          <div class="font-bold text-slate-800">${m.nombre}</div>
          <div class="text-xs text-slate-500 font-medium uppercase tracking-wide">${m.proveedor || 'Sin proveedor'} | ${m.unidadBase}</div>
        </div>
      </div>
      <div class="flex items-center gap-6">
        <div class="text-right">
          <div class="text-lg font-bold text-organic-green">$${m.precioEmpaque.toFixed(2)}</div>
          <div class="text-[10px] text-slate-400 font-bold uppercase">Precio Empaque</div>
        </div>
        <button onclick="eliminarMP('${m.id}')" class="p-2 text-slate-400 hover:text-rose-500 hover:bg-rose-50 rounded-lg transition-all">
          <i data-lucide="trash-2" class="w-5 h-5"></i>
        </button>
      </div>
    </div>
  `).join('');
  cont.innerHTML = html;
  lucide.createIcons();
}

async function importarMateriasPrimasCSV() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv';
  input.onchange = async e => {
    const file = e.target.files[0];
    const reader = new FileReader();
    reader.onload = async event => {
      const text = event.target.result;
      // Soporte para saltos de línea Windows/Unix y filtrado de líneas vacías
      const rows = text.split(/\r?\n/).filter(r => r.trim());
      // Saltar cabecera si existe
      const dataRows = (rows[0].toLowerCase().includes('nombre')) ? rows.slice(1) : rows;
      
      let count = 0;
      for (let row of dataRows) {
        // Detectar si el separador es coma o punto y coma
        const delimiter = row.includes(';') ? ';' : ',';
        const cols = row.split(delimiter).map(c => c.trim());
        
        if (cols.length >= 5) {
          const nuevaMp = {
            nombre: cols[0],
            proveedor: cols[1],
            unidadBase: cols[2],
            cantidadEmpaque: parseFloat(cols[3].replace(',', '.')) || 1,
            precioEmpaque: parseFloat(cols[4].replace(',', '.')) || 0
          };
          await MPS_SERVICE.save(nuevaMp);
          count++;
        }
      }
      renderMateriasPrimas();
      cargarSelectMaterias();
      alert(`Inventario cargado: ${count} materias primas procesadas con éxito.`);
    };
    reader.readAsText(file);
  };
  input.click();
}