import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { Sql } from './db.ts';
import { BANCO_HABILITADO, bancoLimpo } from '../testes/banco.ts';
import { buscarCliente } from '../db/clientes.ts';
import {
  carregarAgente, contem, ErroAgente, executarAgente, lerJsonDoModelo, resolverModelo, rodarCasos, versaoDoPrompt,
  type ContratoAgente, type ModeloIA, type PedidoModelo,
} from './agentes.ts';
import { regrasRedator, type EntradaRedator, type SaidaRedator } from '../agents/redator/regras.ts';

/** Modelo falso: devolve as respostas na ordem e guarda os pedidos. */
function modeloFalso(respostas: string[]) {
  const pedidos: PedidoModelo[] = [];
  const modelo: ModeloIA = {
    async gerar(p) {
      pedidos.push(p);
      const texto = respostas.shift();
      if (texto === undefined) throw new Error('sem resposta');
      return { texto, tokensEntrada: 1000, tokensSaida: 200 };
    },
  };
  return { modelo, pedidos };
}

const entradaOk: EntradaRedator = {
  oferta: { titulo: 'Organizador de Gaveta', nicho: 'casa', tem_desconto: true },
  tom: 'animado',
  exemplos: [],
};

describe('utilitários', () => {
  it('lerJsonDoModelo aceita cerca de código', () => {
    expect(lerJsonDoModelo('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => lerJsonDoModelo('oi')).toThrow();
  });
  it('contem compara parcialmente', () => {
    expect(contem({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 2 } })).toBe(true);
    expect(contem({ ids: ['x', 'y'] }, { ids: ['x'] })).toBe(false);
    expect(contem({ a: 1 }, { a: 2 })).toBe(false);
  });
  it('a versão do prompt muda quando o texto muda', async () => {
    const a = await versaoDoPrompt({ nome: 'redator', prompt: 'v1' });
    expect(a).toMatch(/^redator@[0-9a-f]{12}$/);
    expect(await versaoDoPrompt({ nome: 'redator', prompt: 'v2' })).not.toBe(a);
  });
  it('resolverModelo usa o ambiente', () => {
    expect(resolverModelo('pequeno', { MODELO_IA_PEQUENO: 'm-p' })).toBe('m-p');
    expect(() => resolverModelo('forte', {})).toThrow('MODELO_IA_FORTE');
  });
});

describe.skipIf(!BANCO_HABILITADO)('executarAgente', () => {
  let sql: Sql;
  let clienteId: string;
  let contrato: ContratoAgente<EntradaRedator, SaidaRedator>;

  beforeAll(async () => {
    sql = await bancoLimpo();
    clienteId = (await buscarCliente(sql, 'c1')).clienteId;
    const { contrato: c } = await carregarAgente(join(import.meta.dirname, '../agents/redator'));
    contrato = { ...c, modelo: 'modelo-de-teste', regrasSaida: regrasRedator };
  });
  afterAll(async () => { await sql?.end(); });
  beforeEach(async () => { await sql`truncate execucoes_agente`; });

  const precos = { 'modelo-de-teste': { entradaPorMilhao: 1, saidaPorMilhao: 5 } };

  it('saída válida na primeira: grava execução com versão, tokens e custo', async () => {
    const { modelo, pedidos } = modeloFalso(['{"texto_modelo":"Organizador lindo por {{preco}} 👉 {{link}}"}']);
    const r = await executarAgente(sql, { contrato, clienteId, entrada: entradaOk, modelo, precos });
    expect(r).toMatchObject({ tentativas: 1, saida: { texto_modelo: 'Organizador lindo por {{preco}} 👉 {{link}}' } });
    expect(pedidos[0]).toMatchObject({ modelo: 'modelo-de-teste', ferramentas: [] });
    expect(pedidos[0]!.sistema).toContain('{{link}}');
    const [e] = await sql`select agente, versao_prompt, saida_valida, tokens_entrada, tokens_saida, custo_usd::text, duracao_ms from execucoes_agente`;
    expect(e).toMatchObject({ agente: 'redator', saida_valida: true, tokens_entrada: 1000, tokens_saida: 200, custo_usd: '0.002000' });
    expect(e!.versao_prompt).toBe(r.versaoPrompt);
  });

  it('saída inválida é descartada e repetida, com o motivo enviado ao modelo', async () => {
    const { modelo, pedidos } = modeloFalso([
      'não é json',
      '{"texto_modelo":"Só R$ 29,90 hoje! 👉 {{link}}"}',
      '{"texto_modelo":"Organizador por {{preco}} 👉 {{link}}"}',
    ]);
    const r = await executarAgente(sql, { contrato, clienteId, entrada: entradaOk, modelo });
    expect(r.tentativas).toBe(3);
    expect(pedidos[1]!.correcao).toContain('não é JSON');
    expect(pedidos[2]!.correcao).toContain('valor em dinheiro');
    const linhas = await sql`select saida_valida, erro, saida from execucoes_agente order by criado_em`;
    expect(linhas.map((l) => l.saida_valida)).toEqual([false, false, true]);
    expect(linhas[0]!.saida).toEqual({ texto_bruto: 'não é json' });
  });

  it('depois de 2 repetições sem saída válida, erro (e 3 execuções gravadas)', async () => {
    const { modelo } = modeloFalso(['{}', '{"texto_modelo": 5}', '{"texto_modelo":"sem link nenhum aqui"}']);
    await expect(executarAgente(sql, { contrato, clienteId, entrada: entradaOk, modelo })).rejects.toBeInstanceOf(ErroAgente);
    const [c] = await sql<{ n: number }[]>`select count(*)::int as n from execucoes_agente where not saida_valida`;
    expect(c!.n).toBe(3);
  });

  it('regra do Redator: {{desconto}} só com desconto', async () => {
    const { modelo } = modeloFalso([
      '{"texto_modelo":"Air fryer com {{desconto}} off 👉 {{link}}"}',
      '{"texto_modelo":"Air fryer 4L por {{preco}} 👉 {{link}}"}',
    ]);
    const entrada = { ...entradaOk, oferta: { ...entradaOk.oferta, tem_desconto: false } };
    const r = await executarAgente(sql, { contrato, clienteId, entrada, modelo });
    expect(r.tentativas).toBe(2);
  });

  it('entrada fora do esquema não chega ao modelo', async () => {
    const { modelo, pedidos } = modeloFalso([]);
    const entrada = { ...entradaOk, preco: '29.90' } as unknown as EntradaRedator;
    await expect(executarAgente(sql, { contrato, clienteId, entrada, modelo })).rejects.toThrow('entrada fora do esquema');
    expect(pedidos).toHaveLength(0);
  });

  it('modelo fora do ar conta como tentativa e é registrado', async () => {
    const { modelo } = modeloFalso([]);
    await expect(executarAgente(sql, { contrato, clienteId, entrada: entradaOk, modelo })).rejects.toThrow('recusada 3 vezes');
    const [e] = await sql`select erro from execucoes_agente limit 1`;
    expect(e!.erro).toContain('falha ao chamar o modelo');
  });

  it('casos de teste do Redator passam pelo mesmo caminho', async () => {
    const { casos } = await carregarAgente(join(import.meta.dirname, '../agents/redator'));
    expect(casos.length).toBeGreaterThanOrEqual(3);
    const { modelo } = modeloFalso(casos.map(() => '{"texto_modelo":"Achado do dia por {{preco}} 👉 {{link}}"}'));
    const r = await rodarCasos(sql, { contrato, casos, modelo, clienteId });
    expect(r.every((x) => x.ok)).toBe(true);
  });
});
