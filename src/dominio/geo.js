// Geografia simulada: rotas fictícias (aproximadas) até o terminal piloto em Suape.
// Não há GPS real no MVP: a posição do caminhão avança pela rota conforme a velocidade.

export const TERMINAL_PILOTO = { lat: -8.3953, lng: -34.958 };

const T = [TERMINAL_PILOTO.lat, TERMINAL_PILOTO.lng];

export const ORIGENS = {
  recife: {
    nome: 'Recife (zona portuária)',
    pontos: [[-8.0631, -34.8711], [-8.113, -34.905], [-8.165, -34.94], [-8.22, -34.98], [-8.285, -35.025], [-8.34, -35.015], [-8.37, -34.99], T],
  },
  cabo: {
    nome: 'Cabo de Santo Agostinho',
    pontos: [[-8.287, -35.035], [-8.315, -35.03], [-8.34, -35.015], [-8.37, -34.99], T],
  },
  ipojuca: {
    nome: 'Ipojuca',
    pontos: [[-8.399, -35.064], [-8.405, -35.02], [-8.4, -34.99], T],
  },
  vitoria: {
    nome: 'Vitória de Santo Antão',
    pontos: [[-8.118, -35.292], [-8.13, -35.15], [-8.15, -35.05], [-8.22, -34.98], [-8.285, -35.025], [-8.34, -35.015], [-8.37, -34.99], T],
  },
  palmares: {
    nome: 'Palmares',
    pontos: [[-8.683, -35.591], [-8.6, -35.4], [-8.5, -35.2], [-8.43, -35.08], [-8.405, -35.02], [-8.4, -34.99], T],
  },
};

const RAIO_TERRA_KM = 6371;
const rad = (g) => (g * Math.PI) / 180;

/** Distância em linha reta (haversine), em km. */
export function distanciaKm(a, b) {
  const [lat1, lng1] = Array.isArray(a) ? a : [a.lat, a.lng];
  const [lat2, lng2] = Array.isArray(b) ? b : [b.lat, b.lng];
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * RAIO_TERRA_KM * Math.asin(Math.sqrt(h));
}

/** Monta a rota de uma origem, com as distâncias acumuladas de cada ponto. */
export function criarRota(origem) {
  const o = ORIGENS[origem];
  if (!o) throw new Error(`origem desconhecida: ${origem}`);
  const acumulado = [0];
  for (let i = 1; i < o.pontos.length; i++) {
    acumulado.push(acumulado[i - 1] + distanciaKm(o.pontos[i - 1], o.pontos[i]));
  }
  return { origem, origemNome: o.nome, pontos: o.pontos, acumulado, totalKm: acumulado[acumulado.length - 1] };
}

/** Posição {lat, lng} depois de percorrer `km` da rota. */
export function pontoNaRota(rota, km) {
  const { pontos, acumulado } = rota;
  if (km <= 0) return { lat: pontos[0][0], lng: pontos[0][1] };
  for (let i = 1; i < pontos.length; i++) {
    if (km <= acumulado[i]) {
      const trecho = acumulado[i] - acumulado[i - 1] || 1;
      const f = (km - acumulado[i - 1]) / trecho;
      return {
        lat: pontos[i - 1][0] + (pontos[i][0] - pontos[i - 1][0]) * f,
        lng: pontos[i - 1][1] + (pontos[i][1] - pontos[i - 1][1]) * f,
      };
    }
  }
  const ultimo = pontos[pontos.length - 1];
  return { lat: ultimo[0], lng: ultimo[1] };
}

export const totalKm = (origem) => criarRota(origem).totalKm;
