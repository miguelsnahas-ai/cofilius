-- Cofilius · criativos (carrossel, stories e reels) de uma oferta
--
-- roteiro: o que o agente Criativo escreveu, com marcadores ({{preco}}, {{desconto}}); nunca valores.
-- Preço, desconto e link são preenchidos na hora de mostrar, sempre com o valor atual do banco.

begin;

create table public.criativos (
  id            uuid primary key default gen_random_uuid(),
  cliente_id    uuid not null references public.clientes (cliente_id) on delete cascade,
  oferta_id     uuid not null,
  link_id       uuid,
  formato       text not null check (formato in ('carrossel', 'stories', 'reels')),
  roteiro       jsonb not null,
  estado        text not null default 'rascunho' check (estado in ('rascunho', 'aprovado', 'publicado', 'descartado')),
  data_lista    date not null,
  publicado_em  timestamptz,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (cliente_id, id),
  foreign key (cliente_id, oferta_id) references public.ofertas (cliente_id, id) on delete cascade,
  foreign key (cliente_id, link_id) references public.links (cliente_id, id) on delete set null (link_id)
);
create index criativos_cliente_dia on public.criativos (cliente_id, data_lista desc);
create trigger criativos_atualizado before update on public.criativos
  for each row execute function public.tocar_atualizado_em();
alter table public.criativos enable row level security;

-- O agente novo também registra as chamadas.
alter table public.execucoes_agente drop constraint execucoes_agente_agente_check;
alter table public.execucoes_agente add constraint execucoes_agente_agente_check
  check (agente in ('curador', 'redator', 'analista', 'atendente', 'criativo'));

commit;
