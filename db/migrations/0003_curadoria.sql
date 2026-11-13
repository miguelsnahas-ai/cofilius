-- Cofilius · curadoria do dia
--
-- A escolha do Curador fica na própria oferta do dia: posição na lista, motivo de uma linha e a
-- versão do prompt que escolheu. Refazer a curadoria do dia apaga a escolha anterior desse dia.

begin;

alter table public.ofertas
  add column selecionada_em timestamptz,
  add column curadoria jsonb check (curadoria is null or jsonb_typeof(curadoria) = 'object');

create index ofertas_selecionadas
  on public.ofertas (cliente_id, data_coleta, ((curadoria ->> 'posicao')::int))
  where selecionada_em is not null;

commit;
