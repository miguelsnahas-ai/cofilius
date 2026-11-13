/**
 * Cliente da WhatsApp Cloud API (Meta). TUDO o que depende do formato da Meta está neste arquivo.
 *
 * Nenhum formato abaixo foi conferido na documentação oficial nesta etapa. Cada suposição está marcada
 * com TODO(whatsapp-doc). Confira em developers.facebook.com/docs/whatsapp/cloud-api antes de ligar.
 *
 * Toda chamada tem timeout, até 3 novas tentativas com espera crescente e log (harness/retentativa.ts).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { log } from '../../harness/log.ts';
import { comRetentativa, erroTransitorio, ErroHttp, postComTimeout } from '../../harness/retentativa.ts';

export interface ConfigWhatsapp {
  /** Token de acesso do app (usuário do sistema). */
  token: string;
  /** ID do número de telefone do serviço na Cloud API (não é o número em si). */
  numeroId: string;
  /** Versão da Graph API. TODO(whatsapp-doc): conferir a versão atual. */
  versao: string;
  /** Segredo do app, para conferir a assinatura dos avisos recebidos. */
  segredoApp: string;
  /** Texto que você define no painel da Meta para validar o endereço do webhook. */
  tokenVerificacao: string;
  fetch?: typeof fetch;
  esperar?: (ms: number) => Promise<void>;
}

/** Erro da Meta que não melhora repetindo (ex.: fora da janela de 24 horas). */
export class ErroWhatsapp extends Error {
  constructor(readonly codigo: number | null, mensagem: string) {
    super(`WhatsApp${codigo !== null ? ` [${codigo}]` : ''}: ${mensagem}`);
    this.name = 'ErroWhatsapp';
  }
}

/**
 * TODO(whatsapp-doc): conferir o código de erro de mensagem fora da janela de 24 horas.
 * Suposição: 131047 ("re-engagement message"). Fora da janela só valem modelos aprovados.
 */
export const ERRO_FORA_DA_JANELA = 131047;

/**
 * Envia texto livre (só vale dentro da janela de 24 horas aberta pela última mensagem do afiliado).
 * TODO(whatsapp-doc): conferir endpoint POST https://graph.facebook.com/{versao}/{numeroId}/messages,
 * cabeçalho "Authorization: Bearer {token}" e corpo
 *   {"messaging_product":"whatsapp","to":"55...","type":"text","text":{"preview_url":true,"body":"..."}}
 * e a resposta {"messages":[{"id":"wamid..."}]}.
 */
