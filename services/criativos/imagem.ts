/**
 * Foto do produto para os criativos. O painel desenha no navegador (canvas), que não pode usar imagem
 * de outro site; por isso a foto passa pelo painel: só de domínios de imagem das plataformas, só imagem,
 * até 8 MB, com tempo limite, novas tentativas e log.
 */
import { comRetentativa, ErroHttp, ErroTimeout, erroTransitorio } from '../../harness/retentativa.ts';
import { log } from '../../harness/log.ts';

const HOSTS = [
  /(^|\.)susercontent\.com$/i, /^cf\.shopee\.com\.br$/i, /(^|\.)img\.shopee\.com\.br$/i,
  // Amazon fica de fora: as Políticas do Programa de Associados não permitem guardar as imagens da loja.
  /(^|\.)mlstatic\.com$/i,
];
const LIMITE = 8 * 1024 * 1024;
const TEMPO_MS = 15_000;

export function imagemPermitida(endereco: string): URL | null {
  let u: URL;
  try { u = new URL(endereco); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  return HOSTS.some((h) => h.test(u.hostname)) ? u : null;
}

export interface Imagem { tipo: string; dados: Buffer }

export async function buscarImagem(endereco: string, buscar: typeof fetch = fetch): Promise<Imagem> {
  const u = imagemPermitida(endereco);
  if (!u) throw new Error('Endereço de imagem não permitido (só fotos da Shopee ou do Mercado Livre).');
  return comRetentativa(async () => {
    let resp: Response;
    try {
      resp = await buscar(u, { signal: AbortSignal.timeout(TEMPO_MS), redirect: 'error' });
    } catch (e) {
      if ((e as Error).name === 'TimeoutError') throw new ErroTimeout(TEMPO_MS);
      throw e;
    }
    if (!resp.ok) throw new ErroHttp(resp.status, '');
    const tipo = (resp.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!/^image\/(jpeg|png|webp|gif|avif)$/.test(tipo)) throw new Error(`Não é uma imagem (${tipo || 'sem tipo'}).`);
    const dados = Buffer.from(await resp.arrayBuffer());
    if (dados.length > LIMITE) throw new Error('Imagem grande demais.');
    log.info('criativo.imagem', { host: u.hostname, bytes: dados.length });
    return { tipo, dados };
  }, { operacao: 'criativo.imagem', deveTentarDeNovo: erroTransitorio });
}
