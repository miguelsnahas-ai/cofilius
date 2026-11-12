import { log } from './log.ts';

/**
 * Regras do projeto para toda chamada externa:
 * - timeout por tentativa;
 * - até 3 novas tentativas, com espera crescente (500 ms, 1 s, 2 s, mais um pouco de aleatoriedade);
 * - log de cada tentativa, falha e desistência.
 */

export interface OpcoesRetentativa {
  /** Nome curto da operação, aparece no log. */
  operacao: string;
  /** Novas tentativas depois da primeira. Padrão: 3. */
  novasTentativas?: number;
  /** Espera antes da 1ª nova tentativa, em ms. Dobra a cada vez. Padrão: 500. */
  esperaInicialMs?: number;
  /** Decide se o erro vale nova tentativa. Padrão: sempre. */
  deveTentarDeNovo?: (erro: unknown) => boolean;
  /** Substituível nos testes. */
  esperar?: (ms: number) => Promise<void>;
}

export const esperarPadrao = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function comRetentativa<T>(
  fn: (tentativa: number) => Promise<T>,
  opcoes: OpcoesRetentativa,
): Promise<T> {
  const novas = opcoes.novasTentativas ?? 3;
  const esperaInicial = opcoes.esperaInicialMs ?? 500;
  const esperar = opcoes.esperar ?? esperarPadrao;
  const deveTentar = opcoes.deveTentarDeNovo ?? (() => true);

  for (let tentativa = 1; ; tentativa++) {
    const inicio = Date.now();
    try {
      const resultado = await fn(tentativa);
      log.debug('chamada.ok', { operacao: opcoes.operacao, tentativa, ms: Date.now() - inicio });
      return resultado;
    } catch (erro) {
      const msg = erro instanceof Error ? erro.message : String(erro);
      const podeRepetir = tentativa <= novas && deveTentar(erro);
      if (!podeRepetir) {
        log.error('chamada.falhou', { operacao: opcoes.operacao, tentativa, ms: Date.now() - inicio, erro: msg });
        throw erro;
      }
      const espera = esperaInicial * 2 ** (tentativa - 1) + Math.floor(Math.random() * 100);
      log.warn('chamada.nova_tentativa', { operacao: opcoes.operacao, tentativa, erro: msg, esperaMs: espera });
      await esperar(espera);
    }
  }
}

/** Erro HTTP com status, para decidir se vale nova tentativa. */
export class ErroHttp extends Error {
  constructor(
    readonly status: number,
    readonly corpo: string,
  ) {
    super(`HTTP ${status}: ${corpo.slice(0, 300)}`);
    this.name = 'ErroHttp';
  }
}

export class ErroTimeout extends Error {
  constructor(readonly ms: number) {
    super(`timeout depois de ${ms} ms`);
    this.name = 'ErroTimeout';
  }
}

/** Erros de rede, timeout, 429 e 5xx valem nova tentativa. 4xx não. */
export function erroTransitorio(erro: unknown): boolean {
  if (erro instanceof ErroTimeout) return true;
  if (erro instanceof ErroHttp) return erro.status === 429 || erro.status >= 500;
  if (erro instanceof TypeError) return true; // fetch lança TypeError em falha de rede
  return false;
}

export interface OpcoesPost {
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Um POST com timeout. Não faz nova tentativa sozinho: quem chama embrulha em comRetentativa,
 * porque às vezes é preciso refazer algo a cada tentativa (ex.: a assinatura da Shopee usa o horário).
 */
export async function postComTimeout(
  url: string,
  corpo: string,
  headers: Record<string, string>,
  opcoes: OpcoesPost = {},
): Promise<string> {
  const timeoutMs = opcoes.timeoutMs ?? 15_000;
  const f = opcoes.fetch ?? fetch;
  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), timeoutMs);
  try {
    const resp = await f(url, { method: 'POST', body: corpo, headers, signal: controle.signal });
    const texto = await resp.text();
    if (!resp.ok) throw new ErroHttp(resp.status, texto);
    return texto;
  } catch (erro) {
    if (controle.signal.aborted) throw new ErroTimeout(timeoutMs);
    throw erro;
  } finally {
    clearTimeout(timer);
  }
}
