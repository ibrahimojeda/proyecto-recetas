(function(){
  // Simple Supabase bridge for storing the whole app state in a single row.
  // Configure via window.SUPABASE_URL and window.SUPABASE_ANON_KEY

  const ensureClient = () => {
    const url = window.SUPABASE_URL || '';
    const key = window.SUPABASE_ANON_KEY || '';
    if (!url || !key) return null;
    if (!window.supabase) return null;
    try {
      const { createClient } = window.supabase;
      if (!createClient) return null;
      if (!window.__SupaClient) window.__SupaClient = createClient(url, key);
      return window.__SupaClient;
    } catch (e) {
      console.warn('Supabase client init failed', e);
      return null;
    }
  };

  // Load normalized entities: recetas and materias_primas, and fallback to app_state
  async function fetchAllNormalizedState() {
    const client = ensureClient();
    if (!client) return null;
    try {
      const res = { recetas: [], materiasPrimas: [], appState: null };
      // Fetch recetas
      const { data: recs, error: errR } = await client.from('recetas').select('*');
      if (!errR && Array.isArray(recs)) {
        // Map receta rows into the internal shape: prefer receta_json if present
        res.recetas = recs.map(r => r.receta_json || ({ id: r.id, nombre: r.nombre, descripcion: r.descripcion, produccion: r.produccion, fichaTecnica: r.ficha_tecnica }));
      }
      // Fetch materias_primas
      const { data: mps, error: errM } = await client.from('materias_primas').select('*');
      if (!errM && Array.isArray(mps)) {
        res.materiasPrimas = mps.map(m => ({ id: m.id, nombre: m.nombre, proveedor: m.proveedor, unidadBase: m.unidad_base, cantidadEmpaque: m.cantidad_empaque, precioEmpaque: m.precio_empaque, meta: m.meta }));
      }
      // Also try app_state backup
      const { data: appRows } = await client.from('app_state').select('state').eq('id', 'default').single();
      if (appRows && appRows.state) res.appState = appRows.state;
      return res;
    } catch (err) {
      console.debug('Supabase normalized fetch failed', err);
      return null;
    }
  }

  // Sync normalized entities: upsert recetas and materias_primas, and update app_state backup
  async function syncNormalizedState(state) {
    const client = ensureClient();
    if (!client) return { error: 'no-client' };
    try {
      // Upsert materias_primas
      const mps = Array.isArray(state.materiasPrimas) ? state.materiasPrimas.map(mp => ({
        id: mp.id || undefined,
        nombre: mp.nombre || null,
        proveedor: mp.proveedor || null,
        unidad_base: mp.unidadBase || null,
        cantidad_empaque: mp.cantidadEmpaque || null,
        precio_empaque: mp.precioEmpaque || null,
        meta: mp.meta || null
      })) : [];
      if (mps.length) {
        await client.from('materias_primas').upsert(mps, { onConflict: 'id' });
      }

      // Upsert recetas
      const recs = Array.isArray(state.recetas) ? state.recetas.map(r => ({
        id: r.id || undefined,
        nombre: r.nombre || null,
        descripcion: r.descripcion || null,
        tipo: r.tipo || null,
        produccion: r.produccion || null,
        receta_json: r,
        ficha_tecnica: r.fichaTecnica || null
      })) : [];
      if (recs.length) {
        await client.from('recetas').upsert(recs, { onConflict: 'id' });
      }

      // Update app_state backup row (store minimal state)
      const backup = { id: 'default', state: { recetas: state.recetas || [], materiasPrimas: state.materiasPrimas || [] } };
      await client.from('app_state').upsert(backup).select();

      return { success: true };
    } catch (err) {
      console.debug('Supabase sync failed', err);
      return { error: err };
    }
  }

  // CRUD helpers for entidades individuales
  async function fetchRecetas() {
    const client = ensureClient(); if (!client) return [];
    try { const { data } = await client.from('recetas').select('*'); return data || []; } catch (e) { console.debug('fetchRecetas failed', e); return []; }
  }

  async function createReceta(receta) {
    const client = ensureClient(); if (!client) return { error: 'no-client' };
    try {
      const payload = [{ id: receta.id || undefined, nombre: receta.nombre || null, descripcion: receta.descripcion || null, tipo: receta.tipo || null, produccion: receta.produccion || null, receta_json: receta, ficha_tecnica: receta.fichaTecnica || null }];
      const { data, error } = await client.from('recetas').insert(payload).select();
      return error ? { error } : { data };
    } catch (err) { console.debug('createReceta failed', err); return { error: err }; }
  }

  async function updateReceta(receta) {
    const client = ensureClient(); if (!client) return { error: 'no-client' };
    try {
      const payload = { nombre: receta.nombre || null, descripcion: receta.descripcion || null, tipo: receta.tipo || null, produccion: receta.produccion || null, receta_json: receta, ficha_tecnica: receta.fichaTecnica || null, updated_at: new Date().toISOString() };
      const { data, error } = await client.from('recetas').update(payload).eq('id', receta.id).select();
      return error ? { error } : { data };
    } catch (err) { console.debug('updateReceta failed', err); return { error: err }; }
  }

  async function deleteReceta(id) {
    const client = ensureClient(); if (!client) return { error: 'no-client' };
    try { const { data, error } = await client.from('recetas').delete().eq('id', id).select(); return error ? { error } : { data }; } catch (err) { console.debug('deleteReceta failed', err); return { error: err }; }
  }

  async function fetchMps() {
    const client = ensureClient(); if (!client) return [];
    try { const { data } = await client.from('materias_primas').select('*'); return data || []; } catch (e) { console.debug('fetchMps failed', e); return []; }
  }

  async function createMp(mp) {
    const client = ensureClient(); if (!client) return { error: 'no-client' };
    try {
      const payload = [{ id: mp.id || undefined, nombre: mp.nombre || null, proveedor: mp.proveedor || null, unidad_base: mp.unidadBase || null, cantidad_empaque: mp.cantidadEmpaque || null, precio_empaque: mp.precioEmpaque || null, meta: mp.meta || null }];
      const { data, error } = await client.from('materias_primas').insert(payload).select();
      return error ? { error } : { data };
    } catch (err) { console.debug('createMp failed', err); return { error: err }; }
  }

  async function updateMp(mp) {
    const client = ensureClient(); if (!client) return { error: 'no-client' };
    try {
      const payload = { nombre: mp.nombre || null, proveedor: mp.proveedor || null, unidad_base: mp.unidadBase || null, cantidad_empaque: mp.cantidadEmpaque || null, precio_empaque: mp.precioEmpaque || null, meta: mp.meta || null, updated_at: new Date().toISOString() };
      const { data, error } = await client.from('materias_primas').update(payload).eq('id', mp.id).select();
      return error ? { error } : { data };
    } catch (err) { console.debug('updateMp failed', err); return { error: err }; }
  }

  async function deleteMp(id) {
    const client = ensureClient(); if (!client) return { error: 'no-client' };
    try { const { data, error } = await client.from('materias_primas').delete().eq('id', id).select(); return error ? { error } : { data }; } catch (err) { console.debug('deleteMp failed', err); return { error: err }; }
  }

  window.supabaseBridge = {
    fetchAllNormalizedState,
    syncNormalizedState,
    // entity CRUD
    fetchRecetas,
    createReceta,
    updateReceta,
    deleteReceta,
    fetchMps,
    createMp,
    updateMp,
    deleteMp
  };
})();
