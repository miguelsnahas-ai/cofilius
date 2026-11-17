/**
 * Harness dos agentes (docs/arquitetura.md, "Contrato de cada agente").
 *
 * Todo agente é uma pasta em agents/<nome>/ com:
 *   1. prompt.md            o prompt, versionado (a versão é o hash do texto: mudou o texto, mudou a versão);
 *   2. esquema.json         esquema JSON da entrada e da saída;
 *   3. contrato.json        modelo e lista de ferramentas que ele pode usar;
 *   4. casos/*.json         15 a 20 entradas reais com o que se espera da saída.
 *
 * Regras que este módulo garante:
 *   - Entrada que não bate com o esquema não chega ao modelo (é erro do código).
 *   - Saída que não é JSON, não bate com o esquema ou quebra uma regra do agente é descartada,
 *     e o passo roda de novo, no máximo 2 vezes. Depois disso, erro.
 *   - Cada tentativa é gravada em `execucoes_agente`: entrada, saída, versão do prompt, modelo,
 *     duração, tokens e custo.
 *   - O agente só recebe as ferramentas da lista dele.
 *
 * O modelo é uma interface (ModeloIA): os testes usam um modelo falso; o cliente da API do Claude
 * entra depois, sem mudar nada aqui.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import AjvModulo from 'ajv';
import type { Sql } from './db.ts';
import { sha256Hex } from './cripto.ts';
import { log } from './log.ts';
import { MODELOS_PADRAO, PRECOS_PADRAO, provedorAtual } from './modelosPadrao.ts';

// ajv é publicado como CommonJS; em ESM o construtor pode vir em .default
const Ajv = ((AjvModulo as unknown as { default?: typeof AjvModulo }).default ?? AjvModulo) as unknown as new (o?: object) => {
  compile: (s: object) => ((d: unknown) => boolean) & { errors?: { instancePath: string; message?: string }[] | null };
};
const ajv = new Ajv({ allErrors: true, strict: false });

export type NomeAgente = 'curador' | 'redator' | 'analista' | 'atendente';
export const MAX_REPETICOES = 2;

export interface ContratoAgente<E = unknown, S = unknown> {
  nome: NomeAgente;
  prompt: string;
  /** Calculada do texto do prompt se omitida. */
  versaoPrompt?: string;
  modelo: string;
  ferramentas: string[];
  esquemaEntrada: object;
  esquemaSaida: object;
  /** Regras além do esquema (ex.: o Curador só devolve IDs que estavam na entrada). Lista vazia = ok. */
  regrasSaida?: (entrada: E, saida: S) => string[];
}

export interface PedidoModelo {
  modelo: string;
  sistema: string;
  /** Entrada do agente, em JSON. */
  entrada: string;
  esquemaSaida: object;
  ferramentas: string[];
  /** Na repetição, o motivo da recusa anterior (para o modelo corrigir). */
  correcao?: string;
}

export interface RespostaModelo {
  texto: string;
  tokensEntrada: number;
  tokensSaida: number;
}

export interface ModeloIA {
  gerar(p: PedidoModelo): Promise<RespostaModelo>;
}

/** Preço por milhão de tokens, em dólares. Vem de configuração; o código não presume preço de modelo. */
export interface PrecoModelo {
  entradaPorMilhao: number;
  saidaPorMilhao: number;
}

export class ErroAgente extends Error {
  constructor(readonly agente: string, mensagem: string, readonly tentativas: number) {
    super(`Agente ${agente}: ${mensagem}`);
    this.name = 'ErroAgente';
  }
}

export async function versaoDoPrompt(c: Pick<ContratoAgente, 'nome' | 'prompt' | 'versaoPrompt'>): Promise<string> {
  return c.versaoPrompt ?? `${c.nome}@${(await sha256Hex(c.prompt)).slice(0, 12)}`;
}

function erros(validar: ReturnType<typeof ajv.compile>): string {
  return (validar.errors ?? []).map((e) => `${e.instancePath || '(raiz)'} ${e.message ?? ''}`.trim()).join('; ');
}

/** Tira cercas de código (```json ... ```) e lê o JSON. */
export function lerJsonDoModelo(texto: string): unknown {
  const limpo = texto.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(limpo);
}

export interface Execucao<S> {
  saida: S;
  tentativas: number;
  versaoPrompt: string;
}

