import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from '../../harness/db.ts';
import { BANCO_HABILITADO, bancoLimpo } from '../../testes/banco.ts';
import { buscarCliente, type Cliente } from '../../db/clientes.ts';
import { importarVendas, registrarCliques, type VendaNormalizada } from '../vendas/atribuicao.ts';
import { canalManual, type Canal } from '../disparador/disparador.ts';
import { dadosFechamento, enviarFechamento, fechamentoPronto, prepararFechamento, textoFechamentoAfiliada, type DadosFechamento } from './fechamentoAfiliada.ts';

const base: DadosFechamento = {
  inicio: '2026-11-09', fim: '2026-11-15', comissaoValidada: 12, comissaoPendente: 33.2, comissaoCancelada: 5, pedidos: 18,
  cancelados: 2, cliques: 412, anterior: 36.8, porPlataforma: [{ plataforma: 'shopee', comissao: 40 }, { plataforma: 'amazon', comissao: 5.2 }],
  maisVendidos: [{ nome: 'Kit Bodies', pedidos: 3, comissao: 9 }, { nome: 'Toalha', pedidos: 1, comissao: 2 }], nichoDestaque: { nicho: 'bebe', pedidos: 7, comissao: 19 },
};

describe('texto do fechamento para a afiliada', () => {
  it('números, comparação com a semana anterior, mais vendidos, nicho, cancelados e dicas', () => {
    const t = textoFechamentoAfiliada('Silvana Gonçalves', base, ['Ofertas de bebê pela manhã renderam mais.', '', 'Terceira dica', 'Quarta']);
    expect(t).toContain('Oi, Silvana! 👋 Seu resumo da semana (09/11 a 15/11):');
    expect(t).toContain('💰 *Comissão da semana: R$ 45,20*');
    expect(t).toContain('✅ R$ 12,00 já confirmada');
    expect(t).toContain('⏳ R$ 33,20 pendente');
    expect(t).toContain('Shopee R$ 40,00 · Amazon R$ 5,20');
    expect(t).toContain('📦 18 pedidos · 👆 412 cliques');
    expect(t).toContain('📈 R$ 8,40 a mais que na semana anterior');
    expect(t).toContain('1. Kit Bodies · 3 pedidos · R$ 9,00');
    expect(t).toContain('2. Toalha · 1 pedido · R$ 2,00');
    expect(t).toContain('*bebe* (7 pedidos, R$ 19,00)');
    expect(t).toContain('❌ 2 pedidos cancelados (R$ 5,00 que não entram)');
    expect(t).toContain('• Ofertas de bebê pela manhã renderam mais.');
    expect(t).toContain('• Terceira dica');
    expect(t).not.toContain('Quarta');
  });

  it('semana pior, sem plataforma extra, sem cancelados', () => {
    const t = textoFechamentoAfiliada('Ana', { ...base, anterior: 60, porPlataforma: [], cancelados: 0, comissaoCancelada: 0, nichoDestaque: null });
    expect(t).toContain('📉 R$ 14,80 a menos que na semana anterior');
    expect(t).not.toMatch(/❌|Shopee R\$|O que mais funcionou|💡/);
  });

  it('semana sem vendas', () => {
    const t = textoFechamentoAfiliada('Ana', { ...base, comissaoValidada: 0, comissaoPendente: 0, pedidos: 0, cliques: 7, maisVendidos: [] });
    expect(t).toContain('ainda não entrou nenhuma venda');
    expect(t).toContain('7 cliques');
    expect(t).not.toContain('💰');
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
});
