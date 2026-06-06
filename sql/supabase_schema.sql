-- Supabase schema for proyecto-recetas
-- WARNING: This SQL enables permissive RLS policies for the 'anon' role to allow client-side access.
-- For production, tighten policies to require authentication and proper checks.

-- Enable pgcrypto for gen_random_uuid
create extension if not exists pgcrypto;

-- Table to store the full application state as JSON (simple approach)
create table if not exists app_state (
  id text primary key,
  state jsonb not null,
  updated_at timestamptz default now()
);

-- Insert default row if not exists
insert into app_state (id, state) values ('default', '{}') on conflict (id) do nothing;

-- Enable row level security and create permissive policies for development
alter table app_state enable row level security;

-- Allow anon select
create policy "allow anon select" on app_state for select using (true);
-- Allow anon insert
create policy "allow anon insert" on app_state for insert with check (true);
-- Allow anon update
create policy "allow anon update" on app_state for update using (true) with check (true);
-- Allow anon delete (optional - disabled)
-- create policy "allow anon delete" on app_state for delete using (true);

-- Example normalized tables if you prefer separate entities
create table if not exists materias_primas (
  id uuid primary key default gen_random_uuid(),
  nombre text,
  proveedor text,
  unidad_base text,
  cantidad_empaque numeric,
  precio_empaque numeric,
  meta jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists recetas (
  id uuid primary key default gen_random_uuid(),
  nombre text,
  descripcion text,
  tipo text,
  produccion numeric,
  receta_json jsonb,
  ficha_tecnica jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Enable RLS for these tables as well and create permissive policies
alter table materias_primas enable row level security;
create policy "allow anon select" on materias_primas for select using (true);
create policy "allow anon insert" on materias_primas for insert with check (true);
create policy "allow anon update" on materias_primas for update using (true) with check (true);

alter table recetas enable row level security;
create policy "allow anon select" on recetas for select using (true);
create policy "allow anon insert" on recetas for insert with check (true);
create policy "allow anon update" on recetas for update using (true) with check (true);

-- Indexes to help queries
create index if not exists idx_recetas_nombre on recetas (lower(nombre));

-- End of schema