export async function executarAgente<E, S>(
  sql: Sql,
  p: {
    contrato: ContratoAgente<E, S>;
    clienteId: string;
    entrada: E;
    modelo: ModeloIA;
    tarefaId?: string;
    precos?: Record<string, PrecoModelo>;
  },
): Promise<Execucao<S>> {
  const { contrato: c } = p;
  const versao = await versaoDoPrompt(c);
  const validarEntrada = ajv.compile(c.esquemaEntrada);
  if (!validarEntrada(p.entrada)) {
    throw new ErroAgente(c.nome, `entrada fora do esquema (erro no código que chamou): ${erros(validarEntrada)}`, 0);
  }
  const validarSaida = ajv.compile(c.esquemaSaida);
  const preco = p.precos?.[c.modelo];
  let correcao: string | undefined;
  let ultimoProblema = '';

  for (let tentativa = 1; tentativa <= 1 + MAX_REPETICOES; tentativa++) {
    const inicio = Date.now();
    let resposta: RespostaModelo | null = null;
    let saida: unknown = null;
    let problema: string | null = null;
    let fatal = false;
    try {
      resposta = await p.modelo.gerar({
        modelo: c.modelo, sistema: c.prompt, entrada: JSON.stringify(p.entrada), esquemaSaida: c.esquemaSaida,
        ferramentas: [...c.ferramentas], correcao,
      });
      try {
        saida = lerJsonDoModelo(resposta.texto);
      } catch {
        problema = 'a resposta não é JSON';
      }
      if (!problema && !validarSaida(saida)) problema = `saída fora do esquema: ${erros(validarSaida)}`;
      if (!problema && c.regrasSaida) {
        const quebradas = c.regrasSaida(p.entrada, saida as S);
        if (quebradas.length) problema = `regras do agente: ${quebradas.join('; ')}`;
      }
    } catch (erro) {
      problema = `falha ao chamar o modelo: ${(erro as Error).message}`;
      // Erro marcado como fatal (ex.: chave inválida) não melhora repetindo.
      fatal = (erro as { fatal?: boolean }).fatal === true;
    }
    const duracao = Date.now() - inicio;
    const custo = resposta && preco
      ? (resposta.tokensEntrada * preco.entradaPorMilhao + resposta.tokensSaida * preco.saidaPorMilhao) / 1_000_000
      : null;

    await sql`
      insert into execucoes_agente (cliente_id, agente, versao_prompt, modelo, tarefa_id, entrada, saida, saida_valida, erro,
                                    duracao_ms, tokens_entrada, tokens_saida, custo_usd)
      values (${p.clienteId}, ${c.nome}, ${versao}, ${c.modelo}, ${p.tarefaId ?? null}, ${sql.json(p.entrada as never)},
              ${saida === null ? (resposta ? sql.json({ texto_bruto: resposta.texto } as never) : null) : sql.json(saida as never)},
              ${problema === null}, ${problema}, ${duracao}, ${resposta?.tokensEntrada ?? null}, ${resposta?.tokensSaida ?? null},
              ${custo === null ? null : custo.toFixed(6)})`;

    if (problema === null) {
      log.info('agente.ok', { agente: c.nome, versao, tentativa, ms: duracao });
      return { saida: saida as S, tentativas: tentativa, versaoPrompt: versao };
    }
    if (fatal) throw new ErroAgente(c.nome, problema!, tentativa);
    ultimoProblema = problema!;
    log.warn('agente.saida_recusada', { agente: c.nome, versao, tentativa, problema });
    correcao = `Sua resposta anterior foi recusada: ${problema}. Responda de novo, só com o JSON pedido.`;
  }
  throw new ErroAgente(c.nome, `saída recusada ${1 + MAX_REPETICOES} vezes; último motivo: ${ultimoProblema}`, 1 + MAX_REPETICOES);
}

// ---------------------------------------------------------------------------
// Contratos em disco e casos de teste
// ---------------------------------------------------------------------------

export interface CasoTeste {
  nome: string;
  entrada: unknown;
  /** A saída precisa conter estes campos com estes valores (comparação parcial). */
  espera?: unknown;
}

/** Modelo padrão do Claude (mantido para quem usa o provedor Claude). */
export const MODELO_PADRAO = MODELOS_PADRAO.claude.pequeno;
export const PRECO_MODELO_PADRAO: PrecoModelo = PRECOS_PADRAO[MODELO_PADRAO]!;

