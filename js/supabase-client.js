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

  async function loadStateFromSupabase() {
    const client = ensureClient();
    if (!client) return null;
    try {
      const { data, error } = await client.from('app_state').select('state').eq('id', 'default').single();
      if (error) {
        console.debug('Supabase load error', error);
        return null;
      }
      return data?.state || null;
    } catch (err) {
      console.debug('Supabase load threw', err);
      return null;
    }
  }

  async function saveStateToSupabase(state) {
    const client = ensureClient();
    if (!client) return { error: 'no-client' };
    try {
      const payload = { id: 'default', state };
      const { data, error } = await client.from('app_state').upsert(payload).select();
      if (error) {
        console.debug('Supabase save error', error);
        return { error };
      }
      return { data };
    } catch (err) {
      console.debug('Supabase save threw', err);
      return { error: err };
    }
  }

  // expose helpers
  window.supabaseBridge = {
    loadStateFromSupabase,
    saveStateToSupabase
  };
})();
