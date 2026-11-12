import { describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { criarModeloClaude, ErroModeloFatal, precosDoAmbiente } from './modeloClaude.ts';
import type { PedidoModelo } from './agentes.ts';

const esquemaSaida = {
  type: 'object', additionalProperties: false, required: ['texto_modelo'],
  properties: { texto_modelo: { type: 'string', minLength: 10, maxLength: 600 } },
};
const pedido: PedidoModelo = {
  modelo: 'modelo-x', sistema: 'Você escreve ofertas.', entrada: '{"oferta":{}}', esquemaSaida, ferramentas: [],
};

function mensagem(parcial: Partial<Anthropic.Message>): Anthropic.Message {
  return {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'modelo-x', stop_reason: 'end_turn', stop_sequence: null,
    content: [{ type: 'text', text: '{"texto_modelo":"Oferta boa {{link}}"}', citations: null } as Anthropic.TextBlock],
    usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 7 } as Anthropic.Usage,
    ...parcial,
  } as Anthropic.Message;
}

/** Cliente falso do SDK: guarda o pedido e devolve (ou lança) o que for configurado. */
function clienteFalso(resposta: Anthropic.Message | Error) {
  const pedidos: { corpo: Anthropic.MessageCreateParamsNonStreaming; opcoes: unknown }[] = [];
  const cliente = {
    messages: {
      create: async (corpo: Anthropic.MessageCreateParamsNonStreaming, opcoes: unknown) => {
        pedidos.push({ corpo, opcoes });
        if (resposta instanceof Error) throw resposta;
        return resposta;
      },
    },
  } as unknown as Pick<Anthropic, 'messages'>;
  return { cliente, pedidos };
}

describe('criarModeloClaude', () => {
  it('monta o pedido: modelo, sistema, esforço baixo, saída em JSON com esquema aceito pela API', async () => {
    const { cliente, pedidos } = clienteFalso(mensagem({}));
    const r = await criarModeloClaude({ cliente }).gerar({ ...pedido, correcao: 'Corrija: faltou o link.' });
    expect(r).toEqual({ texto: '{"texto_modelo":"Oferta boa {{link}}"}', tokensEntrada: 112, tokensSaida: 20 });
    const { corpo, opcoes } = pedidos[0]!;
    expect(corpo.model).toBe('modelo-x');
    expect(corpo.system).toBe('Você escreve ofertas.');
    expect(corpo.messages).toEqual([{ role: 'user', content: '{"oferta":{}}\n\nCorrija: faltou o link.' }]);
    expect(corpo.output_config!.effort).toBe('low');
    const formato = corpo.output_config!.format as { type: string; schema: Record<string, any> };
    expect(formato.type).toBe('json_schema');
    expect(formato.schema.additionalProperties).toBe(false);
    // restrições que a API não aceita saem do esquema enviado (o harness confere depois)
    expect(formato.schema.properties.texto_modelo.maxLength).toBeUndefined();
    expect(corpo).not.toHaveProperty('thinking');
    expect(opcoes).toEqual({ timeout: 60_000 });
  });

  it('não altera o esquema original do agente', async () => {
    const { cliente } = clienteFalso(mensagem({}));
    await criarModeloClaude({ cliente }).gerar(pedido);
    expect(esquemaSaida.properties.texto_modelo.maxLength).toBe(600);
  });

  it('recusa e resposta cortada viram erro', async () => {
    const recusa = clienteFalso(mensagem({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null } } as never));
    await expect(criarModeloClaude({ cliente: recusa.cliente }).gerar(pedido)).rejects.toThrow('recusou a tarefa (categoria: cyber)');
    const cortada = clienteFalso(mensagem({ stop_reason: 'max_tokens' }));
    await expect(criarModeloClaude({ cliente: cortada.cliente }).gerar(pedido)).rejects.toThrow('cortada');
  });

  it('chave inválida é erro fatal; erro de servidor não', async () => {
    const auth = clienteFalso(Anthropic.APIError.generate(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'invalid x-api-key', new Headers()));
    await expect(criarModeloClaude({ cliente: auth.cliente }).gerar(pedido)).rejects.toBeInstanceOf(ErroModeloFatal);
    const servidor = clienteFalso(Anthropic.APIError.generate(529, { type: 'error', error: { type: 'overloaded_error', message: 'sobrecarga' } }, 'sobrecarga', new Headers()));
    const erro = await criarModeloClaude({ cliente: servidor.cliente }).gerar(pedido).catch((e) => e);
    expect(erro).toBeInstanceOf(Anthropic.APIError);
    expect(erro).not.toBeInstanceOf(ErroModeloFatal);
    const rede = clienteFalso(new Anthropic.APIConnectionError({ message: 'rede caiu' }));
    expect(await criarModeloClaude({ cliente: rede.cliente }).gerar(pedido).catch((e) => e)).not.toBeInstanceOf(ErroModeloFatal);
  });

  it('erro de configuração do SDK (sem chave) é fatal', async () => {
    const { cliente } = clienteFalso(new Error('Could not resolve authentication method.'));
    await expect(criarModeloClaude({ cliente }).gerar(pedido)).rejects.toThrow('ANTHROPIC_API_KEY');
  });

  it('ferramentas ainda não são suportadas', async () => {
    const { cliente } = clienteFalso(mensagem({}));
    await expect(criarModeloClaude({ cliente }).gerar({ ...pedido, ferramentas: ['busca'] })).rejects.toBeInstanceOf(ErroModeloFatal);
  });
});

describe('precosDoAmbiente', () => {
  it('lê os preços por porte', () => {
    expect(precosDoAmbiente({ MODELO_IA_PEQUENO: 'p', MODELO_IA_PEQUENO_PRECO: '0.1, 0.5', MODELO_IA_FORTE: 'f' })).toEqual({
      p: { entradaPorMilhao: 0.1, saidaPorMilhao: 0.5 },
    });
    expect(() => precosDoAmbiente({ MODELO_IA_FORTE: 'f', MODELO_IA_FORTE_PRECO: 'caro' })).toThrow('inválido');
  });
});
