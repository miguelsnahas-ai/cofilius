/**
 * Receptor dos avisos do WhatsApp (webhook): mensagens do afiliado e avisos de entrega/leitura.
 *
 *   npm run webhook      → escuta em WEBHOOK_PORTA (padrão 8787)
 *
 * Precisa estar acessível pela internet com HTTPS (a Meta chama este endereço). Em produção, rode atrás
 * de um proxy com HTTPS ou mova o tratador para uma Edge Function do Supabase.
 * Segurança: só aceita avisos com assinatura válida (segredo do app). Responde 200 rápido e trata cada item.
 */
import 'dotenv/config';
import { executadoDiretamente } from './execucao.ts';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { conectar, type Sql } from './db.ts';
import { log } from './log.ts';
import { criarModeloClaude, precosDoAmbiente } from './modeloClaude.ts';
import type { ModeloIA, PrecoModelo } from './agentes.ts';
import { assinaturaValida, configWhatsappDoAmbiente, lerAviso, verificarWebhook, type ConfigWhatsapp } from '../services/disparador/whatsapp.ts';
import { canalWhatsapp, registrarStatus, type Canal } from '../services/disparador/disparador.ts';
import { clientePorWhatsapp, receberMensagem } from '../services/atendimento/entrada.ts';

export interface DepsWebhook {
  sql: Sql;
  cfg: ConfigWhatsapp;
  canal?: Canal;
  modelo?: () => ModeloIA;
  precos?: Record<string, PrecoModelo>;
}

/** Trata o corpo de um aviso já autenticado. Devolve o que foi feito (para log e testes). */
export async function tratarAviso(deps: DepsWebhook, corpo: unknown): Promise<{ mensagens: string[]; status: number }> {
  const { mensagens, status } = lerAviso(corpo);
  const canal = deps.canal ?? canalWhatsapp(deps.cfg);
  const feitos: string[] = [];
  for (const m of mensagens) {
    const cliente = await clientePorWhatsapp(deps.sql, m.de);
    if (!cliente) {
      log.warn('webhook.numero_desconhecido', { de: `${m.de.slice(0, 4)}…` });
      feitos.push('numero_desconhecido');
      continue;
    }
    try {
      const r = await receberMensagem({ sql: deps.sql, canal, modelo: deps.modelo, precos: deps.precos },
        { cliente, texto: m.texto, idExterno: m.id, em: m.em, canalEntrada: 'whatsapp' });
      feitos.push(r.tipo === 'atendimento' ? `atendimento:${r.resultado.intencao}` : r.tipo);
    } catch (erro) {
      log.error('webhook.falha_mensagem', { cliente: cliente.codigo, erro: (erro as Error).message });
      feitos.push('erro');
    }
  }
  return { mensagens: feitos, status: await registrarStatus(deps.sql, status) };
}

export function criarServidorWebhook(deps: DepsWebhook): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://webhook');
    if (req.method === 'GET') {
      const desafio = verificarWebhook(deps.cfg, url.searchParams);
      res.writeHead(desafio ? 200 : 403, { 'Content-Type': 'text/plain' });
      res.end(desafio ?? 'recusado');
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const partes: Buffer[] = [];
    let total = 0;
    for await (const p of req) {
      total += (p as Buffer).length;
      if (total > 1_000_000) { res.writeHead(413); res.end(); return; }
      partes.push(p as Buffer);
    }
    const bruto = Buffer.concat(partes).toString('utf8');
    if (!assinaturaValida(deps.cfg, bruto, req.headers['x-hub-signature-256'] as string | undefined)) {
      log.warn('webhook.assinatura_invalida');
      res.writeHead(401); res.end(); return;
    }
    let corpo: unknown;
    try { corpo = JSON.parse(bruto); } catch { res.writeHead(400); res.end(); return; }
    try {
      const r = await tratarAviso(deps, corpo);
      log.info('webhook.aviso', r);
    } catch (erro) {
      log.error('webhook.falha', { erro: (erro as Error).message });
    }
    // 200 mesmo com falha interna: o pedido já ficou registrado ou no log; reenvio só duplicaria.
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
}

if (executadoDiretamente(import.meta.url)) {
  const cfg = configWhatsappDoAmbiente();
  if (!cfg || !cfg.segredoApp || !cfg.tokenVerificacao) {
    console.error('Configure WHATSAPP_TOKEN, WHATSAPP_NUMERO_ID, WHATSAPP_VERSAO_API, WHATSAPP_SEGREDO_APP e WHATSAPP_TOKEN_VERIFICACAO no .env.');
    process.exit(1);
  }
  const temIa = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const servidor = criarServidorWebhook({
    sql: conectar(), cfg, modelo: temIa ? () => criarModeloClaude() : undefined, precos: precosDoAmbiente(),
  });
  const porta = Number(process.env.WEBHOOK_PORTA || 8787);
  servidor.listen(porta, () => console.log(`Webhook do WhatsApp na porta ${porta} (IA ${temIa ? 'ligada' : 'desligada'})`));
}