export async function enviarTextoWhatsapp(cfg: ConfigWhatsapp, para: string, texto: string): Promise<string> {
  const url = `https://graph.facebook.com/${cfg.versao}/${cfg.numeroId}/messages`;
  const corpo = JSON.stringify({ messaging_product: 'whatsapp', to: para, type: 'text', text: { preview_url: true, body: texto } });
  const resposta = await comRetentativa(
    async () => {
      try {
        return await postComTimeout(url, corpo, { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` }, { fetch: cfg.fetch, timeoutMs: 15_000 });
      } catch (erro) {
        if (erro instanceof ErroHttp && erro.status < 500 && erro.status !== 429) {
          let codigo: number | null = null;
          let msg = erro.corpo.slice(0, 300);
          try {
            const j = JSON.parse(erro.corpo) as { error?: { code?: number; message?: string } };
            codigo = j.error?.code ?? null;
            msg = j.error?.message ?? msg;
          } catch { /* corpo não é JSON */ }
          throw new ErroWhatsapp(codigo, msg);
        }
        throw erro;
      }
    },
    { operacao: 'whatsapp.enviar', deveTentarDeNovo: erroTransitorio, esperar: cfg.esperar },
  );
  const id = (JSON.parse(resposta) as { messages?: { id?: string }[] }).messages?.[0]?.id;
  if (!id) throw new ErroWhatsapp(null, `resposta sem id de mensagem: ${resposta.slice(0, 200)}`);
  log.info('whatsapp.enviada', { para: `${para.slice(0, 4)}…`, id });
  return id;
}

/**
 * Verificação do webhook (GET). TODO(whatsapp-doc): conferir os parâmetros hub.mode=subscribe,
 * hub.verify_token e hub.challenge (responder o challenge em texto puro).
 */
export function verificarWebhook(cfg: Pick<ConfigWhatsapp, 'tokenVerificacao'>, params: URLSearchParams): string | null {
  if (params.get('hub.mode') === 'subscribe' && params.get('hub.verify_token') === cfg.tokenVerificacao && cfg.tokenVerificacao) {
    return params.get('hub.challenge');
  }
  return null;
}

/**
 * Assinatura dos avisos (POST). TODO(whatsapp-doc): conferir o cabeçalho X-Hub-Signature-256 com
 * "sha256=" + HMAC-SHA256 do corpo bruto, usando o segredo do app.
 */
export function assinaturaValida(cfg: Pick<ConfigWhatsapp, 'segredoApp'>, corpoBruto: string, cabecalho: string | undefined): boolean {
  if (!cabecalho?.startsWith('sha256=') || !cfg.segredoApp) return false;
  const esperado = createHmac('sha256', cfg.segredoApp).update(corpoBruto, 'utf8').digest('hex');
  const a = Buffer.from(cabecalho.slice(7));
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface MensagemRecebida {
  id: string;
  de: string;
  texto: string;
  em: Date;
}

export interface StatusRecebido {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed' | string;
  em: Date;
}

/**
 * Lê o corpo do aviso. TODO(whatsapp-doc): conferir o formato
 *   {"entry":[{"changes":[{"value":{
 *      "messages":[{"from":"55...","id":"wamid...","timestamp":"1700000000","type":"text","text":{"body":"..."}}],
 *      "statuses":[{"id":"wamid...","status":"delivered","timestamp":"1700000000"}]}}]}]}
 * Respostas de botão: suposição de que chegam como type "button" (button.text) ou "interactive"
 * (interactive.button_reply.title).
 */
export function lerAviso(corpo: unknown): { mensagens: MensagemRecebida[]; status: StatusRecebido[] } {
  const mensagens: MensagemRecebida[] = [];
  const status: StatusRecebido[] = [];
  const quando = (ts: unknown) => new Date(Number(ts) * 1000 || Date.now());
  const entradas = (corpo as { entry?: unknown[] })?.entry ?? [];
  for (const e of Array.isArray(entradas) ? entradas : []) {
    for (const c of ((e as { changes?: unknown[] }).changes ?? [])) {
      const v = (c as { value?: Record<string, unknown> }).value ?? {};
      for (const m of (Array.isArray(v.messages) ? v.messages : []) as Record<string, any>[]) {
        const texto = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title;
        if (typeof m.id === 'string' && typeof m.from === 'string' && typeof texto === 'string') {
          mensagens.push({ id: m.id, de: m.from, texto, em: quando(m.timestamp) });
        }
      }
      for (const s of (Array.isArray(v.statuses) ? v.statuses : []) as Record<string, any>[]) {
        if (typeof s.id === 'string' && typeof s.status === 'string') status.push({ id: s.id, status: s.status, em: quando(s.timestamp) });
      }
    }
  }
  return { mensagens, status };
}

/** Configuração a partir do .env; null se o WhatsApp não estiver configurado. */
export function configWhatsappDoAmbiente(ambiente: Record<string, string | undefined> = process.env): ConfigWhatsapp | null {
  const token = ambiente.WHATSAPP_TOKEN;
  const numeroId = ambiente.WHATSAPP_NUMERO_ID;
  const versao = ambiente.WHATSAPP_VERSAO_API;
  if (!token || !numeroId || !versao) return null;
  return {
    token, numeroId, versao,
    segredoApp: ambiente.WHATSAPP_SEGREDO_APP ?? '',
    tokenVerificacao: ambiente.WHATSAPP_TOKEN_VERIFICACAO ?? '',
  };
}
