-- Amigo Oculto de Livros — backend no Supabase.
--
-- Mesmo modelo do Rolê de Slides: o front usa só a chave pública (anon).
-- As tabelas ficam no schema privado "ao" (fora da API REST) com RLS ligado e
-- sem políticas; tudo passa por funções RPC em "public" (security definer).
-- Erros voltam como {"error": "..."} em vez de exceção, para que o contador de
-- limite (ao.hits) não seja desfeito pelo rollback.
--
-- Segredos: o banco só guarda o hash (sha256) da chave do admin de cada grupo
-- e da chave de cada participante. Quem tirou quem nunca sai do banco a não ser
-- para o próprio participante (ao_me com a chave dele). O admin não vê os pares.
--
-- Rode inteiro no SQL Editor do projeto (é idempotente).

create extension if not exists pgcrypto with schema extensions;

create schema if not exists ao;

create table if not exists ao.groups (
  id text primary key,
  name text not null check (char_length(name) between 1 and 80),
  details text not null default '' check (char_length(details) <= 600),
  budget text not null default '' check (char_length(budget) <= 40),
  event_date text not null default '' check (char_length(event_date) <= 40),
  admin_hash text not null,
  status text not null default 'open' check (status in ('open', 'drawn')),
  created_at timestamptz not null default now(),
  drawn_at timestamptz
);

create table if not exists ao.members (
  id text primary key,
  group_id text not null references ao.groups (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  wishes text not null default '' check (char_length(wishes) <= 1000),
  owner_hash text not null,
  target_id text references ao.members (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists members_group on ao.members (group_id, created_at);

create table if not exists ao.hits (
  key text primary key,
  n int not null,
  until timestamptz not null
);

alter table ao.groups enable row level security;
alter table ao.members enable row level security;
alter table ao.hits enable row level security;

revoke all on all tables in schema ao from public, anon, authenticated;
revoke all on schema ao from public, anon, authenticated;

-- ---------------------------------------------------------------- utilitários

create or replace function ao.new_id(len int default 12) returns text
language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := '0123456789abcdefghijkmnopqrstuvwxyz';
  b bytea := extensions.gen_random_bytes(len);
  out text := '';
begin
  for i in 0 .. len - 1 loop
    out := out || substr(alphabet, get_byte(b, i) % 35 + 1, 1);
  end loop;
  return out;
end $$;

create or replace function ao.sha256(v text) returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest(v, 'sha256'), 'hex')
$$;

create or replace function ao.err(code text) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('error', code)
$$;

create or replace function ao.ip() returns text
language sql stable set search_path = '' as $$
  select coalesce(
    nullif(trim(split_part(coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for', ''), ',', 1)), ''),
    '?'
  )
$$;

-- conta uma ação do IP; devolve true se passou do limite na janela
create or replace function ao.over_limit(kind text, max_n int, win interval) returns boolean
language plpgsql volatile set search_path = '' as $$
declare
  k text := ao.ip() || '|' || kind;
  cur int;
begin
  insert into ao.hits (key, n, until) values (k, 1, now() + win)
  on conflict (key) do update set
    n = case when ao.hits.until > now() then ao.hits.n + 1 else 1 end,
    until = case when ao.hits.until > now() then ao.hits.until else excluded.until end
  returning n into cur;
  return cur > max_n;
end $$;

create or replace function ao.valid_key(k text) returns boolean
language sql immutable set search_path = '' as $$
  select k is not null and char_length(k) between 16 and 128
$$;

-- avisa quem está com a página do grupo aberta (Realtime Broadcast, canal "ao-<grupo>")
create or replace function ao.notify(gid text, kind text) returns void
language plpgsql volatile set search_path = '' as $$
begin
  perform realtime.send(jsonb_build_object('kind', kind), 'change', 'ao-' || gid, false);
exception when others then
  null; -- tempo real é bônus: nunca derruba a operação
end $$;

-- dados públicos do grupo: nome, regras e quem está participando (sem pares)
create or replace function ao.group_json(gid text) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', g.id,
    'name', g.name,
    'details', g.details,
    'budget', g.budget,
    'eventDate', g.event_date,
    'status', g.status,
    'drawnAt', g.drawn_at,
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name) order by m.created_at)
      from ao.members m where m.group_id = g.id
    ), '[]'::jsonb)
  )
  from ao.groups g where g.id = gid
$$;

-- ---------------------------------------------------------------- API pública

