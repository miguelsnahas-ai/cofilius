import { describe, expect, it } from 'vitest';
import { ApiError } from '@google/genai';
import { criarModeloGemini, esquemaParaGemini } from './modeloGemini.ts';
import { ErroModeloFatal } from './modeloClaude.ts';
import { iaConfigurada, modeloDoPorte, provedorAtual } from './provedores.ts';
import { resolverModelo } from './agentes.ts';
import type { PedidoModelo } from './agentes.ts';

const esquemaSaida = {
  type: 'object', additionalProperties: false, required: ['texto_modelo'],
  properties: { texto_modelo: { type: 'string', minLength: 10, maxLength: 600 }, nota: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
};
const pedido: PedidoModelo = { modelo: 'gemini-teste', sistema: 'Você escreve ofertas.', entrada: '{"oferta":{}}', esquemaSaida, ferramentas: [] };

function resposta(parcial: Record<string, unknown> = {}) {
  return {
    text: '{"texto_modelo":"Oferta boa {{link}}"}',
    candidates: [{ finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 20, thoughtsTokenCount: 30 },
    ...parcial,
  };
}

function clienteFalso(r: unknown) {
  const pedidos: any[] = [];
  const cliente = { models: { generateContent: async (p: unknown) => { pedidos.push(p); if (r instanceof Error) throw r; return r; } } } as any;
  return { cliente, pedidos };
}

describe('esquemaParaGemini', () => {
  it('tira o que o Gemini não aceita, mantém nomes de campo e não altera o original', () => {
    const e = esquemaParaGemini(esquemaSaida) as any;
    expect(e.properties.texto_modelo).toEqual({ type: 'string' });
    expect(e.properties.nota).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    expect(e.additionalProperties).toBe(false);
    expect(esquemaSaida.properties.texto_modelo.maxLength).toBe(600);
  });
});

describe('criarModeloGemini', () => {
  it('monta o pedido em JSON com o esquema e soma o raciocínio aos tokens de saída', async () => {
    const { cliente, pedidos } = clienteFalso(resposta());
    const r = await criarModeloGemini({ cliente }).gerar({ ...pedido, correcao: 'Faltou o link.' });
    expect(r).toEqual({ texto: '{"texto_modelo":"Oferta boa {{link}}"}', tokensEntrada: 120, tokensSaida: 50 });
    expect(pedidos[0]).toMatchObject({
      model: 'gemini-teste',
      contents: [{ role: 'user', parts: [{ text: '{"oferta":{}}\n\nFaltou o link.' }] }],
      config: { systemInstruction: 'Você escreve ofertas.', responseMimeType: 'application/json' },
    });
    expect(pedidos[0].config.responseJsonSchema.properties.texto_modelo).toEqual({ type: 'string' });
  });

  it('bloqueio, resposta cortada ou vazia viram erro', async () => {
    const gerar = (r: unknown) => criarModeloGemini({ cliente: clienteFalso(r).cliente }).gerar(pedido);
    await expect(gerar(resposta({ promptFeedback: { blockReason: 'SAFETY' }, text: undefined }))).rejects.toThrow('bloqueou');
    await expect(gerar(resposta({ candidates: [{ finishReason: 'MAX_TOKENS' }] }))).rejects.toThrow('cortada');
    await expect(gerar(resposta({ candidates: [{ finishReason: 'SAFETY' }] }))).rejects.toThrow('interrompeu');
    await expect(gerar(resposta({ text: '' }))).rejects.toThrow('vazio');
  });

  it('chave inválida é fatal; limite do nível gratuito não é, e a mensagem explica', async () => {
    const chave = clienteFalso(new ApiError({ message: 'API key not valid', status: 400 }));
    await expect(criarModeloGemini({ cliente: chave.cliente }).gerar(pedido)).rejects.toBeInstanceOf(ErroModeloFatal);
    const limite = clienteFalso(new ApiError({ message: 'Resource exhausted', status: 429 }));
    const e = await criarModeloGemini({ cliente: limite.cliente }).gerar(pedido).catch((x) => x);
    expect(e).not.toBeInstanceOf(ErroModeloFatal);
    expect(e.message).toContain('limite do nível gratuito');
  });

  it('sem chave: erro claro, antes de qualquer chamada', () => {
    expect(() => criarModeloGemini({ apiKey: '' })).toThrow('falta a chave');
  });
});

describe('provedores', () => {
  it('Gemini é o padrão; Claude quando escolhido; modelos padrão por porte', () => {
    expect(provedorAtual({})).toBe('gemini');
    expect(provedorAtual({ IA_PROVEDOR: 'Claude' })).toBe('claude');
    expect(modeloDoPorte('pequeno', {})).toBe('gemini-3.5-flash-lite');
    expect(modeloDoPorte('forte', {})).toBe('gemini-4-hydrogen');
    expect(resolverModelo('forte', { IA_PROVEDOR: 'claude' })).toBe('claude-haiku-5-5');
    expect(resolverModelo('pequeno', { MODELO_IA_PEQUENO: 'outro' })).toBe('outro');
    expect(iaConfigurada({ GEMINI_API_KEY: 'x' })).toBe(true);
    expect(iaConfigurada({ ANTHROPIC_API_KEY: 'x' })).toBe(false);
    expect(iaConfigurada({ IA_PROVEDOR: 'claude', ANTHROPIC_API_KEY: 'x' })).toBe(true);
  });
});
