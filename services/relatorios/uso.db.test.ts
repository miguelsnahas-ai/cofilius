import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../../harness/db.ts';
import { BANCO_HABILITADO, bancoLimpo } from '../../testes/banco.ts';
import { buscarCliente } from '../../db/clientes.ts';
import { minutosEstimados, registrarAcao, usoPorCliente } from './uso.ts';
import { marcarMedidas } from '../lista/medicao.ts';

const t = (hhmm: string, dia = '2026-11-12') => new Date(`${dia}T${hhmm}:00-03:00`);

describe('minutosEstimados', () => {
  it('soma sessões; intervalo maior que 10 min abre outra sessão; ação isolada vale 1 min', () => {
    expect(minutosEstimados([])).toBe(0);
    expect(minutosEstimados([t('08:00')])).toBe(1);
    expect(minutosEstimados([t('08:00'), t('08:04'), t('08:09')])).toBe(10);
    expect(minutosEstimados([t('08:09'), t('08:00'), t('08:30'), t('08:35')])).toBe(16);
  });
});

describe.skipIf(!BANCO_HABILITADO)('uso por cliente e medição', () => {
  let sql: Sql;
  beforeAll(async () => { sql = await bancoLimpo(); });
  afterAll(async () => { await sql?.end(); });

  it('minutos por dia, ações e custo de IA', async () => {
    const c = await buscarCliente(sql, 'c1');
    for (const h of ['08:00', '08:05', '08:12']) await registrarAcao(sql, c.clienteId, 'aprovar', 'painel', 'Miguel', t(h));
    await registrarAcao(sql, c.clienteId, 'abrir_dia', 'painel', 'Miguel', t('09:00', '2026-11-13'));
    await sql`insert into execucoes_agente (cliente_id, agente, versao_prompt, modelo, entrada, saida_valida, custo_usd, criado_em)
              values (${c.clienteId}, 'redator', 'v', 'm', '{}', true, 0.0012, ${t('08:01')}), (${c.clienteId}, 'curador', 'v', 'm', '{}', true, 0.003, ${t('08:02')})`;
    const [u] = await usoPorCliente(sql, '2026-11-12', '2026-11-13');
    expect(u).toMatchObject({ codigo: 'c1', acoes: 4, minutosOperador: 14, diasComAcao: 2, minutosPorDia: 7, chamadasIa: 2, custoIaUsd: '0.0042' });
    const [fora] = await usoPorCliente(sql, '2026-11-14', '2026-11-20');
    expect(fora).toMatchObject({ acoes: 0, minutosOperador: 0, chamadasIa: 0 });
  });

  it('marca como medida só a enviada há mais de 7 dias', async () => {
    const c = await buscarCliente(sql, 'c1');
    await sql`insert into links (cliente_id, plataforma, url_origem, url_afiliado, chave_rastreio, canal) values (${c.clienteId}, 'shopee', 'x', 'https://s.shopee.com.br/a', 'k', 'wa')`;
    const [l] = await sql`select id from links limit 1`;
    for (const dias of [10, 3]) {
      const [m] = await sql`insert into mensagens (cliente_id, link_id, texto_modelo, texto_final, data_lista) values (${c.clienteId}, ${l!.id}, 'x {{link}}', 'x', '2026-11-01') returning id`;
      await sql`update mensagens set estado = 'validada' where id = ${m!.id}`;
      await sql`update mensagens set estado = 'aprovada' where id = ${m!.id}`;
      await sql`update mensagens set estado = 'enviada', enviada_em = now() - ${`${dias} days`}::interval where id = ${m!.id}`;
    }
    expect(await marcarMedidas(sql, c.clienteId)).toBe(1);
    const estados = await sql`select estado from mensagens order by enviada_em`;
    expect(estados.map((e) => e.estado)).toEqual(['medida', 'enviada']);
  });
});
