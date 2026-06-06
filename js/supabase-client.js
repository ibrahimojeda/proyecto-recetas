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

  // expose helpers
  window.supabaseBridge = {
    fetchAllNormalizedState,
    syncNormalizedState
  };
})();
