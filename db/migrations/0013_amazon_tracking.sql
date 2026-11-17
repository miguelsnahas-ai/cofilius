-- Cofilius · tracking IDs da Amazon por canal
--
-- O link de afiliado da Amazon é o endereço do produto com o tracking ID (tag) da afiliada. Um tracking ID
-- por canal separa o que vendeu no WhatsApp do que vendeu no Instagram: {"wa": "loja-20", "ig": "lojaig-20"}.

begin;

alter table public.clientes
  add column amazon_tracking jsonb not null default '{}'::jsonb check (jsonb_typeof(amazon_tracking) = 'object');

commit;
