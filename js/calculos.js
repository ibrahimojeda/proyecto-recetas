function calcularCostoBase() {

  let total = 0;

  receta.ingredientes.forEach(i => {
    // Buscar materia prima por ID en lugar de índice
    const mp = materiasPrimas.find(m => m.id === i.mpId);
    const unitario = (mp && mp.precioEmpaque && mp.cantidadEmpaque) ? (mp.precioEmpaque / mp.cantidadEmpaque) : 0;
    total += unitario * i.cantidad;
  });

  receta.costoBase = total;
}
function costoPorUnidad() {
  return receta.costoBase / receta.produccion;
}