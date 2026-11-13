-- Cofilius · eventos de venda (avisos de cancelamento)
--
-- Gravado pela importação de vendas quando uma venda já conhecida muda para "cancelada".
-- visto_em: quando o operador deu ciência no painel (até lá, o aviso aparece no Dia).

begin;

create table public.eventos_vendas (
  id            uuid primary key default gen_random_uuid(),
  cliente_id    uuid not null references public.clientes (cliente_id) on delete cascade,
  plataforma    text not null,
  pedido_id     text not null,
  produto_id    text not null,
  produto_nome  text,
  de            text not null,
  para          text not null,
  comissao      numeric(12, 2),
  link_id       uuid,
  data_pedido   timestamptz,
  visto_em      timestamptz,
  criado_em     timestamptz not null default now()
);
create index eventos_vendas_cliente on public.eventos_vendas (cliente_id, criado_em desc);
create index eventos_vendas_nao_vistos on public.eventos_vendas (cliente_id) where visto_em is null;
alter table public.eventos_vendas enable row level security;

commit;
