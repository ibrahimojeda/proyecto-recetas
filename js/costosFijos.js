function agregarCostoFijo() {
  const nombre = document.getElementById("nombreCosto").value;
  const valor = parseFloat(document.getElementById("valorCosto").value);

  if (!nombre || isNaN(valor)) return;

  receta.costosFijos.push({ nombre, valor });

  registrarHistorial("Se agregó costo fijo: " + nombre);

  renderCostosFijos();
  guardarReceta();
}

function eliminarCostoFijo(index) {
  const nombre = receta.costosFijos[index].nombre;

  receta.costosFijos.splice(index, 1);

  registrarHistorial("Se eliminó costo fijo: " + nombre);

  renderCostosFijos();
  guardarReceta();
}

function totalCostosFijos() {
  return receta.costosFijos.reduce((acc, c) => acc + c.valor, 0);
}

function renderCostosFijos() {
  const cont = document.getElementById("listaCostosFijos");
  if (!cont) return;

  cont.innerHTML = "";

  receta.costosFijos.forEach((c, i) => {
    cont.innerHTML += `
      <div class="flex items-center justify-between p-3 bg-white border border-emerald-50 rounded-xl mb-2">
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 bg-amber-50 text-amber-600 rounded-lg flex items-center justify-center">
            <i data-lucide="info" class="w-4 h-4"></i>
          </div>
          <span class="font-medium text-slate-700">${c.nombre}</span>
        </div>
        <div class="flex items-center gap-4">
          <span class="font-bold text-organic-green">$${c.valor.toFixed(2)}</span>
          <button onclick="eliminarCostoFijo(${i})" class="text-slate-300 hover:text-rose-500 transition-colors">
            <i data-lucide="x-circle" class="w-5 h-5"></i>
          </button>
        </div>
      </div>
    `;
  });

  document.getElementById("totalCostosFijos").textContent =
    totalCostosFijos().toFixed(2);

  calcularEscenarios();
  if (window.lucide) lucide.createIcons();
}