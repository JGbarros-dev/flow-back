// Testes do motor de fila: os mesmos cenários da PoC (Quest #6), agora com timestamps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planejarDinamico, planejarEstatico, metricas, certificadoProblema } from '../src/dominio/fila.js';

const MIN = 60_000;
const hm = (h, m = 0) => Date.parse('2026-11-12T00:00:00-03:00') + (h * 60 + m) * MIN;
const cfg = { duracaoMs: 30 * MIN, toleranciaMs: 15 * MIN };
const fmt = (ms) => new Date(ms - 3 * 3600_000).toISOString().slice(11, 16);

test('cenário 1 da PoC: o caminhão A atrasa 1h30, B e C avançam', () => {
  const abertura = hm(10);
  const frota = [
    { id: 'A', janela: hm(10), eta: hm(11, 30) },
    { id: 'B', janela: hm(10, 30), eta: hm(9, 50) },
    { id: 'C', janela: hm(11), eta: hm(10, 20) },
  ];
  const est = planejarEstatico(frota, [abertura], cfg);
  const din = planejarDinamico(frota, [abertura], cfg);
  assert.deepEqual(din.map((a) => a.veiculo.id), ['B', 'C', 'A']);
  assert.deepEqual(din.map((a) => fmt(a.inicio)), ['10:00', '10:30', '11:30']);
  const me = metricas(est, abertura, { docas: 1, duracaoMs: cfg.duracaoMs });
  const md = metricas(din, abertura, { docas: 1, duracaoMs: cfg.duracaoMs });
  assert.equal(me.ociosoMin, 90);
  assert.equal(md.ociosoMin, 30);
  assert.equal(Math.round(me.esperaMediaMin * 10) / 10, 86.7);
  assert.equal(Math.round(md.esperaMediaMin * 10) / 10, 6.7);
});

test('cenário 2 da PoC (RN06): quem chega fora da janela não passa na frente', () => {
  const frota = [
    { id: 'X', janela: hm(9, 30), eta: hm(10, 12) },
    { id: 'Y', janela: hm(10), eta: hm(9, 58) },
    { id: 'W', janela: hm(10, 30), eta: hm(10, 20) },
  ];
  assert.deepEqual(planejarEstatico(frota, [hm(10)], cfg).map((a) => a.veiculo.id), ['X', 'Y', 'W']);
  assert.deepEqual(planejarDinamico(frota, [hm(10)], cfg).map((a) => a.veiculo.id), ['Y', 'W', 'X']);
});

test('cenário 3 da PoC (RN01): certificado vencido é detectado', () => {
  const validos = ['MOPP', 'CIV', 'CIPP', 'RNTRC'].map((nome) => ({ nome, validade: '2027-06-01' }));
  assert.equal(certificadoProblema(validos, '2026-11-12'), null);
  const g = validos.map((c) => (c.nome === 'CIPP' ? { ...c, validade: '2026-10-30' } : c));
  assert.deepEqual(certificadoProblema(g, '2026-11-12'), { documento: 'CIPP', validade: '2026-10-30', motivo: 'vencido' });
  const semMopp = validos.map((c) => (c.nome === 'MOPP' ? { ...c, validade: null } : c));
  assert.equal(certificadoProblema(semMopp, '2026-11-12').motivo, 'ausente');
});

test('duas docas atendem em paralelo', () => {
  const frota = [
    { id: 'A', janela: hm(10), eta: hm(9, 55) },
    { id: 'B', janela: hm(10), eta: hm(9, 58) },
    { id: 'C', janela: hm(10, 30), eta: hm(10, 5) },
  ];
  const din = planejarDinamico(frota, [hm(10), hm(10)], cfg);
  assert.deepEqual(din.map((a) => [a.veiculo.id, a.doca, fmt(a.inicio)]), [['A', 1, '10:00'], ['B', 2, '10:00'], ['C', 1, '10:30']]);
});

test('RNF02: planeja 2.000 veículos em menos de 1 segundo', () => {
  const frota = Array.from({ length: 2000 }, (_, i) => {
    const janela = hm(0) + Math.floor(i / 2) * 30 * MIN;
    return { id: `V${i}`, janela, eta: janela + ((i * 37) % 60 - 30) * MIN };
  });
  const t0 = performance.now();
  const plano = planejarDinamico(frota, Array(40).fill(hm(0)), cfg);
  const ms = performance.now() - t0;
  assert.equal(plano.length, 2000);
  assert.ok(ms < 1000, `levou ${ms.toFixed(0)} ms`);
});
