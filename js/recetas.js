let recetas = [];

async function renderListadoRecetas() {
  const res = await fetch(`${API_URL}/recetas`);
  recetas = await res.json();

  const cont = document.getElementById("listaRecetas");
  if (!cont) return;

  let html = `<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">`;
  recetas.forEach((r) => {
    html += `
      <div class="bg-white p-6 rounded-2xl shadow-sm border border-emerald-50 hover:shadow-md transition-shadow group">
        <div class="flex justify-between items-start mb-4">
          <h3 class="text-lg font-bold text-slate-800 group-hover:text-organic-green transition-colors">${r.nombre || "Sin nombre"}</h3>
          <span class="px-3 py-1 bg-emerald-100 text-organic-green text-xs font-bold rounded-full uppercase tracking-wider">${nombreEstado(r.estado)}</span>
        </div>
        <div class="flex gap-2 mt-6">
          <button onclick="abrirReceta('${r.id}')" class="flex-grow bg-organic-green text-white py-2 px-4 rounded-xl font-semibold hover:bg-emerald-700 transition-colors flex items-center justify-center gap-2">
            <i data-lucide="eye" class="w-4 h-4"></i> Abrir
          </button>
          <button onclick="eliminarReceta('${r.id}')" class="p-2 text-rose-500 hover:bg-rose-50 rounded-xl transition-colors">
            <i data-lucide="trash-2" class="w-5 h-5"></i>
          </button>
        </div>
      </div>
    `;
  });
  html += `</div>`;
  cont.innerHTML = html;
  lucide.createIcons();
}

