-- Cofilius · painel na nuvem (Vercel)
--
-- configuracoes: o que o painel grava na aba Configuração quando não há arquivo .env (Vercel não deixa
--   gravar arquivo). Chaves de API cifradas com CREDENCIAIS_CHAVE (que fica só nas variáveis do Vercel).
-- tentativas_acesso: senha ou código de extensão errados, por IP, para bloquear quem tenta adivinhar.

begin;

create table public.configuracoes (
  chave          text primary key check (chave ~ '^[A-Z][A-Z0-9_]*$'),
  valor          text not null,
  cifrado        boolean not null default false,
  atualizado_em  timestamptz not null default now()
);
alter table public.configuracoes enable row level security;

create table public.tentativas_acesso (
  id        bigserial primary key,
  ip        text not null,
  tipo      text not null check (tipo in ('senha', 'extensao')),
  em        timestamptz not null default now()
);
create index tentativas_acesso_ip_em on public.tentativas_acesso (ip, em desc);
alter table public.tentativas_acesso enable row level security;

commit;
