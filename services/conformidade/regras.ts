/**
 * Regras dos programas de afiliados e da identificação de publicidade, para a afiliada não ser
 * bloqueada. Cada regra diz de onde veio e quando foi conferida.
 *
 * Fontes (conferidas em 13/11/2026):
 * - Shopee: Termos e Condições do Programa de Afiliados (help.shopee.com.br/portal/10/article/124094),
 *   atualização de 09/09/2026.
 * - Amazon: Contrato Operacional e Políticas do Programa de Associados (associados.amazon.com.br/help/operating/).
 * - Mercado Livre: o texto oficial (mercadolivre.com.br/ajuda/30228) não pôde ser lido daqui; as regras
 *   abaixo vêm de resumos de terceiros e estão marcadas como "a conferir".
 * - CONAR: Guia de Publicidade por Influenciadores Digitais, edição de 2026 (afiliado com link de comissão
 *   faz publicidade; identificação visível, no começo, sem precisar clicar em "mais").
 *
 * TODO(confirmar): reler as fontes a cada trimestre; os programas mudam as regras sem aviso.
 */

export type Programa = 'shopee' | 'amazon' | 'mercado_livre' | 'geral';

export interface RegraConformidade {
  id: string;
  programa: Programa;
  titulo: string;
  explicacao: string;
  /** automatica: o Cofilius aplica ou confere sozinho; checklist: a afiliada precisa fazer e marcar. */
  tipo: 'automatica' | 'checklist';
  fonte: string;
  aConferir?: boolean;
}

export const VERIFICADO_EM = '2026-11-13';

export const DECLARACAO_AMAZON = 'Como participante do Programa de Associados da Amazon, sou remunerado pelas compras qualificadas efetuadas.';
export const AVISO_PRECO_AMAZON = 'Preço e disponibilidade conferidos na hora do envio e sujeitos a alteração.';
export const IDENTIFICACAO_PADRAO = '#publi';

const SHOPEE = 'Termos do Programa de Afiliados Shopee (09/09/2026)';
const AMAZON = 'Contrato Operacional e Políticas do Programa de Associados Amazon';
const ML = 'Termos do Programa de Afiliados e Criadores Mercado Livre (resumos de terceiros)';
const CONAR = 'Guia CONAR de Publicidade por Influenciadores (2026)';

