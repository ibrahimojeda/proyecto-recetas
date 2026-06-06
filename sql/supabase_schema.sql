-- Supabase schema for proyecto-recetas (updated)
-- This schema creates normalized tables and RLS policies enforcing ownership.

-- Enable pgcrypto for gen_random_uuid
create extension if not exists pgcrypto;

-- Backup table to store full app state (optional)
create table if not exists app_state (
	id text primary key,
	state jsonb not null,
	updated_at timestamptz default now()
);
insert into app_state (id, state) values ('default', '{}') on conflict (id) do nothing;
alter table app_state enable row level security;
create policy "appstate_public_select" on app_state for select using (true);
create policy "appstate_authenticated_write" on app_state for insert with check (auth.role() = 'authenticated');
create policy "appstate_authenticated_update" on app_state for update using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Materias primas (inventory items)
create table if not exists materias_primas (
	id uuid primary key default gen_random_uuid(),
	owner uuid,
	nombre text,
	proveedor text,
	unidad_base text,
	cantidad_empaque numeric,
	precio_empaque numeric,
	meta jsonb,
	created_at timestamptz default now(),
	updated_at timestamptz default now()
);

alter table materias_primas enable row level security;
-- allow anyone to read
create policy "mps_public_select" on materias_primas for select using (true);
-- allow authenticated users to insert only if they set owner = auth.uid()
create policy "mps_insert_owner" on materias_primas for insert with check (auth.role() = 'authenticated' AND new.owner = auth.uid());
-- allow updates only by owner
create policy "mps_update_owner" on materias_primas for update using (auth.role() = 'authenticated' AND owner = auth.uid()) with check (auth.role() = 'authenticated' AND new.owner = owner);
-- allow deletes only by owner
create policy "mps_delete_owner" on materias_primas for delete using (auth.role() = 'authenticated' AND owner = auth.uid());

-- Recetas (recipes)
create table if not exists recetas (
	id uuid primary key default gen_random_uuid(),
	owner uuid,
	nombre text,
	descripcion text,
	tipo text,
	produccion numeric,
	receta_json jsonb,
	ficha_tecnica jsonb,
	created_at timestamptz default now(),
	updated_at timestamptz default now()
);

alter table recetas enable row level security;
create policy "recetas_public_select" on recetas for select using (true);
create policy "recetas_insert_owner" on recetas for insert with check (auth.role() = 'authenticated' AND new.owner = auth.uid());
create policy "recetas_update_owner" on recetas for update using (auth.role() = 'authenticated' AND owner = auth.uid()) with check (auth.role() = 'authenticated' AND new.owner = owner);
create policy "recetas_delete_owner" on recetas for delete using (auth.role() = 'authenticated' AND owner = auth.uid());

-- Indexes
create index if not exists idx_recetas_nombre on recetas (lower(nombre));

-- End of schema
