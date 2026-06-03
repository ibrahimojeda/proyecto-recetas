const API_URL = 'http://localhost:8001/api';
let receta = crearRecetaBase();

async function guardarReceta() {
  if (!receta.id) return;
  try {
    await fetch(`${API_URL}/recetas/${receta.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(receta)
    });
    // Actualizar también la lista global en memoria
    const idx = recetas.findIndex(r => r.id === receta.id);
    if (idx !== -1) recetas[idx] = { ...receta };
  } catch (e) {
    console.error("Error al persistir en servidor:", e);
  }
}