async function crearNuevaReceta() {
  const nuevaReceta = crearRecetaBase();
  const res = await fetch(`${API_URL}/recetas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(nuevaReceta)
  });
  receta = await res.json();
  irReceta();
}

function abrirReceta(id) {
  receta = recetas.find(r => r.id === id);
  irReceta();
}
function cargarDatosReceta() {

  document.getElementById("recetaNombre").value = receta.nombre;
  document.getElementById("recetaDescripcion").value = receta.descripcion;
}
function guardarDatosReceta() {

  const nombre = document.getElementById("recetaNombre").value;

  if (!nombre) {
    alert("El nombre es obligatorio");
    return;
  }

  receta.nombre = nombre;
  receta.descripcion =
    document.getElementById("recetaDescripcion").value;
  
  guardarReceta();

  alert("La receta fue guardada correctamente.");
}

function nombreEstado(estado) {

  switch (estado) {
    case ESTADOS.BORRADOR: return "Borrador";
    case ESTADOS.EDICION: return "En edición";
    case ESTADOS.CALCULADA: return "Calculada";
    case ESTADOS.PDF: return "PDF generado";
    default: return "";
  }

}
function renderEstadoActual() {

  const cont = document.getElementById("estadoReceta");

  if (!cont) return;

  cont.innerHTML = `Estado: ${nombreEstado(receta.estado)}`;
}
renderEstadoActual();

async function eliminarReceta(id) {
  if (!confirm("¿Eliminar esta receta?")) return;
  await fetch(`${API_URL}/recetas/${id}`, { method: 'DELETE' });
  renderListadoRecetas();
}

function agregarIngrediente() {
  const select = document.getElementById("ingredienteMP");
  const cantidadEl = document.getElementById("ingredienteCantidad");
  if (!select || !cantidadEl) return;
  
  const mpId = select.value;
  const cantidad = parseFloat(cantidadEl.value);
  if (!mpId || isNaN(cantidad) || cantidad <= 0) {
    alert("Seleccioná materia prima y una cantidad válida.");
    return;
  }

  const mp = materiasPrimas.find(m => m.id === mpId);
  const nombre = mp ? mp.nombre : "Desconocido";

  receta.ingredientes.push({ mpId: mpId, cantidad });

  registrarHistorial("Se agregó ingrediente: " + nombre);
  guardarReceta();
  renderIngredientes();
}

function renderIngredientes() {
  const cont = document.getElementById("listaIngredientes");
  if (!cont) return;

  cont.innerHTML = "";

  receta.ingredientes.forEach((ing, i) => {
    const mp = materiasPrimas.find(m => m.id === (ing.mpId || ing.materiaPrima?.id));
    const nombre = (mp && mp.nombre) ? mp.nombre : "Desconocido";
    cont.innerHTML += `
      <div class="flex items-center gap-4 p-3 bg-white border border-emerald-50 rounded-xl mb-2 shadow-sm hover:border-emerald-200 transition-all">
        <div class="flex-grow font-semibold text-slate-700">${nombre}</div>
        <div class="flex items-center gap-2">
          <input id="ing_cant_${i}" type="number" min="0" step="any" value="${ing.cantidad}" 
            class="w-24 px-3 py-1 border border-slate-200 rounded-lg text-right focus:ring-2 focus:ring-organic-green outline-none"
            oninput="actualizarCantidadIngrediente(${i})" />
          <span class="text-xs font-bold text-slate-400 uppercase w-8">${mp?.unidadBase || 'u'}</span>
        </div>
        <button onclick="eliminarIngrediente(${i})" class="p-2 text-rose-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors">
          <i data-lucide="trash-2" class="w-4 h-4"></i>
        </button>
      </div>
    `;
  });
  if (window.lucide) lucide.createIcons();
}

function actualizarCantidadIngrediente(index) {
  const el = document.getElementById(`ing_cant_${index}`);
  if (!el) return;
  const val = parseFloat(el.value);
  if (isNaN(val) || val < 0) return;
  receta.ingredientes[index].cantidad = val;
  // recalcular costos y persistir
  calcularCostoBase();
  guardarReceta();
  renderResultados();
}

function eliminarIngrediente(index) {
  if (!receta.ingredientes || index < 0 || index >= receta.ingredientes.length) return;
  const ing = receta.ingredientes[index];
  const mp = materiasPrimas.find(m => m.id === (ing.mpId || ing.materiaPrima?.id));
  const nombre = mp ? mp.nombre : "Ingrediente";
  
  receta.ingredientes.splice(index, 1);
  registrarHistorial("Se eliminó ingrediente: " + (nombre || ""));
  guardarReceta();
  renderIngredientes();
}

function renderResultados() {
  if (!receta) return;
  calcularCostoBase();
  calcularEscenarios();

  const cont = document.getElementById("resultados");
  if (!cont) return;

  let html = `
    <div class="bg-white p-8 rounded-3xl border border-emerald-100 shadow-xl overflow-hidden relative">
      <div class="absolute top-0 right-0 p-6 opacity-10 text-organic-green">
        <i data-lucide="calculator" class="w-24 h-24"></i>
      </div>
      <h3 class="text-2xl font-bold text-slate-800 mb-6 flex items-center gap-3">
        <i data-lucide="pie-chart" class="text-organic-green"></i> Resumen de Costeo
      </h3>
      
      <div class="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
        <div class="bg-emerald-50 p-6 rounded-2xl border border-emerald-100">
          <div class="text-emerald-700 text-sm font-bold uppercase tracking-wider mb-1">Costo Base Total</div>
          <div class="text-4xl font-black text-organic-green">$${(receta.costoBase || 0).toFixed(2)}</div>
        </div>
        <div class="bg-amber-50 p-6 rounded-2xl border border-amber-100">
          <div class="text-amber-700 text-sm font-bold uppercase tracking-wider mb-1">Costo por Unidad</div>
          <div class="text-4xl font-black text-amber-600">$${costoPorUnidad().toFixed(2)}</div>
        </div>
      </div>

      <div class="space-y-4">
        <h4 class="font-bold text-slate-700 uppercase text-xs tracking-widest border-b border-slate-100 pb-2">Escenarios de Venta</h4>
        ${receta.escenarios.map(e => {
          const r = calcularEscenario(e);
          return `
            <div class="flex items-center justify-between p-4 bg-slate-50 rounded-xl hover:bg-slate-100 transition-colors">
              <div>
                <div class="font-bold text-slate-800">${e.nombre}</div>
                <div class="text-xs text-slate-500 font-medium italic">Margen: ${(e.margen * 100).toFixed(0)}% | C.F.: ${(e.cargaFabril * 100).toFixed(0)}%</div>
              </div>
              <div class="text-right">
                <div class="text-xl font-black text-organic-green">$${r.precio.toFixed(2)}</div>
                <div class="text-[10px] text-slate-400 font-bold uppercase">Precio Sugerido</div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;

  cont.innerHTML = html;
  renderEstadoActual();
  if (window.lucide) lucide.createIcons();
}

function renderVistaPDF() {
  const cont = document.getElementById("vistaPDF");
  if (!cont) return;

  // Cabecera de la Ficha Técnica
  let html = `
    <div class="bg-white p-8 max-w-4xl mx-auto border border-slate-200 shadow-sm print:shadow-none print:border-none" id="ficha-imprimible">
      <div class="flex justify-between items-start border-b-4 border-organic-green pb-6 mb-8">
        <div>
          <h1 class="text-3xl font-black text-slate-800 uppercase tracking-tighter">${receta.nombre || "Receta Sin Nombre"}</h1>
          <p class="text-slate-500 mt-1 font-medium italic">${receta.descripcion || "Sin descripción detallada."}</p>
        </div>
        <div class="text-right">
          <div class="bg-organic-bg text-organic-green px-4 py-2 rounded-lg font-bold border border-emerald-100">
            Ficha Técnica de Producción
          </div>
          <p class="text-xs text-slate-400 mt-2 font-bold uppercase tracking-widest">${new Date().toLocaleDateString()}</p>
        </div>
      </div>

      <div class="grid grid-cols-3 gap-6 mb-8 text-center">
        <div class="border border-slate-100 p-4 rounded-xl">
          <span class="block text-[10px] font-bold text-slate-400 uppercase mb-1">Producción Total</span>
          <span class="text-xl font-bold text-slate-700">${receta.produccion} ${receta.unidadProduccion || 'unidades'}</span>
        </div>
        <div class="border border-slate-100 p-4 rounded-xl">
          <span class="block text-[10px] font-bold text-slate-400 uppercase mb-1">Costo Base Unitario</span>
          <span class="text-xl font-bold text-organic-green">$${costoPorUnidad().toFixed(2)}</span>
        </div>
        <div class="border border-slate-100 p-4 rounded-xl bg-slate-50">
          <span class="block text-[10px] font-bold text-slate-400 uppercase mb-1">Estado de Receta</span>
          <span class="text-sm font-black text-emerald-700 uppercase tracking-widest">${receta.estado}</span>
        </div>
      </div>

      <h4 class="text-sm font-black text-slate-800 uppercase tracking-widest mb-4 flex items-center gap-2">
        <i data-lucide="list-checks" class="w-4 h-4"></i> Desglose de Ingredientes
      </h4>
      
      <table class="w-full text-left border-collapse mb-10">
        <thead>
          <tr class="bg-slate-50 text-slate-500 text-[10px] uppercase tracking-widest border-y border-slate-100">
            <th class="py-3 px-4">Ingrediente</th>
            <th class="py-3 px-4 text-center">Cantidad</th>
            <th class="py-3 px-4 text-right">Costo Proporcional</th>
          </tr>
        </thead>
        <tbody class="text-sm text-slate-600">
  `;

  (receta.ingredientes || []).forEach(i => {
    const mp = materiasPrimas.find(m => m.id === (i.mpId || i.materiaPrima?.id));
    const nombre = (mp && mp.nombre) || 'Desconocido';
    const unitario = (mp && mp.precioEmpaque && mp.cantidadEmpaque) ? (mp.precioEmpaque / mp.cantidadEmpaque) : 0;
    const costoProp = unitario * i.cantidad;

    html += `
      <tr class="border-b border-slate-50 hover:bg-emerald-50/30 transition-colors">
        <td class="py-3 px-4 font-semibold text-slate-700">${nombre}</td>
        <td class="py-3 px-4 text-center font-medium">${i.cantidad} <span class="text-[10px] text-slate-400 uppercase">${mp?.unidadBase || 'u'}</span></td>
        <td class="py-3 px-4 text-right font-bold text-slate-700">$${costoProp.toFixed(2)}</td>
      </tr>
    `;
  });

  html += `
        </tbody>
        <tfoot>
          <tr class="bg-organic-bg font-bold">
            <td colspan="2" class="py-4 px-4 text-organic-green uppercase text-xs tracking-widest">Costo Base de Producción</td>
            <td class="py-4 px-4 text-right text-xl text-organic-green">$${(receta.costoBase || 0).toFixed(2)}</td>
          </tr>
        </tfoot>
      </table>

      <div class="grid grid-cols-2 gap-10">
        <div>
          <h4 class="text-sm font-black text-slate-800 uppercase tracking-widest mb-4">Costos Fijos & Carga</h4>
          <ul class="space-y-2 text-xs text-slate-500">
            ${receta.costosFijos.map(cf => `<li class="flex justify-between border-b border-slate-50 pb-1"><span>${cf.nombre}</span> <span class="font-bold">$${cf.valor.toFixed(2)}</span></li>`).join('')}
          </ul>
        </div>
        <div>
          <h4 class="text-sm font-black text-slate-800 uppercase tracking-widest mb-4">Análisis de Escenarios</h4>
          <div class="space-y-2">
            ${receta.escenarios.map(e => {
              const r = calcularEscenario(e);
              return `
                <div class="flex justify-between items-center bg-slate-50 p-3 rounded-lg border border-slate-100">
                  <span class="text-xs font-bold text-slate-600">${e.nombre}</span>
                  <span class="text-sm font-black text-organic-green">$${r.precio.toFixed(2)}</span>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      </div>

      <div class="mt-12 pt-6 border-t border-slate-100 flex justify-between items-center text-[10px] text-slate-400 font-bold uppercase tracking-widest print:hidden">
        <span>Quantum CostControl - Sistema de Gestión Gastronómica</span>
        <button onclick="window.print()" class="bg-organic-green text-white px-6 py-2 rounded-xl hover:bg-emerald-700 transition-all flex items-center gap-2">
          <i data-lucide="printer" class="w-4 h-4"></i> Imprimir Ficha
        </button>
      </div>
    </div>
  `;

  cont.innerHTML = html;
  if (window.lucide) lucide.createIcons();
}