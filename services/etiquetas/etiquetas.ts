/**
 * Padrão de etiquetas de rastreio (docs/arquitetura.md, "Chave de rastreio por plataforma").
 *
 * Um único lugar decide o formato das etiquetas. Os serviços chamam esta função; ninguém monta
 * etiqueta à mão, e a IA nunca escreve etiqueta.
 *
 * Shopee: 5 sub_ids por link, nesta ordem (aprovado em 12/nov/2026):
 *   1. cliente   código curto do cliente          ex.: "c1"
 *   2. canal     de onde veio o clique            ex.: "wa"
 *   3. data      dia da postagem, AAAAMMDD        ex.: "20261112"
 *   4. oferta    ID do produto na Shopee          ex.: "22912345" ("avulso" se não houver)
 *   5. horário   hora da postagem, HHMM           ex.: "0815"
 *   Data e horário no fuso do cliente (padrão America/Sao_Paulo).
 *   Só letras minúsculas e números em cada sub_id.
 *   TODO(shopee-doc): conferir na documentação oficial os caracteres aceitos e o tamanho máximo
 *   de cada sub_id. Os valores acima têm no máximo 12 caracteres (o ID do produto pode ter mais).
 *
 * Mercado Livre: uma etiqueta por link: canal + semana ISO + nicho. Ex.: "wa-s46-casa".
 *   TODO(ml-painel): confirmar se a etiqueta pode ser criada na hora de gerar o link.
 *
 * Amazon: tracking ID por canal e nicho. Os tracking IDs são criados no painel da Amazon e têm
 *   número limitado; por isso a função só usa um ID já cadastrado. Se não houver, devolve a
 *   sugestão de nome ("wa-casa") e avisa que é preciso criá-lo no painel.
 */

export interface EntradaEtiquetas {
  cliente: { codigo: string };
  canal: string;
  /** Momento da postagem. */
  quando: Date;
  /** Fuso do cliente. Padrão: America/Sao_Paulo. */
  fusoHorario?: string;
  nicho: string;
  /** ID do produto na plataforma. Sem ID (link avulso), o campo 4 da Shopee vira "avulso". */
  oferta?: { produtoId?: string | null };
  /** Tracking IDs da Amazon já criados no painel, por "canal-nicho". Ex.: {"wa-casa": "minhaloja-20"}. */
  trackingIdsAmazon?: Record<string, string>;
}

export type SubIdsShopee = [cliente: string, canal: string, data: string, oferta: string, horario: string];

export interface Etiquetas {
  shopee: {
    subIds: SubIdsShopee;
    /** Os 5 sub_ids unidos por "-": é a chave_rastreio gravada em `links`. */
    chave: string;
  };
  mercadoLivre: { etiqueta: string };
  amazon: {
    /** Tracking ID cadastrado para o canal e nicho, ou null se ainda não existe. */
    trackingId: string | null;
    /** Nome sugerido para o tracking ID no painel. */
    sugestao: string;
    precisaCriarNoPainel: boolean;
  };
}

export const FUSO_PADRAO = 'America/Sao_Paulo';
export const OFERTA_AVULSA = 'avulso';

/** Minúsculas, sem acento, só letras e números. */
export function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function exigir(valor: string, campo: string, original: string): string {
  if (!valor) throw new Error(`Etiqueta inválida: "${campo}" ficou vazio depois de normalizar ("${original}").`);
  return valor;
}

/** Data e hora locais no fuso informado. */
export function partesLocais(quando: Date, fuso: string): { ano: number; mes: number; dia: number; hora: number; minuto: number } {
  if (Number.isNaN(quando.getTime())) throw new Error('Etiqueta inválida: data inválida.');
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: fuso,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(quando);
  const p = (t: string) => Number(partes.find((x) => x.type === t)?.value);
  return { ano: p('year'), mes: p('month'), dia: p('day'), hora: p('hour'), minuto: p('minute') };
}

/** Semana ISO 8601 (1 a 53) de uma data de calendário. */
export function semanaIso(ano: number, mes: number, dia: number): number {
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  const diaSemana = d.getUTCDay() || 7; // segunda = 1, domingo = 7
  d.setUTCDate(d.getUTCDate() + 4 - diaSemana); // quinta-feira da mesma semana
  const inicioAno = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - inicioAno.getTime()) / 86_400_000 + 1) / 7);
}

const dois = (n: number) => String(n).padStart(2, '0');

export function gerarEtiquetas(entrada: EntradaEtiquetas): Etiquetas {
  const fuso = entrada.fusoHorario ?? FUSO_PADRAO;
  const cliente = exigir(normalizar(entrada.cliente.codigo), 'cliente', entrada.cliente.codigo);
  const canal = exigir(normalizar(entrada.canal), 'canal', entrada.canal);
  const nicho = exigir(normalizar(entrada.nicho), 'nicho', entrada.nicho);
  const produtoBruto = entrada.oferta?.produtoId?.trim() ?? '';
  const oferta = produtoBruto ? exigir(normalizar(produtoBruto), 'oferta', produtoBruto) : OFERTA_AVULSA;

  const { ano, mes, dia, hora, minuto } = partesLocais(entrada.quando, fuso);
  const data = `${ano}${dois(mes)}${dois(dia)}`;
  const horario = `${dois(hora)}${dois(minuto)}`;

  const subIds: SubIdsShopee = [cliente, canal, data, oferta, horario];
  const sugestaoAmazon = `${canal}-${nicho}`;
  const trackingId = entrada.trackingIdsAmazon?.[sugestaoAmazon] ?? null;

  return {
    shopee: { subIds, chave: subIds.join('-') },
    mercadoLivre: { etiqueta: `${canal}-s${dois(semanaIso(ano, mes, dia))}-${nicho}` },
    amazon: { trackingId, sugestao: sugestaoAmazon, precisaCriarNoPainel: trackingId === null },
  };
}
