-- Cofilius · fechamento semanal para a afiliada
--
-- Um por cliente e período. O texto é montado pelo código com os números do banco; da IA vêm, no
-- máximo, as frases de leitura do Analista (que não podem conter valores).
-- situacao: pronto (esperando o operador mandar) → enviado.

begin;

create table public.fechamentos (
  id           uuid primary key default gen_random_uuid(),
  cliente_id   uuid not null references public.clientes (cliente_id) on delete cascade,
  inicio       date not null,
  fim          date not null,
  texto        text not null,
  dados        jsonb not null default '{}'::jsonb,
  situacao     text not null default 'pronto' check (situacao in ('pronto', 'enviado')),
  canal        text check (canal in ('manual', 'whatsapp')),
  id_externo   text,
  enviado_em   timestamptz,
  criado_em    timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (cliente_id, inicio, fim),
  check (inicio <= fim)
);
create index fechamentos_cliente_fim on public.fechamentos (cliente_id, fim desc);
create trigger fechamentos_atualizado before update on public.fechamentos
  for each row execute function public.tocar_atualizado_em();
alter table public.fechamentos enable row level security;

commit;
