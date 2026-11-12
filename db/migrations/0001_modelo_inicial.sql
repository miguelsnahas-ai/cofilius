-- Cofilius · modelo de dados mínimo (docs/arquitetura.md, seção "Modelo de dados mínimo")
--
-- Regras:
-- * Toda tabela tem cliente_id. Em `clientes`, ele é a própria chave primária.
-- * Referências entre tabelas de um mesmo cliente usam chave composta (cliente_id, id),
--   para que uma linha nunca aponte para dado de outro cliente.
-- * Valores em dinheiro: numeric(12,2). Percentuais: numeric(7,4), em pontos percentuais (12.5 = 12,5%).
-- * RLS ligado em todas as tabelas, sem políticas: as chaves públicas do Supabase (anon e
--   authenticated) não leem nada. O sistema acessa pelo usuário dono das tabelas (DATABASE_URL).

begin;

-- Atualiza a coluna atualizado_em em todo UPDATE.
create or replace function public.tocar_atualizado_em()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.atualizado_em := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- clientes
-- ---------------------------------------------------------------------------
create table public.clientes (
  cliente_id     uuid primary key default gen_random_uuid(),
  -- Código curto usado nas etiquetas de rastreio (sub_id da Shopee). Ex.: "c1".
  codigo         text not null unique check (codigo ~ '^[a-z0-9]{1,12}$'),
  nome           text not null,
  whatsapp       text,
  -- Lista de nichos: [{"slug": "casa", "nome": "Casa", "palavras_chave": ["organizador", "air fryer"]}]
  nichos         jsonb not null default '[]'::jsonb check (jsonb_typeof(nichos) = 'array'),
  tom_grupo      text,
  horario_envio  time,
  fuso_horario   text not null default 'America/Sao_Paulo',
  ativo          boolean not null default true,
  criado_em      timestamptz not null default now(),
  atualizado_em  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- credenciais: chaves de API e identificadores de afiliado, sempre cifrados (harness/cripto.ts)
-- ---------------------------------------------------------------------------
create table public.credenciais (
  id              uuid primary key default gen_random_uuid(),
  cliente_id      uuid not null references public.clientes (cliente_id) on delete cascade,
  plataforma      text not null check (plataforma in ('shopee', 'mercado_livre', 'amazon', 'whatsapp')),
  -- O que é: "open_api" (Shopee: App ID + Secret), "tracking_ids" (Amazon), etc.
  nome            text not null,
  valor_cifrado   text not null check (valor_cifrado like 'v1:%'),
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now(),
  unique (cliente_id, plataforma, nome)
);

-- ---------------------------------------------------------------------------
-- diretrizes_nicho: texto de curadoria versionado, por cliente e nicho
-- ---------------------------------------------------------------------------
create table public.diretrizes_nicho (
  id             uuid primary key default gen_random_uuid(),
  cliente_id     uuid not null references public.clientes (cliente_id) on delete cascade,
  nicho          text not null,
  versao         integer not null check (versao > 0),
  texto          text not null,
  situacao       text not null default 'proposta' check (situacao in ('proposta', 'aprovada', 'substituida', 'descartada')),
  proposta_por   text not null default 'operador',  -- 'operador' ou 'analista'
  aprovada_em    timestamptz,
  criado_em      timestamptz not null default now(),
  unique (cliente_id, nicho, versao)
);
-- No máximo uma diretriz aprovada (em vigor) por cliente e nicho.
create unique index diretrizes_nicho_uma_aprovada
  on public.diretrizes_nicho (cliente_id, nicho) where situacao = 'aprovada';

-- ---------------------------------------------------------------------------
-- ofertas: candidatas coletadas pelo Conector de ofertas
-- Uma linha por cliente + plataforma + produto + dia de coleta. Coletar de novo no mesmo dia
-- atualiza a linha; em outro dia cria outra (histórico de preço).
-- ---------------------------------------------------------------------------
create table public.ofertas (
  id               uuid primary key default gen_random_uuid(),
  cliente_id       uuid not null references public.clientes (cliente_id) on delete cascade,
  plataforma       text not null check (plataforma in ('shopee', 'mercado_livre', 'amazon')),
  produto_id       text not null,          -- itemId na Shopee
  loja_id          text,                   -- shopId na Shopee
  nicho            text,
  palavra_chave    text,
  titulo           text not null,
  url_produto      text not null,
  url_oferta       text,                   -- link de oferta devolvido pela plataforma (sem nossos sub_ids)
  imagem_url       text,
  loja_nome        text,
  preco            numeric(12, 2) not null check (preco >= 0),
  preco_maximo     numeric(12, 2) check (preco_maximo >= 0),
  desconto_pct     numeric(7, 4) check (desconto_pct between 0 and 100),
  comissao_pct     numeric(7, 4) check (comissao_pct between 0 and 100),
  comissao_valor   numeric(12, 2) check (comissao_valor >= 0),
  vendas           integer check (vendas >= 0),
  avaliacao        numeric(3, 2) check (avaliacao between 0 and 5),
  validade_inicio  timestamptz,
  validade_fim     timestamptz,
  data_coleta      date not null,
  dados_brutos     jsonb not null default '{}'::jsonb,
  criado_em        timestamptz not null default now(),
  atualizado_em    timestamptz not null default now(),
  unique (cliente_id, id),
  unique (cliente_id, plataforma, produto_id, data_coleta)
);
create index ofertas_cliente_data on public.ofertas (cliente_id, data_coleta desc);
create index ofertas_cliente_nicho_data on public.ofertas (cliente_id, nicho, data_coleta desc);

-- ---------------------------------------------------------------------------
-- links: link de afiliado gerado pelo serviço Links e rastreio
-- ---------------------------------------------------------------------------
create table public.links (
  id              uuid primary key default gen_random_uuid(),
  cliente_id      uuid not null references public.clientes (cliente_id) on delete cascade,
  oferta_id       uuid,
  plataforma      text not null check (plataforma in ('shopee', 'mercado_livre', 'amazon')),
  url_origem      text not null,
  url_afiliado    text not null,
  -- Shopee: os 5 sub_ids na ordem. Vazio nas outras plataformas.
  sub_ids         text[] not null default '{}',
  -- Chave de rastreio em texto, a mesma que volta nos relatórios:
  -- Shopee: sub_ids unidos por "-"; Mercado Livre: etiqueta; Amazon: tracking ID.
  chave_rastreio  text not null,
  canal           text not null,
  nicho           text,
  produto_id      text,
  contexto        jsonb not null default '{}'::jsonb,
  criado_em       timestamptz not null default now(),
  unique (cliente_id, id),
  foreign key (cliente_id, oferta_id) references public.ofertas (cliente_id, id) on delete set null (oferta_id)
);
create index links_cliente_chave on public.links (cliente_id, plataforma, chave_rastreio);
create index links_cliente_oferta on public.links (cliente_id, oferta_id);
create index links_cliente_criado on public.links (cliente_id, criado_em desc);

-- ---------------------------------------------------------------------------
-- mensagens: texto final, link e estado na esteira
-- ---------------------------------------------------------------------------
create table public.mensagens (
  id              uuid primary key default gen_random_uuid(),
  cliente_id      uuid not null references public.clientes (cliente_id) on delete cascade,
  oferta_id       uuid,
  link_id         uuid,
  -- Texto do Redator, só com marcadores ({{preco}}, {{desconto}}, {{link}}).
  texto_modelo    text not null,
  -- Texto com os marcadores preenchidos pelo código, a partir do banco.
  texto_final     text,
  estado          text not null default 'rascunho'
                  check (estado in ('rascunho', 'validada', 'aprovada', 'enviada', 'medida', 'descartada')),
  data_lista      date not null,
  agendada_para   timestamptz,
  enviada_em      timestamptz,
  entregue_em     timestamptz,
  lida_em         timestamptz,
  motivo_descarte text,
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now(),
  unique (cliente_id, id),
  foreign key (cliente_id, oferta_id) references public.ofertas (cliente_id, id) on delete set null (oferta_id),
  foreign key (cliente_id, link_id) references public.links (cliente_id, id) on delete set null (link_id)
);
create index mensagens_cliente_lista on public.mensagens (cliente_id, data_lista desc, estado);

-- ---------------------------------------------------------------------------
-- cliques: por link (ou chave de rastreio) e por dia
-- ---------------------------------------------------------------------------
create table public.cliques (
  id              uuid primary key default gen_random_uuid(),
  cliente_id      uuid not null references public.clientes (cliente_id) on delete cascade,
  plataforma      text not null check (plataforma in ('shopee', 'mercado_livre', 'amazon')),
  link_id         uuid,
  chave_rastreio  text not null,
  dia             date not null,
  cliques         integer not null check (cliques >= 0),
  origem          text not null default 'plataforma' check (origem in ('plataforma', 'redirecionador')),
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now(),
  unique (cliente_id, plataforma, chave_rastreio, dia, origem),
  foreign key (cliente_id, link_id) references public.links (cliente_id, id) on delete set null (link_id)
);
create index cliques_cliente_link on public.cliques (cliente_id, link_id);

-- ---------------------------------------------------------------------------
-- vendas: pedidos e comissões vindos dos relatórios das plataformas
-- link_id nulo = venda não atribuída (fica visível, não some).
-- ---------------------------------------------------------------------------
create table public.vendas (
  id               uuid primary key default gen_random_uuid(),
  cliente_id       uuid not null references public.clientes (cliente_id) on delete cascade,
  plataforma       text not null check (plataforma in ('shopee', 'mercado_livre', 'amazon')),
  pedido_id        text not null,
  produto_id       text not null,
  produto_nome     text,
  quantidade       integer not null default 1 check (quantidade > 0),
  valor            numeric(12, 2) check (valor >= 0),
  comissao         numeric(12, 2) check (comissao >= 0),
  situacao         text not null default 'pendente' check (situacao in ('pendente', 'validada', 'cancelada')),
  chave_rastreio   text,
  link_id          uuid,
  data_pedido      timestamptz,
  dados_brutos     jsonb not null default '{}'::jsonb,
  criado_em        timestamptz not null default now(),
  atualizado_em    timestamptz not null default now(),
  unique (cliente_id, plataforma, pedido_id, produto_id),
  foreign key (cliente_id, link_id) references public.links (cliente_id, id) on delete set null (link_id)
);
create index vendas_cliente_data on public.vendas (cliente_id, data_pedido desc);
create index vendas_cliente_link on public.vendas (cliente_id, link_id);
create index vendas_nao_atribuidas on public.vendas (cliente_id) where link_id is null;

-- ---------------------------------------------------------------------------
-- tarefas: fila do Agendador
-- ---------------------------------------------------------------------------
create table public.tarefas (
  id               uuid primary key default gen_random_uuid(),
  cliente_id       uuid not null references public.clientes (cliente_id) on delete cascade,
  tipo             text not null,
  entrada          jsonb not null default '{}'::jsonb,
  agendada_para    timestamptz not null default now(),
  estado           text not null default 'pendente'
                   check (estado in ('pendente', 'executando', 'concluida', 'falhou', 'cancelada')),
  tentativas       integer not null default 0 check (tentativas >= 0),
  max_tentativas   integer not null default 3 check (max_tentativas >= 0),
  resultado        jsonb,
  erro             text,
  iniciada_em      timestamptz,
  concluida_em     timestamptz,
  criado_em        timestamptz not null default now(),
  atualizado_em    timestamptz not null default now(),
  unique (cliente_id, id)
);
create index tarefas_fila on public.tarefas (agendada_para) where estado = 'pendente';
create index tarefas_cliente on public.tarefas (cliente_id, criado_em desc);

-- ---------------------------------------------------------------------------
-- pedidos_afiliado: o que o afiliado pediu pelo WhatsApp e o que foi feito
-- ---------------------------------------------------------------------------
create table public.pedidos_afiliado (
  id                  uuid primary key default gen_random_uuid(),
  cliente_id          uuid not null references public.clientes (cliente_id) on delete cascade,
  mensagem_original   text not null,
  intencao            text,   -- null = não reconhecida, vai para o operador
  situacao            text not null default 'aberto'
                      check (situacao in ('aberto', 'em_andamento', 'resolvido', 'encaminhado_operador')),
  tarefa_id           uuid,
  resposta            text,
  recebido_em         timestamptz not null default now(),
  resolvido_em        timestamptz,
  criado_em           timestamptz not null default now(),
  atualizado_em       timestamptz not null default now(),
  foreign key (cliente_id, tarefa_id) references public.tarefas (cliente_id, id) on delete set null (tarefa_id)
);
create index pedidos_afiliado_cliente on public.pedidos_afiliado (cliente_id, recebido_em desc);

-- ---------------------------------------------------------------------------
-- execucoes_agente: registro de cada execução de agente (harness)
-- ---------------------------------------------------------------------------
create table public.execucoes_agente (
  id               uuid primary key default gen_random_uuid(),
  cliente_id       uuid not null references public.clientes (cliente_id) on delete cascade,
  agente           text not null check (agente in ('curador', 'redator', 'analista', 'atendente')),
  versao_prompt    text not null,
  modelo           text not null,
  tarefa_id        uuid,
  entrada          jsonb not null,
  saida            jsonb,
  saida_valida     boolean,
  erro             text,
  duracao_ms       integer check (duracao_ms >= 0),
  tokens_entrada   integer check (tokens_entrada >= 0),
  tokens_saida     integer check (tokens_saida >= 0),
  custo_usd        numeric(12, 6) check (custo_usd >= 0),
  criado_em        timestamptz not null default now(),
  foreign key (cliente_id, tarefa_id) references public.tarefas (cliente_id, id) on delete set null (tarefa_id)
);
create index execucoes_agente_cliente on public.execucoes_agente (cliente_id, agente, criado_em desc);

-- ---------------------------------------------------------------------------
-- Gatilhos de atualizado_em e RLS
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['clientes', 'credenciais', 'ofertas', 'mensagens', 'cliques', 'vendas', 'tarefas', 'pedidos_afiliado']
  loop
    execute format('create trigger %I before update on public.%I for each row execute function public.tocar_atualizado_em()',
                   t || '_atualizado_em', t);
  end loop;

  foreach t in array array['clientes', 'credenciais', 'diretrizes_nicho', 'ofertas', 'links', 'mensagens', 'cliques',
                           'vendas', 'tarefas', 'pedidos_afiliado', 'execucoes_agente']
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end;
$$;

commit;
