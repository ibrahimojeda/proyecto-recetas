const vistaCache = {};

async function cargarVista(nombreVista) {
  const app = document.getElementById("app");

  if (!vistaCache[nombreVista]) {
    try {
      const res = await fetch(`views/${nombreVista}.html`);
      if (!res.ok) throw new Error(`No se encontró la vista: ${nombreVista}`);
      vistaCache[nombreVista] = await res.text();
    } catch (error) {
      app.innerHTML = `<div class="p-10 text-center"><p class="text-rose-500 font-bold">Error de conexión con el servidor.</p><button onclick="location.reload()" class="mt-4 bg-organic-green text-white px-4 py-2 rounded-lg">Reintentar</button></div>`;
      return;
    }
  }
  
  const html = vistaCache[nombreVista];

  app.innerHTML = html;

  ejecutarPostCarga(nombreVista);
}

function ejecutarPostCarga(vista) {
  const controladores = {
    inicio: () => {
      renderListadoRecetas();
      if (typeof renderMateriasPrimas === 'function') renderMateriasPrimas();
    },
    receta: cargarDatosReceta,
    ingredientes: () => {
      cargarSelectMaterias();
      renderIngredientes();
    },
    materiasPrimas: () => {
      renderMateriasPrimas();
    },
    resumen: () => {
      receta.vioResumen = true;
      actualizarEstadoReceta();
      guardarRecetas();
      renderResultados();
    }
  };

  if (controladores[vista]) {
    controladores[vista]();
  }

  if (vista === "pdf") {
    renderVistaPDF();
  }

  if (window.lucide) lucide.createIcons();
}

function irMateriasPrimas() {
  cargarVista("materiasPrimas");
}

function irInicio() {
  cargarVista("inicio");
}

function irReceta() {
  cargarVista("receta");
}

function irIngredientes() {

  if (receta.ingredientes.length === 0) {
    alert("La receta no tiene ingredientes.");
    return;
  }

  cargarVista("ingredientes");
}

function irResumen() {
  cargarVista("resumen");
}

function irGenerarPDF() {
  if (!receta.ingredientes || receta.ingredientes.length === 0) {
    alert("No se puede generar el PDF porque la receta no tiene ingredientes.");
    return;
  }
  cargarVista("pdf");
}