/**
 * O contrato diz só o porte do modelo ("pequeno" ou "forte"). O identificador vem do ambiente
 * (MODELO_IA_PEQUENO, MODELO_IA_FORTE) e, sem configuração, é o padrão do provedor (IA_PROVEDOR; padrão: Gemini).
 */
export function resolverModelo(porte: string, ambiente: Record<string, string | undefined> = process.env): string {
  const variavel = porte === 'pequeno' ? 'MODELO_IA_PEQUENO' : porte === 'forte' ? 'MODELO_IA_FORTE' : null;
  if (!variavel) return porte;
  return ambiente[variavel]?.trim() || MODELOS_PADRAO[provedorAtual(ambiente)][porte as 'pequeno' | 'forte'];
}

/** Contrato pronto para executar: lido da pasta, com o modelo resolvido pelo ambiente e as regras do agente. */
export async function carregarContrato<E, S>(
  pasta: string,
  regrasSaida: (entrada: E, saida: S) => string[],
  ambiente: Record<string, string | undefined> = process.env,
): Promise<ContratoAgente<E, S>> {
  const { contrato } = await carregarAgente(pasta);
  return { ...contrato, modelo: resolverModelo(contrato.modelo, ambiente), regrasSaida };
}

/** Lê agents/<nome>/ (prompt.md, esquema.json, contrato.json, casos/*.json). O modelo fica como o porte. */
export async function carregarAgente(pasta: string): Promise<{ contrato: Omit<ContratoAgente, 'regrasSaida'>; casos: CasoTeste[] }> {
  const json = async (arquivo: string) => JSON.parse(await readFile(join(pasta, arquivo), 'utf8'));
  const contrato = await json('contrato.json');
  const esquema = await json('esquema.json');
  const prompt = await readFile(join(pasta, 'prompt.md'), 'utf8');
  let casos: CasoTeste[] = [];
  try {
    const arquivos = (await readdir(join(pasta, 'casos'))).filter((f) => f.endsWith('.json')).sort();
    casos = await Promise.all(arquivos.map(async (f) => ({ nome: f, ...(await json(join('casos', f))) })));
  } catch {
    casos = [];
  }
  return {
    contrato: { nome: contrato.nome, modelo: contrato.modelo, ferramentas: contrato.ferramentas ?? [], prompt,
      esquemaEntrada: esquema.entrada, esquemaSaida: esquema.saida },
    casos,
  };
}

/** a contém b? (objetos: campos de b presentes em a com o mesmo valor; listas: mesmo tamanho e itens contidos) */
export function contem(a: unknown, b: unknown): boolean {
  if (b === null || typeof b !== 'object') return a === b;
  if (Array.isArray(b)) return Array.isArray(a) && a.length === b.length && b.every((x, i) => contem(a[i], x));
  if (a === null || typeof a !== 'object') return false;
  return Object.entries(b).every(([k, v]) => contem((a as Record<string, unknown>)[k], v));
}

export interface ResultadoCaso {
  caso: string;
  ok: boolean;
  detalhe: string;
}

/**
 * Roda os casos de teste de um agente (a cada mudança de prompt).
 * Cada caso passa pelo mesmo caminho da produção (esquema, regras, repetições, registro).
 */
export async function rodarCasos<E, S>(
  sql: Sql,
  p: { contrato: ContratoAgente<E, S>; casos: CasoTeste[]; modelo: ModeloIA; clienteId: string; precos?: Record<string, PrecoModelo> },
): Promise<ResultadoCaso[]> {
  const saida: ResultadoCaso[] = [];
  for (const caso of p.casos) {
    try {
      const r = await executarAgente(sql, { contrato: p.contrato, clienteId: p.clienteId, entrada: caso.entrada as E, modelo: p.modelo, precos: p.precos });
      const ok = caso.espera === undefined || contem(r.saida, caso.espera);
      saida.push({ caso: caso.nome, ok, detalhe: ok ? `ok em ${r.tentativas} tentativa(s)` : `saída diferente do esperado: ${JSON.stringify(r.saida)}` });
    } catch (erro) {
      saida.push({ caso: caso.nome, ok: false, detalhe: (erro as Error).message });
    }
  }
  return saida;
}
