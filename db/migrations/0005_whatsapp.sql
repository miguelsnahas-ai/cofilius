-- Cofilius · canal de envio e recebimento (WhatsApp)
--
-- * mensagens: por qual canal saiu e o id dela no canal (para casar os avisos de entrega e leitura).
-- * pedidos_afiliado: id da mensagem recebida no canal, para não processar duas vezes o mesmo aviso
--   (o WhatsApp reenvia o aviso se não recebe resposta a tempo).

begin;

alter table public.mensagens
  add column canal text check (canal in ('manual', 'whatsapp')),
  add column id_externo text;
create unique index mensagens_id_externo on public.mensagens (canal, id_externo) where id_externo is not null;

alter table public.pedidos_afiliado
  add column canal text check (canal in ('painel', 'whatsapp')),
  add column id_externo text;
create unique index pedidos_afiliado_id_externo on public.pedidos_afiliado (canal, id_externo) where id_externo is not null;

commit;
