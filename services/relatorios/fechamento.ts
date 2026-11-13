/**
 * Fechamento do período em texto, para o afiliado (WhatsApp) e para o operador.
 * Todos os números saem do banco (resumo de vendas e indicadores); da IA vêm só as frases das leituras.
 */
import { formatarPreco } from '../lista/marcadores.ts';
import type { ResumoPeriodo } from '../vendas/atribuicao.ts';
import type { ResultadoAnalise } from './analista.ts';
import type { Indicador } from './indicadores.ts';

const reais = (v: string | number) => formatarPreco(String(v));
const dataBr = (d: string) => d.split('-').reverse().join('/');

function evidencia(i: Indicador): string {
  const partes = [`${i.mensagens} ${i.mensagens === 1 ? 'mensagem' : 'mensagens'}`, `${i.cliques} cliques`, `${i.pedidos} pedidos`, reais(i.comissao)];
  return `${i.rotulo}: ${partes.join(' · ')}`;
}

export function montarFechamento(nomeCliente: string, resumo: ResumoPeriodo, analise: ResultadoAnalise | null): string {
  const linhas: string[] = [];
  linhas.push(`*Fechamento ${dataBr(resumo.inicio)} a ${dataBr(resumo.fim)}* · ${nomeCliente}`, '');
  linhas.push(`Comissão validada: ${reais(resumo.comissao.validada)}`);
  linhas.push(`Comissão pendente: ${reais(resumo.comissao.pendente)} (ainda pode cair se algum pedido for cancelado)`);
  if (Number(resumo.comissao.cancelada) > 0) linhas.push(`Cancelada no período: ${reais(resumo.comissao.cancelada)}`);
  linhas.push(`Cliques: ${resumo.cliques}`);
  if (resumo.naoAtribuidas.pedidos > 0) {
    linhas.push(`Vendas sem postagem identificada: ${resumo.naoAtribuidas.pedidos} (${reais(resumo.naoAtribuidas.comissao)})`);
  }
  if (resumo.melhoresPostagens.length) {
    linhas.push('', '*Melhores postagens*');
    resumo.melhoresPostagens.slice(0, 3).forEach((m, i) => {
      linhas.push(`${i + 1}. ${m.titulo ?? m.chaveRastreio} · ${m.pedidos} ${m.pedidos === 1 ? 'pedido' : 'pedidos'} · ${reais(m.comissao)}`);
    });
  }
  if (analise && !analise.semDados && analise.leituras.length) {
    linhas.push('', '*Leitura da semana*');
    analise.leituras.forEach((l, i) => {
      linhas.push(`${i + 1}. ${l.texto}`);
      for (const e of l.evidencias) linhas.push(`   ↳ ${evidencia(e)}`);
    });
  } else if (analise?.semDados) {
    linhas.push('', 'Sem mensagens enviadas no período: ainda não há leitura da semana.');
  }
  return linhas.join('\n');
}
