let recetas = JSON.parse(localStorage.getItem("recetas")) || [];

function renderListadoRecetas() {

  const cont = document.getElementById("listaRecetas");

  cont.innerHTML = "";

  recetas.forEach((r, i) => {

    cont.innerHTML += `
      <div>
        <b>${r.nombre || "Sin nombre"}</b>
        <span>(${nombreEstado(r.estado)})</span>

        <button onclick="abrirReceta(${i})">Abrir</button>
        <button onclick="eliminarReceta(${i})">Eliminar</button>
      </div>
    `;

  });
}
function crearNuevaReceta() {

  receta = crearRecetaBase();

  recetas.push(receta);
  guardarRecetas();

  irReceta();
}
function guardarRecetas() {
  localStorage.setItem("recetas", JSON.stringify(recetas));
}
function abrirReceta(index) {

  receta = recetas[index];
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

  guardarRecetas();

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

function eliminarReceta(index) {
  if (index < 0 || index >= recetas.length) return;
  recetas.splice(index, 1);
  guardarRecetas();
  renderListadoRecetas();
}

function agregarIngrediente() {
  const select = document.getElementById("ingredienteMP");
  const cantidadEl = document.getElementById("ingredienteCantidad");
  if (!select || !cantidadEl) return;

  const index = parseInt(select.value, 10);
  const cantidad = parseFloat(cantidadEl.value);

  if (isNaN(index) || isNaN(cantidad) || cantidad <= 0) {
    alert("Seleccioná materia prima y una cantidad válida.");
    return;
  }

  const mp = (materiasPrimas && materiasPrimas[index]) ? materiasPrimas[index] : { nombre: "Desconocido", precioEmpaque: 0, cantidadEmpaque: 1 };

  receta.ingredientes.push({ materiaPrima: mp, cantidad });

  registrarHistorial("Se agregó ingrediente: " + mp.nombre);
  guardarReceta();
  renderIngredientes();
}

function renderIngredientes() {
  const cont = document.getElementById("listaIngredientes");
  if (!cont) return;

  cont.innerHTML = "";

  receta.ingredientes.forEach((ing, i) => {
    const nombre = (ing.materiaPrima && ing.materiaPrima.nombre) || "Desconocido";
    cont.innerHTML += `
      <div>
        ${nombre} - ${ing.cantidad}
        <button onclick="eliminarIngrediente(${i})">X</button>
      </div>
    `;
  });
}

function eliminarIngrediente(index) {
  if (!receta.ingredientes || index < 0 || index >= receta.ingredientes.length) return;
  const nombre = receta.ingredientes[index].materiaPrima && receta.ingredientes[index].materiaPrima.nombre;
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

  let html = `<h3>${receta.nombre || "Sin nombre"}</h3>`;
  html += `<div>Costo base total: $${(receta.costoBase || 0).toFixed(2)}</div>`;

  receta.escenarios.forEach(e => {
    const r = calcularEscenario(e);
    html += `<div><b>${e.nombre}</b> - Precio: $${r.precio.toFixed(2)} - Costo real: $${r.costoReal.toFixed(2)}</div>`;
  });

  cont.innerHTML = html;
  renderEstadoActual();
}

function renderVistaPDF() {
  const cont = document.getElementById("vistaPDF");
  if (!cont) return;

  let html = `<h3>${receta.nombre || "Sin nombre"}</h3><div>${receta.descripcion || ""}</div><ul>`;
  (receta.ingredientes || []).forEach(i => {
    html += `<li>${(i.materiaPrima && i.materiaPrima.nombre) || 'Desconocido'} - ${i.cantidad}</li>`;
  });
  html += `</ul>`;

  cont.innerHTML = html;
}