export const REGRAS: RegraConformidade[] = [
  // ---------------- geral ----------------
  { id: 'identificacao', programa: 'geral', tipo: 'automatica', fonte: CONAR,
    titulo: 'Identificar a publicidade',
    explicacao: 'Link que paga comissão é publicidade. O Cofilius põe a identificação (ex.: #publi) no começo de cada mensagem e legenda, onde aparece sem clicar em "mais".' },
  { id: 'sem_autocompra', programa: 'geral', tipo: 'checklist', fonte: `${SHOPEE}, 3.6(c); ${AMAZON}`,
    titulo: 'Ninguém da casa compra pelos links dela',
    explicacao: 'Compra pelo próprio link é estornada na Shopee. Na Amazon é proibida e inclui pedir a amigos, família ou colaboradores que comprem pelos links.' },
  { id: 'sem_encurtador', programa: 'geral', tipo: 'automatica', fonte: `${SHOPEE}, 2.2; ${AMAZON}; ${ML}`,
    titulo: 'Só o link oficial, sem encurtador nem redirecionador',
    explicacao: 'Os três programas proíbem alterar o link ou esconder para onde ele leva. O Cofilius só aceita links dos domínios oficiais (s.shopee.com.br, amzn.to, link.amazon, mercadolivre.com).' },
  { id: 'sem_informacao_falsa', programa: 'geral', tipo: 'automatica', fonte: `${SHOPEE}, 4.3(j) e 8.2(c)`,
    titulo: 'Nada de preço ou promoção não verificada',
    explicacao: 'O preço e o desconto vêm do banco e a mensagem só sai com o preço conferido há até 30 minutos. A IA não pode escrever valores.' },
  { id: 'sem_sorteio_recompensa', programa: 'geral', tipo: 'checklist', fonte: `${AMAZON}; ${ML}`,
    titulo: 'Sem sorteio ou prêmio por comprar pelo link',
    explicacao: 'A Amazon proíbe oferecer recompensa a quem usa os links; o Mercado Livre proíbe sorteios para afiliados.' },
  { id: 'grupo_opt_in', programa: 'geral', tipo: 'checklist', fonte: `${AMAZON} (comunicações só se solicitadas); ${ML}`,
    titulo: 'Grupo só com quem pediu para entrar',
    explicacao: 'Não adicionar pessoas sem pedido nem despejar links em grupos de outras pessoas. O grupo dela deve ser de entrada voluntária (link de convite).' },
  // ---------------- Shopee ----------------
  { id: 'shopee_canais_cadastrados', programa: 'shopee', tipo: 'checklist', fonte: `${SHOPEE}, 2.3(a)`,
    titulo: 'Canais cadastrados e aprovados na Shopee',
    explicacao: 'Cada rede social onde ela divulga (Instagram, grupo, página) precisa estar cadastrada no painel de afiliados. No Facebook, só página, não perfil pessoal.' },
  { id: 'shopee_sem_marca_no_perfil', programa: 'shopee', tipo: 'checklist', fonte: `${SHOPEE}, 2.3(a)`,
    titulo: 'Perfil sem nome ou logo da Shopee',
    explicacao: 'O perfil e o nome do grupo não podem usar a marca, o nome ou o logotipo da Shopee (ex.: "Achados Shopee").' },
  { id: 'shopee_sem_automacao', programa: 'shopee', tipo: 'automatica', fonte: `${SHOPEE}, 4.3(d)`,
    titulo: 'Sem extração automatizada de dados',
    explicacao: 'A Shopee proíbe scraping e extração automatizada. Na extensão, a busca automática e a leitura das páginas seguintes do relatório ficam desligadas por padrão; os dados chegam quando ela mesma abre os relatórios.' },
  { id: 'shopee_anuncios', programa: 'shopee', tipo: 'checklist', fonte: `${SHOPEE}, 2.3(b) e 4.3(c)(i)`,
    titulo: 'Anúncio pago só no Instagram, Facebook, TikTok ou Pinterest',
    explicacao: 'Google Ads e Bing Ads são proibidos para links de afiliado, e "Shopee" não pode ser palavra-chave paga.' },
  { id: 'shopee_email', programa: 'shopee', tipo: 'checklist', fonte: `${SHOPEE}, 4.3(a)`,
    titulo: 'Sem e-mail marketing',
    explicacao: 'E-mail promocional com links da Shopee só com consentimento escrito da Shopee.' },
  // ---------------- Amazon ----------------
  { id: 'amazon_declaracao', programa: 'amazon', tipo: 'automatica', fonte: AMAZON,
    titulo: 'Declaração de Associado em toda divulgação',
    explicacao: `Texto obrigatório e exato: "${DECLARACAO_AMAZON}" O Cofilius põe em toda mensagem e legenda com link da Amazon. Coloque também na bio do Instagram e na descrição do grupo.` },
  { id: 'amazon_bio', programa: 'amazon', tipo: 'checklist', fonte: AMAZON,
    titulo: 'Declaração na bio e na descrição do grupo',
    explicacao: 'A declaração deve estar clara e destacada no canal; bio e descrição do grupo são o lugar fixo dela.' },
  { id: 'amazon_canais', programa: 'amazon', tipo: 'checklist', fonte: AMAZON,
    titulo: 'Canais informados na conta de Associado',
    explicacao: 'Liste no perfil de Associado os canais onde divulga. A Amazon prefere canais públicos; grupo de WhatsApp é o ponto de mais risco: só com quem pediu para entrar.' },
  { id: 'amazon_preco', programa: 'amazon', tipo: 'automatica', fonte: `${AMAZON} (exibição de preços)`,
    titulo: 'Preço com aviso de atualização',
    explicacao: `Preço mostrado fora do site da Amazon precisa de aviso. O Cofilius acrescenta: "${AVISO_PRECO_AMAZON}"` },
  { id: 'amazon_imagens', programa: 'amazon', tipo: 'automatica', fonte: `${AMAZON} (imagens não podem ser armazenadas)`,
    titulo: 'Sem foto da Amazon nos criativos',
    explicacao: 'As imagens da Amazon não podem ser guardadas. Nos criativos de produto da Amazon, use foto própria; o Cofilius não baixa a foto da loja.' },
  { id: 'amazon_marca', programa: 'amazon', tipo: 'checklist', fonte: AMAZON,
    titulo: 'Sem "Amazon" no nome do perfil ou do grupo',
    explicacao: 'A marca não pode ser usada em perfis sociais, domínios ou termos de busca pagos.' },
  { id: 'amazon_offline', programa: 'amazon', tipo: 'checklist', fonte: AMAZON,
    titulo: 'Nada offline',
    explicacao: 'Links e divulgação em material impresso ou falado são proibidos.' },
  // ---------------- Mercado Livre ----------------
  { id: 'ml_grupo_publico', programa: 'mercado_livre', tipo: 'checklist', fonte: ML, aConferir: true,
    titulo: 'Grupo aberto e canal informado ao programa',
    explicacao: 'Segundo resumos dos termos, links do Mercado Livre em grupos privados ou canais não informados são proibidos. Confira no painel de afiliados antes de usar no grupo.' },
  { id: 'ml_sem_bots', programa: 'mercado_livre', tipo: 'checklist', fonte: ML, aConferir: true,
    titulo: 'Sem bots ou cliques artificiais',
    explicacao: 'Automação que gere cliques ou tráfego artificial é tratada como fraude.' },
];

