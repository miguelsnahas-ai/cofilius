-- Cofilius · extensão do Chrome ligada ao painel
--
-- A extensão (no Chrome de quem acessa os painéis de afiliado) manda ao painel local os relatórios que
-- as páginas da Shopee e da Amazon carregam. Nenhum arquivo para subir.
--
-- pareamentos_extensao: um código por cliente; só o hash fica no banco.
-- recebimentos_extensao: o que chegou e o que virou (sem o conteúdo bruto do relatório).
-- cliques_shopee: cada clique do relatório de cliques, sem repetição (click_id), para recontar por dia.

begin;

create table public.pareamentos_extensao (
  cliente_id   uuid primary key references public.clientes (cliente_id) on delete cascade,
  codigo_hash  text not null unique,
  criado_em    timestamptz not null default now(),
  usado_em     timestamptz
);
alter table public.pareamentos_extensao enable row level security;

create table public.recebimentos_extensao (
  id          uuid primary key default gen_random_uuid(),
  cliente_id  uuid not null references public.clientes (cliente_id) on delete cascade,
  tipo        text not null,
  url         text not null,
  resultado   jsonb not null default '{}'::jsonb,
  erro        text,
  criado_em   timestamptz not null default now()
);
create index recebimentos_extensao_cliente on public.recebimentos_extensao (cliente_id, criado_em desc);
alter table public.recebimentos_extensao enable row level security;

create table public.cliques_shopee (
  cliente_id      uuid not null references public.clientes (cliente_id) on delete cascade,
  click_id        text not null,
  chave_rastreio  text not null,
  clicado_em      timestamptz not null,
  primary key (cliente_id, click_id)
);
alter table public.cliques_shopee enable row level security;

commit;
