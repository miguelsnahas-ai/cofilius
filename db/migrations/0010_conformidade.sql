-- Cofilius · conformidade por cliente
--
-- identificacao: texto de identificação de publicidade posto no começo de cada mensagem e legenda
--   (Guia do CONAR para influenciadores: link com comissão é publicidade e deve ser identificado).
-- checklist: itens que só a afiliada pode fazer nos painéis dos programas, com a data em que foram feitos.

begin;

alter table public.clientes
  add column conformidade jsonb not null default '{"identificacao": "#publi", "checklist": {}}'::jsonb
  check (jsonb_typeof(conformidade) = 'object');

commit;
