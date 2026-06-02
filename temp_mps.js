// Lista de materias primas (fallback si no existe en localStorage)
let materiasPrimas = JSON.parse(localStorage.getItem("materiasPrimas")) || [];

function cargarSelectMaterias() {

  const select = document.getElementById("ingredienteMP");

  if (!select) return;

  select.innerHTML = "";

  materiasPrimas.forEach((mp, i) => {

    select.innerHTML += `<option value="${i}">
      ${mp.nombre}
    </option>`;

  });
}