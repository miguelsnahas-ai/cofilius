-- Cliente de teste. Pode rodar mais de uma vez.
-- Não contém credenciais: elas entram pelo comando `npm run cli -- credenciais-shopee`.
insert into public.clientes (cliente_id, codigo, nome, whatsapp, nichos, tom_grupo, horario_envio)
values (
  '00000000-0000-4000-8000-000000000001',
  'c1',
  'Cliente Teste',
  null,
  '[
    {"slug": "casa", "nome": "Casa e cozinha", "palavras_chave": ["organizador cozinha", "air fryer"]},
    {"slug": "beleza", "nome": "Beleza", "palavras_chave": ["skincare", "maquiagem"]}
  ]'::jsonb,
  'Próximo e animado, sem exagero. Frases curtas.',
  '08:00'
)
on conflict (cliente_id) do update
  set codigo = excluded.codigo,
      nome = excluded.nome,
      nichos = excluded.nichos,
      tom_grupo = excluded.tom_grupo,
      horario_envio = excluded.horario_envio;
