import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from '../../harness/db.ts';
import { BANCO_HABILITADO, bancoLimpo } from '../../testes/banco.ts';
import { buscarCliente, type Cliente } from '../../db/clientes.ts';
import { importarVendas, registrarCliques, type VendaNormalizada } from '../vendas/atribuicao.ts';
import { canalManual, type Canal } from '../disparador/disparador.ts';
import { dadosFechamento, enviarFechamento, fechamentoPronto, prepararFechamento, textoFechamentoAfiliada, type DadosFechamento } from './fechamentoAfiliada.ts';
import { painelDoDia } from '../../painel/api.ts';

const base: DadosFechamento = {
  inicio: '2026-11-09', fim: '2026-11-15', comissaoValidada: 12, comissaoPendente: 33.2, comissaoCancelada: 5, pedidos: 18,
  cancelados: 2, cliques: 412, anterior: 36.8, porPlataforma: [{ plataforma: 'shopee', comissao: 40 }, { plataforma: 'amazon', comissao: 5.2 }],
  maisVendidos: [{ nome: 'Kit Bodies', pedidos: 3, comissao: 9 }, { nome: 'Toalha', pedidos: 1, comissao: 2 }], nichoDestaque: { nicho: 'bebe', pedidos: 7, comissao: 19 },
};

describe('texto do fechamento para a afiliada', () => {
  const dia: DadosFechamento = { ...base, inicio: '2026-11-16', fim: '2026-11-16', anterior: 5 };

  it('diário: dia da semana, comissão do dia, comparação com a média dos 7 dias, mais vendidos, cancelados e dicas', () => {
    const t = textoFechamentoAfiliada('Silvana Gonçalves', dia, ['Ofertas de bebê pela manhã renderam mais.', '', 'Terceira dica', 'Quarta']);
    expect(t).toContain('Oi, Silvana! 👋 Seu resumo de segunda, 16/11:');
    expect(t).toContain('💰 *Comissão do dia: R$ 45,20*');
    expect(t).toContain('✅ R$ 12,00 já confirmada');
    expect(t).toContain('⏳ R$ 33,20 pendente');
    expect(t).toContain('Shopee R$ 40,00 · Amazon R$ 5,20');
    expect(t).toContain('📦 18 pedidos · 👆 412 cliques');
    expect(t).toContain('📈 R$ 40,20 acima da sua média dos últimos 7 dias (R$ 5,00 por dia)');
    expect(t).toContain('1. Kit Bodies · 3 pedidos · R$ 9,00');
    expect(t).toContain('*bebe* (7 pedidos, R$ 19,00)');
    expect(t).toContain('❌ 2 pedidos cancelados (R$ 5,00 que não entram)');
    expect(t).toContain('💡 *Para os próximos dias*');
    expect(t).toContain('• Terceira dica');
    expect(t).not.toContain('Quarta');
    expect(t.endsWith('Até amanhã! 💜')).toBe(true);
  });

  it('diário: abaixo da média, cancelados de dias anteriores, dia sem vendas', () => {
    const t = textoFechamentoAfiliada('Ana', { ...dia, anterior: 60, porPlataforma: [], cancelados: 0, comissaoCancelada: 0, nichoDestaque: null,
      canceladosAnteriores: { pedidos: 1, comissao: 2.5 } });
    expect(t).toContain('📉 R$ 14,80 abaixo da sua média dos últimos 7 dias (R$ 60,00 por dia)');
    expect(t).toContain('↩️ 1 pedido de dias anteriores foi cancelado (R$ 2,50 saem do pendente)');
    expect(t).not.toMatch(/❌|Shopee R\$|O que mais funcionou|💡/);
    const vazio = textoFechamentoAfiliada('Ana', { ...dia, comissaoValidada: 0, comissaoPendente: 0, pedidos: 0, cliques: 7, maisVendidos: [] });
    expect(vazio).toContain('Nesse dia não entrou venda pelo grupo.');
    expect(vazio).toContain('7 cliques');
    expect(vazio).not.toContain('💰');
    expect(textoFechamentoAfiliada('Ana', { ...dia, anterior: 0 })).toContain('📈 Primeiras vendas depois de uma semana parada');
  });

  it('período (sob demanda em Relatórios): datas e comparação com o período anterior', () => {
    const t = textoFechamentoAfiliada('Ana', base);
    expect(t).toContain('Seu resumo de 09/11 a 15/11:');
    expect(t).toContain('💰 *Comissão do período: R$ 45,20*');
    expect(t).toContain('📈 R$ 8,40 acima do período anterior');
    expect(t.endsWith('Até a próxima! 💜')).toBe(true);
  });
});

const venda = (o: Partial<VendaNormalizada>): VendaNormalizada => ({
  plataforma: 'shopee', pedidoId: 'P1', produtoId: '1', produtoNome: 'Organizador', valor: '30.00', comissao: '2.00',
  situacao: 'pendente', chaveRastreio: null, dataPedido: new Date('2026-11-10T15:00:00Z'), ...o,
});

