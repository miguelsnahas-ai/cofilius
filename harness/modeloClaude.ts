/**
 * Cliente da API do Claude para o harness dos agentes (implementa ModeloIA).
 *
 * - SDK oficial (@anthropic-ai/sdk): timeout por chamada e até 3 novas tentativas com espera crescente
 *   em erros transitórios (429, 5xx, rede) já vêm do SDK.
 * - Saída estruturada: `output_config.format` com o esquema de saída do agente. Restrições que a API não
 *   aceita (tamanho de texto, por exemplo) são retiradas do esquema enviado pelo SDK; o harness confere
 *   tudo de novo com o esquema completo.
 * - Recusa do modelo (`stop_reason: "refusal"`) e resposta cortada (`max_tokens`) viram erro, nunca texto.
 * - Erros que não se resolvem repetindo (chave inválida, pedido malformado) são marcados como fatais:
 *   o harness para na hora em vez de gastar as repetições.
 * - Identificador do modelo e chave vêm do ambiente (.env), nunca do código.
 */
import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { log } from './log.ts';
import type { ModeloIA, PedidoModelo, PrecoModelo, RespostaModelo } from './agentes.ts';

export type Esforco = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface OpcoesModeloClaude {
  /** Cliente do SDK (substituível nos testes). Padrão: new Anthropic() com a chave do ambiente. */
  cliente?: Pick<Anthropic, 'messages'>;
  /** Esforço do modelo. Padrão: "low" (textos curtos). */
  esforco?: Esforco;
  /** Teto de tokens da resposta (inclui o raciocínio do modelo). Padrão: 4000. */
  maxTokens?: number;
  /** Timeout por chamada, em ms. Padrão: 60 s. */
  timeoutMs?: number;
}

/** Erro que não melhora repetindo: o harness não usa as repetições nele. */
export class ErroModeloFatal extends Error {
  readonly fatal = true;
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'ErroModeloFatal';
  }
}

const STATUS_FATAIS = new Set([400, 401, 403, 404, 413, 422]);

export function criarModeloClaude(opcoes: OpcoesModeloClaude = {}): ModeloIA {
  const timeoutMs = opcoes.timeoutMs ?? 60_000;
  const cliente = opcoes.cliente ?? new Anthropic({ timeout: timeoutMs, maxRetries: 3 });

  return {
    async gerar(p: PedidoModelo): Promise<RespostaModelo> {
      if (p.ferramentas.length) {
        throw new ErroModeloFatal(`ferramentas ainda não implementadas no cliente: ${p.ferramentas.join(', ')}`);
      }
      const conteudo = p.correcao ? `${p.entrada}\n\n${p.correcao}` : p.entrada;
      const inicio = Date.now();
      let resposta: Anthropic.Message;
      try {
        resposta = await cliente.messages.create(
          {
            model: p.modelo,
            max_tokens: opcoes.maxTokens ?? 4000,
            system: p.sistema,
            messages: [{ role: 'user', content: conteudo }],
            output_config: {
              effort: opcoes.esforco ?? 'low',
              format: jsonSchemaOutputFormat(p.esquemaSaida as Parameters<typeof jsonSchemaOutputFormat>[0]),
            },
          },
          { timeout: timeoutMs },
        );
      } catch (erro) {
        // Rede, timeout e respostas da API chegam como APIError. Qualquer outro erro acontece antes da
        // chamada (ex.: nenhuma credencial configurada) e não melhora repetindo: fatal.
        if (!(erro instanceof Anthropic.APIError)) {
          log.error('claude.erro_configuracao', { modelo: p.modelo, erro: (erro as Error).message });
          throw new ErroModeloFatal(`configuração da API do Claude: ${(erro as Error).message} (defina ANTHROPIC_API_KEY no .env)`);
        }
        if (erro instanceof Anthropic.APIError && erro.status !== undefined && STATUS_FATAIS.has(erro.status)) {
          log.error('claude.erro_fatal', { modelo: p.modelo, status: erro.status, erro: erro.message });
          throw new ErroModeloFatal(`API do Claude recusou o pedido (HTTP ${erro.status}): ${erro.message}`);
        }
        log.warn('claude.erro', { modelo: p.modelo, ms: Date.now() - inicio, erro: (erro as Error).message });
        throw erro;
      }

      const u = resposta.usage;
      const tokensEntrada = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      log.info('claude.resposta', {
        modelo: resposta.model, ms: Date.now() - inicio, motivo: resposta.stop_reason,
        tokensEntrada, tokensSaida: u.output_tokens,
      });

      if (resposta.stop_reason === 'refusal') {
        const d = resposta.stop_details;
        throw new Error(`o modelo recusou a tarefa${d?.category ? ` (categoria: ${d.category})` : ''}`);
      }
      if (resposta.stop_reason === 'max_tokens') {
        throw new Error('resposta cortada pelo limite de tokens');
      }
      const texto = resposta.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return { texto, tokensEntrada, tokensSaida: u.output_tokens };
    },
  };
}

/**
 * Preços por milhão de tokens (US$) lidos do ambiente, para registrar o custo de cada execução:
 *   MODELO_IA_PEQUENO_PRECO="entrada,saida"   (ex.: "1.00,5.00")
 *   MODELO_IA_FORTE_PRECO="entrada,saida"
 * Sem preço configurado, o custo fica vazio (tokens continuam registrados).
 */
export function precosDoAmbiente(ambiente: Record<string, string | undefined> = process.env): Record<string, PrecoModelo> {
  const precos: Record<string, PrecoModelo> = {};
  for (const porte of ['PEQUENO', 'FORTE']) {
    const modelo = ambiente[`MODELO_IA_${porte}`];
    const texto = ambiente[`MODELO_IA_${porte}_PRECO`];
    if (!modelo || !texto) continue;
    const [entrada, saida] = texto.split(',').map((x) => Number(x.trim()));
    if (!(entrada! >= 0) || !(saida! >= 0)) throw new Error(`MODELO_IA_${porte}_PRECO inválido: "${texto}" (use "entrada,saida")`);
    precos[modelo] = { entradaPorMilhao: entrada!, saidaPorMilhao: saida! };
  }
  return precos;
}
