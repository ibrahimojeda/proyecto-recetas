function descargarArchivo(contenido, nombre) {
  const blob = new Blob([contenido], { type: "text/plain" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  a.click();
}

function exportarJSON() {
  descargarArchivo(JSON.stringify(receta, null, 2), "receta.json");
}

function exportarCSV() {
  let csv = "Escenario,Precio\n";

  receta.escenarios.forEach(e => {
    const r = calcularEscenario(e);
    csv += `${e.nombre},${r.precio}\n`;
  });

  descargarArchivo(csv, "analisis.csv");
}