describe.skipIf(!BANCO_HABILITADO)('fechamento gravado e enviado', () => {
  let sql: Sql;
  let cliente: Cliente;
  beforeAll(async () => { sql = await bancoLimpo(); cliente = await buscarCliente(sql, 'c1'); });
  afterAll(async () => { await sql?.end(); });
  beforeEach(async () => {
    await sql`truncate vendas, cliques, fechamentos cascade`;
    await importarVendas(sql, cliente, [
      venda({}),
      venda({ pedidoId: 'P2', situacao: 'validada', comissao: '5.00' }),
      venda({ pedidoId: 'P3', situacao: 'cancelada', comissao: '4.00' }),
      venda({ pedidoId: 'P0', comissao: '3.00', dataPedido: new Date('2026-11-04T15:00:00Z') }),
    ]);
    await registrarCliques(sql, cliente, [{ plataforma: 'shopee', chaveRastreio: 'sem-sub-id', dia: '2026-11-11', cliques: 40 }]);
  });

  it('dados da semana e da anterior vêm do banco', async () => {
    const d = await dadosFechamento(sql, cliente, '2026-11-09', '2026-11-15');
    expect(d).toMatchObject({ comissaoValidada: 5, comissaoPendente: 2, comissaoCancelada: 4, pedidos: 2, cancelados: 1, cliques: 40, anterior: 3 });
    expect(d.maisVendidos).toEqual([{ nome: 'Organizador', pedidos: 2, comissao: 7 }]);
  });

  it('prepara, fica pronto no Dia, envia uma vez e não reescreve depois de enviado', async () => {
    const f = await prepararFechamento(sql, cliente, '2026-11-09', '2026-11-15');
    expect(f.situacao).toBe('pronto');
    expect(f.texto).toContain('R$ 7,00');
    expect((await fechamentoPronto(sql, cliente, '2026-11-16'))?.id).toBe(f.id);
    expect(await fechamentoPronto(sql, cliente, '2026-12-20')).toBeNull(); // velho demais

    const enviados: [string, string][] = [];
    const canal: Canal = { nome: 'whatsapp', enviar: async (para, texto) => { enviados.push([para, texto]); return 'wamid.1'; } };
    await sql`update clientes set whatsapp = '5511999990000' where cliente_id = ${cliente.clienteId}`;
    const g = await enviarFechamento(sql, cliente, f.id, canal);
    expect(g).toMatchObject({ situacao: 'enviado', canal: 'whatsapp' });
    expect(enviados).toEqual([['5511999990000', f.texto]]);
    await expect(enviarFechamento(sql, cliente, f.id, canalManual)).rejects.toThrow('já foi enviado');
    expect(await fechamentoPronto(sql, cliente, '2026-11-16')).toBeNull();

    // Nova venda depois de enviado: o texto enviado fica como estava.
    await importarVendas(sql, cliente, [venda({ pedidoId: 'P9', comissao: '50.00' })]);
    const h = await prepararFechamento(sql, cliente, '2026-11-09', '2026-11-15');
    expect(h.texto).toBe(f.texto);
    expect(h.situacao).toBe('enviado');
  });

  it('diário: compara com a média dos 7 dias anteriores; só o último resumo pendente aparece', async () => {
    // P0 foi em 04/11 (R$ 3,00): média dos 7 dias antes de 10/11 = 3/7 por dia.
    const d = await dadosFechamento(sql, cliente, '2026-11-10', '2026-11-10');
    expect(d).toMatchObject({ comissaoPendente: 2, comissaoValidada: 5, anterior: 0.43 });
    const seg = await prepararFechamento(sql, cliente, '2026-11-09', '2026-11-09');
    const ter = await prepararFechamento(sql, cliente, '2026-11-10', '2026-11-10');
    expect(ter.texto).toContain('Seu resumo de terça, 10/11:');
    expect((await fechamentoPronto(sql, cliente, '2026-11-11'))?.id).toBe(ter.id);
    await enviarFechamento(sql, cliente, ter.id, canalManual);
    // O de segunda ficou sem enviar, mas não volta a aparecer: só o último dia conta.
    expect(await fechamentoPronto(sql, cliente, '2026-11-11')).toBeNull();
    expect(seg.situacao).toBe('pronto');
    // O do próprio dia (ainda em andamento) nunca aparece.
    await prepararFechamento(sql, cliente, '2026-11-11', '2026-11-11');
    expect(await fechamentoPronto(sql, cliente, '2026-11-11')).toBeNull();
  });

  it('o Dia de hoje monta o resumo de ontem e diz se as vendas de ontem já chegaram', async () => {
    const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const d = new Date(`${hoje}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1);
    const ontem = d.toISOString().slice(0, 10);
    await importarVendas(sql, cliente, [venda({ pedidoId: 'ONTEM', comissao: '4.00', dataPedido: new Date(`${ontem}T15:00:00Z`) })]);
    const r = await painelDoDia({ sql, operador: 'op' }, 'c1');
    expect(r.fechamento).toMatchObject({ inicio: ontem, fim: ontem, situacao: 'pronto', vendasDoDiaCompletas: true });
    expect(r.fechamento!.texto).toContain('💰 *Comissão do dia: R$ 4,00*');
    // Vendas atualizadas pela última vez antes de ontem acabar: o resumo avisa que pode estar incompleto.
    // (o gatilho do banco põe "agora" em todo update: desliga só para simular uma atualização antiga)
    await sql`alter table vendas disable trigger user`;
    await sql`update vendas set atualizado_em = ${new Date(`${ontem}T15:00:00Z`)}`;
    await sql`alter table vendas enable trigger user`;
    expect((await painelDoDia({ sql, operador: 'op' }, 'c1')).fechamento!.vendasDoDiaCompletas).toBe(false);
  });
});

