-- Cofilius · identidade da extensão pareada
--
-- O painel conversa direto com a extensão do Chrome (chrome.runtime.sendMessage) para pedir os links que
-- faltam. Para isso precisa do id da extensão instalada, que muda de computador para computador.

begin;

alter table public.pareamentos_extensao add column extensao_id text check (extensao_id ~ '^[a-p]{32}$');

commit;