/** Link é do domínio oficial do programa (sem encurtador de terceiros)? */
export const HOSTS_OFICIAIS: Record<string, RegExp> = {
  shopee: /^(s\.shopee\.com\.br|shope\.ee|shopee\.com\.br)$/i,
  amazon: /^(amzn\.to|link\.amazon|www\.amazon\.com\.br|amazon\.com\.br)$/i,
  mercado_livre: /(^|\.)(mercadolivre\.com|mercadolivre\.com\.br|mercadolibre\.com)$/i,
};

export function linkOficial(plataforma: string, url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !!HOSTS_OFICIAIS[plataforma]?.test(u.hostname);
  } catch { return false; }
}

/** Nomes dos marketplaces, que não devem aparecer em conteúdo de rede social. */
export const MARCAS = /\b(shopee|amazon|mercado\s*livre|mercadolivre)\b/i;

export interface ConformidadeCliente { identificacao: string; checklist: Record<string, string> }

export function lerConformidade(v: unknown): ConformidadeCliente {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const ident = typeof o.identificacao === 'string' && o.identificacao.trim() ? o.identificacao.trim() : IDENTIFICACAO_PADRAO;
  const checklist = o.checklist && typeof o.checklist === 'object' ? (o.checklist as Record<string, string>) : {};
  return { identificacao: ident, checklist };
}

/**
 * Texto final com a conformidade: identificação de publicidade no começo e, na Amazon, o aviso de
 * preço (se houver preço) e a declaração de Associado no fim. Determinístico: a validação refaz igual.
 */
export function aplicarConformidade(texto: string, p: { plataforma: string; identificacao: string; temPreco: boolean }): string {
  const ident = p.identificacao.trim() || IDENTIFICACAO_PADRAO;
  let saida = texto.trimStart().startsWith(ident) ? texto : `${ident} ${texto}`;
  if (p.plataforma === 'amazon') {
    if (p.temPreco) saida += `\n${AVISO_PRECO_AMAZON}`;
    saida += `\n${DECLARACAO_AMAZON}`;
  }
  return saida;
}
