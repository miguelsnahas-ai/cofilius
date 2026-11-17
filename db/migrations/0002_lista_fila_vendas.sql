-- Cofilius · lista diária, fila de tarefas e atribuição de vendas
--
-- * Mensagens: o banco garante a ordem dos estados (rascunho → validada → aprovada → enviada → medida).
--   Nada chega a "enviada" sem passar por "aprovada". Toda mensagem nasce como rascunho.
-- * Mensagens guardam o preço e o desconto usados no texto, para conferir antes do envio.
-- * Ofertas guardam quando o preço foi conferido pela última vez.
-- * Tarefas ganham uma chave para não agendar a mesma etapa duas vezes no mesmo dia.
-- * Vendas guardam como foram atribuídas a um link.

begin;

alter table public.clientes
  add column limite_mensagens_dia integer not null default 10 check (limite_mensagens_dia between 1 and 100);

alter table public.ofertas
  add column preco_conferido_em timestamptz not null default now();

alter table public.mensagens
  add column preco_usado     numeric(12, 2),
  add column desconto_usado  numeric(7, 4),
  add column validacao       jsonb,
  add column validada_em     timestamptz,
  add column aprovada_em     timestamptz,
  add column aprovada_por    text;

-- Uma mesma oferta não entra duas vezes na lista do mesmo dia (descartadas não contam).
create unique index mensagens_uma_por_oferta_dia
  on public.mensagens (cliente_id, data_lista, oferta_id)
  where estado <> 'descartada' and oferta_id is not null;

-- Toda mensagem nasce como rascunho.
create or replace function public.mensagens_nasce_rascunho()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.estado <> 'rascunho' then
    raise exception 'mensagem nova precisa começar como rascunho (veio %)', new.estado
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger mensagens_nasce_rascunho
  before insert on public.mensagens
  for each row execute function public.mensagens_nasce_rascunho();

-- Transições de estado permitidas.
create or replace function public.mensagens_transicao()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.estado = old.estado then
    return new;
  end if;
  if (old.estado, new.estado) not in (
    ('rascunho', 'validada'), ('rascunho', 'descartada'),
    ('validada', 'aprovada'), ('validada', 'rascunho'), ('validada', 'descartada'),
    ('aprovada', 'enviada'), ('aprovada', 'validada'), ('aprovada', 'descartada'),
    ('enviada', 'medida')
  ) then
    raise exception 'transição de mensagem não permitida: % → %', old.estado, new.estado
      using errcode = 'check_violation';
  end if;
  if new.estado in ('validada', 'aprovada', 'enviada') and (new.texto_final is null or new.link_id is null) then
    raise exception 'mensagem sem texto final ou sem link não pode ir para %', new.estado
      using errcode = 'check_violation';
  end if;
  if new.estado = 'validada' then new.validada_em := coalesce(new.validada_em, now()); end if;
  if new.estado = 'aprovada' then new.aprovada_em := now(); end if;
  if new.estado = 'enviada' then new.enviada_em := coalesce(new.enviada_em, now()); end if;
  if new.estado = 'rascunho' then new.validada_em := null; end if;
  return new;
end;
$$;

create trigger mensagens_transicao
  before update of estado on public.mensagens
  for each row execute function public.mensagens_transicao();

-- Mexer no texto ou no link de uma mensagem validada ou aprovada a devolve para rascunho
-- (precisa validar e aprovar de novo). Enviada e medida não mudam mais.
create or replace function public.mensagens_conteudo_mudou()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.texto_modelo, new.texto_final, new.link_id, new.oferta_id, new.preco_usado)
     is distinct from (old.texto_modelo, old.texto_final, old.link_id, old.oferta_id, old.preco_usado) then
    if old.estado in ('enviada', 'medida') then
      raise exception 'mensagem já enviada não pode ser alterada' using errcode = 'check_violation';
    end if;
    if old.estado in ('validada', 'aprovada') and new.estado = old.estado then
      new.estado := 'rascunho';
      new.validada_em := null;
      new.aprovada_em := null;
      new.aprovada_por := null;
    end if;
  end if;
  return new;
end;
$$;

create trigger mensagens_conteudo_mudou
  before update on public.mensagens
  for each row execute function public.mensagens_conteudo_mudou();

-- Tarefas: chave para não repetir a mesma etapa (ex.: "ofertas.coletar:2026-11-12:casa").
alter table public.tarefas add column chave text;
create unique index tarefas_chave_unica on public.tarefas (cliente_id, chave) where chave is not null;
-- Tarefas presas em "executando" (processo caiu) são devolvidas à fila por tempo.
create index tarefas_executando on public.tarefas (iniciada_em) where estado = 'executando';

-- Vendas: como a venda foi ligada ao link.
alter table public.vendas
  add column atribuida_por text check (atribuida_por in ('chave_rastreio', 'etiqueta_produto')),
  add column produto_diferente boolean not null default false;
create index vendas_cliente_chave on public.vendas (cliente_id, plataforma, chave_rastreio);

commit;
