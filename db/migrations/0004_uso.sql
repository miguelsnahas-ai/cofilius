-- Cofilius · registro de uso do operador
--
-- Cada ação do operador (painel ou terminal) vira uma linha. Serve para responder, por cliente,
-- quantos minutos do operador ele consome (sessões de ações próximas) e quanto custa atendê-lo.

begin;

create table public.acoes_operador (
  id          uuid primary key default gen_random_uuid(),
  cliente_id  uuid not null references public.clientes (cliente_id) on delete cascade,
  acao        text not null,
  origem      text not null check (origem in ('painel', 'cli')),
  operador    text,
  em          timestamptz not null default now()
);
create index acoes_operador_cliente_em on public.acoes_operador (cliente_id, em);
alter table public.acoes_operador enable row level security;

commit;
