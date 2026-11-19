/*
 * FlowDock: motor de fila dinâmica (evolução da PoC fila_dinamica.js, Quest #6).
 *
 * Funções puras, sem estado: recebem os veículos e devolvem o plano de atendimento.
 * Todo horário é timestamp em ms; durações e tolerâncias também em ms.
 *
 *  - RN03 / RF10: quem passa da tolerância perde a garantia do horário e a fila é refeita.
 *  - RN06: quem chega dentro da janela tem prioridade sobre quem chega depois dela.
 *  - RN01 / RF06 / RF07: certificados da carga perigosa válidos na data da operação.
 *
 * Diferenças em relação à PoC: várias docas com horários livres diferentes,
 * escolha do próximo veículo por varredura linear (O(n) por chamada, para
 * aguentar os 2.000 veículos/dia do RNF02) e certificados genéricos.
 */

/** Veículo chega até a tolerância depois do início da janela reservada. */
export const noPrazo = (v, toleranciaMs) => v.eta <= v.janela + toleranciaMs;

/** RN06: no prazo antes dos atrasados; no prazo pela janela; atrasados pelo ETA. */
export function comparador(toleranciaMs) {
  return (a, b) => {
    const ga = noPrazo(a, toleranciaMs) ? 0 : 1;
    const gb = noPrazo(b, toleranciaMs) ? 0 : 1;
    if (ga !== gb) return ga - gb;
    const d = ga === 0 ? a.janela - b.janela : a.eta - b.eta;
    if (d !== 0) return d;
    return String(a.id).localeCompare(String(b.id));
  };
}

function atender(v, livres, inicioMin, duracaoMs) {
  let i = 0;
  for (let k = 1; k < livres.length; k++) if (livres[k] < livres[i]) i = k;
  const inicio = Math.max(livres[i], inicioMin);
  livres[i] = inicio + duracaoMs;
  return { veiculo: v, inicio, fim: inicio + duracaoMs, doca: i + 1, espera: Math.max(0, inicio - v.eta) };
}

/**
 * Agenda estática (base de comparação): ordem fixa pelo horário reservado, ignora o ETA.
 * @param livres horário em que cada doca fica livre
 */
export function planejarEstatico(veiculos, livres, { duracaoMs }) {
  const docas = [...livres];
  return [...veiculos].sort((a, b) => a.janela - b.janela).map((v) => atender(v, docas, v.eta, duracaoMs));
}

/**
 * RF09/RF10: a cada doca livre chama quem já chegou, pela prioridade (RN06);
 * se ninguém chegou, espera o próximo ETA.
 */
export function planejarDinamico(veiculos, livres, { duracaoMs, toleranciaMs }) {
  const docas = [...livres];
  const cmp = comparador(toleranciaMs);
  const pendentes = [...veiculos];
  const plano = [];
  while (pendentes.length) {
    let agora = Math.min(...docas);
    let menorEta = Infinity;
    for (const v of pendentes) if (v.eta < menorEta) menorEta = v.eta;
    if (menorEta > agora) agora = menorEta; // ninguém chegou: espera o próximo
    let escolhido = -1;
    for (let k = 0; k < pendentes.length; k++) {
      if (pendentes[k].eta > agora) continue;
      if (escolhido < 0 || cmp(pendentes[k], pendentes[escolhido]) < 0) escolhido = k;
    }
    const [v] = pendentes.splice(escolhido, 1);
    plano.push(atender(v, docas, v.eta, duracaoMs));
  }
  return plano;
}

/** Espera média (min), ociosidade das docas (min) e fim do último atendimento. */
export function metricas(plano, abertura, { docas, duracaoMs }) {
  if (!plano.length) return { esperaMediaMin: 0, ociosoMin: 0, fim: abertura };
  const espera = plano.reduce((s, a) => s + a.espera, 0) / plano.length;
  const fim = Math.max(...plano.map((a) => a.fim));
  const ocioso = docas * (fim - abertura) - plano.length * duracaoMs;
  return { esperaMediaMin: espera / 60_000, ociosoMin: Math.max(0, ocioso / 60_000), fim };
}

/**
 * RN01 / RF06 / RF07: devolve o primeiro certificado vencido ou ausente na data da operação.
 * @param certificados lista [{ nome, validade: 'AAAA-MM-DD' | null }]
 * @param data data da operação 'AAAA-MM-DD'
 */
export function certificadoProblema(certificados, data) {
  for (const { nome, validade } of certificados) {
    if (!validade) return { documento: nome, validade: null, motivo: 'ausente' };
    if (validade < data) return { documento: nome, validade, motivo: 'vencido' };
  }
  return null;
}
