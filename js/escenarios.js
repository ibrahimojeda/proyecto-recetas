function calcularEscenario(escenario) {
  const costoBaseUnidad = receta.costoBase / receta.produccion;

  const costoReal =
    costoBaseUnidad * (1 + escenario.cargaFabril) +
    totalCostosFijos();

  const precio = costoReal / (1 - escenario.margen);

  return { costoReal, precio };
}

function agregarEscenario() {
  const nombre = document.getElementById("nombreEscenario").value;
  const margen = parseFloat(document.getElementById("margenEscenario").value);
  const cargaFabril = parseFloat(document.getElementById("cargaEscenario").value);

  if (!nombre || isNaN(margen) || isNaN(cargaFabril)) return;

  receta.escenarios.push({ nombre, margen, cargaFabril });

  registrarHistorial("Se agregó escenario: " + nombre);

  renderEscenarios();
  guardarReceta();
}

function renderEscenarios() {
  const cont = document.getElementById("listaEscenarios");
  if (!cont) return;

  cont.innerHTML = "";

  receta.escenarios.forEach(e => {
    const r = calcularEscenario(e);

    cont.innerHTML += `
      <div>
        <b>${e.nombre}</b> -
        Precio: $${r.precio.toFixed(2)}
      </div>
    `;
  });
}

function calcularEscenarios() {
  renderEscenarios();
  renderHistorial();
}

function simularMargen() {
  const margen = parseFloat(document.getElementById("sliderMargen").value);

  const valorMargenEl = document.getElementById("valorMargen");
  if (valorMargenEl) {
    valorMargenEl.textContent = (margen * 100).toFixed(0);
  }

  const temp = {
    margen,
    cargaFabril: receta.escenarios[0] ? receta.escenarios[0].cargaFabril : 0
  };

  const r = calcularEscenario(temp);

  const precioEl = document.getElementById("precioSimulado");
  if (precioEl) {
    precioEl.textContent = r.precio.toFixed(2);
  }
}