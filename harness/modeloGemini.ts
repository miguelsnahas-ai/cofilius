/**
 * Cliente da API do Gemini (Google) para o harness dos agentes (implementa ModeloIA).
 *
 * - SDK oficial (@google/genai): timeout por chamada e até 3 novas tentativas com espera crescente
 *   em erros transitórios (408, 429 = limite do nível gratuito, 5xx).
 * - Saída estruturada: `responseMimeType: application/json` + `responseJsonSchema` com o esquema do agente.
 *   O Gemini aceita só parte do JSON Schema: o que ele não aceita (ex.: tamanho de texto) é retirado do
 *   esquema enviado; o harness confere tudo de novo com o esquema completo.
 * - Bloqueio por segurança ou resposta cortada viram erro, nunca texto.
 * - Erros que não se resolvem repetindo (chave inválida, modelo inexistente) são fatais para o harness.
 * - Nível gratuito: o Google pode usar o conteúdo enviado para melhorar os produtos dele.
 */
import { ApiError, GoogleGenAI } from '@google/genai';
import { log } from './log.ts';
import { ErroModeloFatal } from './modeloClaude.ts';
import type { ModeloIA, PedidoModelo, RespostaModelo } from './agentes.ts';

export interface OpcoesModeloGemini {
  /** Cliente do SDK (substituível nos testes). Padrão: GoogleGenAI com GEMINI_API_KEY. */
  cliente?: Pick<GoogleGenAI, 'models'>;
  apiKey?: string;
  /** Teto de tokens da resposta (inclui o raciocínio do modelo). Padrão: 8000. */
  maxTokens?: number;
  /** Timeout por chamada, em ms. Padrão: 60 s. */
  timeoutMs?: number;
}

const STATUS_FATAIS = new Set([400, 401, 403, 404]);

/** Palavras do JSON Schema que o Gemini aceita em responseJsonSchema (documentação do SDK @google/genai). */
const ACEITAS = new Set([
  '$id', '$defs', '$ref', '$anchor', 'type', 'format', 'title', 'description', 'enum', 'items', 'prefixItems',
  'minItems', 'maxItems', 'minimum', 'maximum', 'anyOf', 'oneOf', 'properties', 'additionalProperties', 'required',
]);

/** Copia o esquema só com as palavras aceitas (o original, usado pelo harness, não muda). */
export function esquemaParaGemini(esquema: unknown): unknown {
  if (Array.isArray(esquema)) return esquema.map(esquemaParaGemini);
  if (esquema === null || typeof esquema !== 'object') return esquema;
  const saida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(esquema)) {
    if (!ACEITAS.has(k)) continue;
    // Em "properties" e "$defs" as chaves são nomes de campo, não palavras do esquema.
    saida[k] = k === 'properties' || k === '$defs'
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([nome, sub]) => [nome, esquemaParaGemini(sub)]))
      : esquemaParaGemini(v);
  }
  return saida;
}

export function criarModeloGemini(opcoes: OpcoesModeloGemini = {}): ModeloIA {
  const timeoutMs = opcoes.timeoutMs ?? 60_000;
  const apiKey = opcoes.apiKey ?? process.env.GEMINI_API_KEY;
  if (!opcoes.cliente && !apiKey) {
    throw new ErroModeloFatal('configuração do Gemini: falta a chave da API (coloque na aba Configuração)');
  }
  const cliente = opcoes.cliente ?? new GoogleGenAI({
    apiKey,
    httpOptions: { timeout: timeoutMs, retryOptions: { attempts: 4, initialDelay: 2, maxDelay: 30 } },
  });

  return {
    async gerar(p: PedidoModelo): Promise<RespostaModelo> {
      if (p.ferramentas.length) {
        throw new ErroModeloFatal(`ferramentas ainda não implementadas no cliente: ${p.ferramentas.join(', ')}`);
      }
      const conteudo = p.correcao ? `${p.entrada}\n\n${p.correcao}` : p.entrada;
      const inicio = Date.now();
      let resposta: Awaited<ReturnType<GoogleGenAI['models']['generateContent']>>;
      try {
        resposta = await cliente.models.generateContent({
          model: p.modelo,
          contents: [{ role: 'user', parts: [{ text: conteudo }] }],
          config: {
            systemInstruction: p.sistema,
            responseMimeType: 'application/json',
            responseJsonSchema: esquemaParaGemini(p.esquemaSaida),
            maxOutputTokens: opcoes.maxTokens ?? 8000,
          },
        });
      } catch (erro) {
        if (erro instanceof ApiError) {
          if (STATUS_FATAIS.has(erro.status)) {
            log.error('gemini.erro_fatal', { modelo: p.modelo, status: erro.status, erro: erro.message.slice(0, 300) });
            throw new ErroModeloFatal(`API do Gemini recusou o pedido (HTTP ${erro.status}): ${erro.message.slice(0, 300)}`);
          }
          if (erro.status === 429) {
            log.warn('gemini.limite', { modelo: p.modelo });
            throw new Error('limite do nível gratuito do Gemini atingido (muitas chamadas por minuto ou por dia); tente mais tarde');
          }
          log.warn('gemini.erro', { modelo: p.modelo, status: erro.status, ms: Date.now() - inicio });
          throw erro;
        }
        // Erro antes de a chamada sair (configuração) ou de rede: rede o SDK já repetiu.
        log.warn('gemini.erro', { modelo: p.modelo, erro: (erro as Error).message, ms: Date.now() - inicio });
        throw erro;
      }

      const u = resposta.usageMetadata ?? {};
      const tokensEntrada = u.promptTokenCount ?? 0;
      const tokensSaida = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
      const motivo = resposta.candidates?.[0]?.finishReason;
      log.info('gemini.resposta', { modelo: p.modelo, ms: Date.now() - inicio, motivo, tokensEntrada, tokensSaida });

      if (resposta.promptFeedback?.blockReason) {
        throw new Error(`o Gemini bloqueou o pedido (${resposta.promptFeedback.blockReason})`);
      }
      if (motivo === 'MAX_TOKENS') throw new Error('resposta cortada pelo limite de tokens');
      if (motivo && motivo !== 'STOP') throw new Error(`o Gemini interrompeu a resposta (${motivo})`);
      const texto = resposta.text ?? '';
      if (!texto) throw new Error('o Gemini respondeu vazio');
      return { texto, tokensEntrada, tokensSaida };
    },
  };
}