-- admin cria o grupo; a chave do admin é gerada no navegador (só o hash vem pra cá)
create or replace function public.ao_create_group(
  p_name text, p_details text, p_budget text, p_event_date text, p_admin_key text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  clean_name text := trim(coalesce(p_name, ''));
  new_id text;
begin
  if char_length(clean_name) < 1 or char_length(clean_name) > 80 then return ao.err('bad_name'); end if;
  if char_length(coalesce(p_details, '')) > 600 then return ao.err('bad_details'); end if;
  if char_length(coalesce(p_budget, '')) > 40 or char_length(coalesce(p_event_date, '')) > 40 then return ao.err('bad_details'); end if;
  if not ao.valid_key(p_admin_key) then return ao.err('bad_key'); end if;
  if ao.over_limit('create', 10, interval '1 hour') then return ao.err('throttled'); end if;

  new_id := ao.new_id(10);
  insert into ao.groups (id, name, details, budget, event_date, admin_hash)
  values (new_id, clean_name, trim(coalesce(p_details, '')), trim(coalesce(p_budget, '')),
          trim(coalesce(p_event_date, '')), ao.sha256(p_admin_key));
  return jsonb_build_object('id', new_id);
end $$;

create or replace function public.ao_group(p_group text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  j jsonb := ao.group_json(p_group);
begin
  if j is null then return ao.err('not_found'); end if;
  return j;
end $$;

-- confere a chave do admin: devolve o grupo (mesmos dados públicos) ou erro
create or replace function public.ao_admin(p_group text, p_admin_key text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  if ao.over_limit('admin', 120, interval '10 minutes') then return ao.err('throttled'); end if;
  if not exists (select 1 from ao.groups where id = p_group and admin_hash = ao.sha256(coalesce(p_admin_key, ''))) then
    return ao.err('forbidden');
  end if;
  return ao.group_json(p_group);
end $$;

create or replace function public.ao_update_group(
  p_group text, p_admin_key text, p_name text, p_details text, p_budget text, p_event_date text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  clean_name text := trim(coalesce(p_name, ''));
begin
  if char_length(clean_name) < 1 or char_length(clean_name) > 80 then return ao.err('bad_name'); end if;
  if char_length(coalesce(p_details, '')) > 600 then return ao.err('bad_details'); end if;
  if char_length(coalesce(p_budget, '')) > 40 or char_length(coalesce(p_event_date, '')) > 40 then return ao.err('bad_details'); end if;
  update ao.groups set name = clean_name, details = trim(coalesce(p_details, '')),
    budget = trim(coalesce(p_budget, '')), event_date = trim(coalesce(p_event_date, ''))
  where id = p_group and admin_hash = ao.sha256(coalesce(p_admin_key, ''));
  if not found then return ao.err('forbidden'); end if;
  perform ao.notify(p_group, 'group');
  return jsonb_build_object('ok', true);
end $$;

-- participante entra pelo link do convite; a chave dele é gerada no navegador
create or replace function public.ao_join(p_group text, p_name text, p_wishes text, p_key text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  st text;
  clean_name text := trim(coalesce(p_name, ''));
  clean_wishes text := trim(coalesce(p_wishes, ''));
  new_id text;
begin
  if char_length(clean_name) < 1 or char_length(clean_name) > 40 then return ao.err('bad_name'); end if;
  if char_length(clean_wishes) > 1000 then return ao.err('bad_wishes'); end if;
  if not ao.valid_key(p_key) then return ao.err('bad_key'); end if;

  -- trava o grupo: ninguém entra enquanto o sorteio acontece
  select status into st from ao.groups where id = p_group for update;
  if st is null then return ao.err('not_found'); end if;
  if st <> 'open' then return ao.err('already_drawn'); end if;
  if (select count(*) from ao.members where group_id = p_group) >= 100 then return ao.err('full'); end if;
  if exists (select 1 from ao.members where group_id = p_group and lower(name) = lower(clean_name)) then
    return ao.err('name_taken');
  end if;
  if ao.over_limit('join', 30, interval '1 hour') then return ao.err('throttled'); end if;

  new_id := ao.new_id(12);
  insert into ao.members (id, group_id, name, wishes, owner_hash)
  values (new_id, p_group, clean_name, clean_wishes, ao.sha256(p_key));
  perform ao.notify(p_group, 'join');
  return jsonb_build_object('id', new_id);
end $$;

-- visão do participante: grupo + os próprios dados + quem ele tirou (se já sorteou)
create or replace function public.ao_me(p_member text, p_key text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  m ao.members;
  t ao.members;
begin
  if ao.over_limit('me', 300, interval '10 minutes') then return ao.err('throttled'); end if;
  select * into m from ao.members where id = p_member and owner_hash = ao.sha256(coalesce(p_key, ''));
  if m.id is null then return ao.err('forbidden'); end if;
  if m.target_id is not null then
    select * into t from ao.members where id = m.target_id;
  end if;
  return jsonb_build_object(
    'group', ao.group_json(m.group_id),
    'me', jsonb_build_object('id', m.id, 'name', m.name, 'wishes', m.wishes),
    'target', case when t.id is null then null
      else jsonb_build_object('name', t.name, 'wishes', t.wishes) end
  );
end $$;

-- participante edita o próprio nome (antes do sorteio) e a lista de desejos (sempre)
create or replace function public.ao_update_me(p_member text, p_key text, p_name text, p_wishes text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  m ao.members;
  st text;
  clean_name text := trim(coalesce(p_name, ''));
  clean_wishes text := trim(coalesce(p_wishes, ''));
begin
  if char_length(clean_name) < 1 or char_length(clean_name) > 40 then return ao.err('bad_name'); end if;
  if char_length(clean_wishes) > 1000 then return ao.err('bad_wishes'); end if;
  select * into m from ao.members where id = p_member and owner_hash = ao.sha256(coalesce(p_key, ''));
  if m.id is null then return ao.err('forbidden'); end if;
  select status into st from ao.groups where id = m.group_id for update;
  if clean_name <> m.name then
    if st <> 'open' then return ao.err('already_drawn'); end if;
    if exists (select 1 from ao.members where group_id = m.group_id and id <> m.id and lower(name) = lower(clean_name)) then
      return ao.err('name_taken');
    end if;
  end if;
  update ao.members set name = clean_name, wishes = clean_wishes where id = m.id;
  perform ao.notify(m.group_id, 'update');
  return jsonb_build_object('ok', true);
end $$;

-- participante sai do grupo (só antes do sorteio)
create or replace function public.ao_leave(p_member text, p_key text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  m ao.members;
  st text;
begin
  select * into m from ao.members where id = p_member and owner_hash = ao.sha256(coalesce(p_key, ''));
  if m.id is null then return ao.err('forbidden'); end if;
  select status into st from ao.groups where id = m.group_id for update;
  if st <> 'open' then return ao.err('already_drawn'); end if;
  delete from ao.members where id = m.id;
  perform ao.notify(m.group_id, 'leave');
  return jsonb_build_object('ok', true);
end $$;

-- admin remove alguém (só antes do sorteio)
create or replace function public.ao_remove(p_group text, p_admin_key text, p_member text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  st text;
begin
  select status into st from ao.groups
  where id = p_group and admin_hash = ao.sha256(coalesce(p_admin_key, '')) for update;
  if st is null then return ao.err('forbidden'); end if;
  if st <> 'open' then return ao.err('already_drawn'); end if;
  delete from ao.members where id = p_member and group_id = p_group;
  if not found then return ao.err('not_found'); end if;
  perform ao.notify(p_group, 'remove');
  return jsonb_build_object('ok', true);
end $$;

-- o sorteio: embaralha e forma um único ciclo (cada um tira o próximo),
-- então ninguém tira a si mesmo e não há pares fechados de 2.
create or replace function public.ao_draw(p_group text, p_admin_key text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  st text;
  ids text[];
  n int;
begin
  select status into st from ao.groups
  where id = p_group and admin_hash = ao.sha256(coalesce(p_admin_key, '')) for update;
  if st is null then return ao.err('forbidden'); end if;
  if st <> 'open' then return ao.err('already_drawn'); end if;

  select array_agg(id order by extensions.gen_random_bytes(16)) into ids
  from ao.members where group_id = p_group;
  n := coalesce(array_length(ids, 1), 0);
  if n < 3 then return ao.err('too_few'); end if;

  for i in 1 .. n loop
    update ao.members set target_id = ids[(i % n) + 1] where id = ids[i];
  end loop;
  update ao.groups set status = 'drawn', drawn_at = now() where id = p_group;
  perform ao.notify(p_group, 'draw');
  return jsonb_build_object('ok', true, 'count', n);
end $$;

-- admin desfaz o sorteio (para incluir alguém que chegou atrasado e sortear de novo)
create or replace function public.ao_undraw(p_group text, p_admin_key text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform 1 from ao.groups
  where id = p_group and admin_hash = ao.sha256(coalesce(p_admin_key, '')) for update;
  if not found then return ao.err('forbidden'); end if;
  update ao.members set target_id = null where group_id = p_group;
  update ao.groups set status = 'open', drawn_at = null where id = p_group;
  perform ao.notify(p_group, 'undraw');
  return jsonb_build_object('ok', true);
end $$;

revoke all on function
  public.ao_create_group(text, text, text, text, text),
  public.ao_group(text),
  public.ao_admin(text, text),
  public.ao_update_group(text, text, text, text, text, text),
  public.ao_join(text, text, text, text),
  public.ao_me(text, text),
  public.ao_update_me(text, text, text, text),
  public.ao_leave(text, text),
  public.ao_remove(text, text, text),
  public.ao_draw(text, text),
  public.ao_undraw(text, text)
from public;

grant execute on function
  public.ao_create_group(text, text, text, text, text),
  public.ao_group(text),
  public.ao_admin(text, text),
  public.ao_update_group(text, text, text, text, text, text),
  public.ao_join(text, text, text, text),
  public.ao_me(text, text),
  public.ao_update_me(text, text, text, text),
  public.ao_leave(text, text),
  public.ao_remove(text, text, text),
  public.ao_draw(text, text),
  public.ao_undraw(text, text)
to anon, authenticated;
