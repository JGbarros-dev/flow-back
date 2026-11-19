// Testes de aceitação pela API: histórias US01 a US08 (Engenharia de Requisitos, seção 5),
// além de RF17, RF20, RNF03 e RNF04. Rodam com o relógio parado e avançado à mão.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { criarApp } from '../src/app.js';
import { Sistema } from '../src/dominio/sistema.js';
import { Relogio } from '../src/dominio/relogio.js';
import { popular, CONTAS_DEMO } from '../src/dominio/seed.js';
import { emHorario } from '../src/dominio/tempo.js';

const HOJE = '2026-11-19';
const MIN = 60_000;
let servidor;
let base;
let sistema;
let relogio;

before(async () => {
  relogio = new Relogio({ inicio: emHorario(HOJE, '07:40'), pausado: true });
  sistema = new Sistema({ relogio });
  popular(sistema);
  const app = criarApp(sistema);
  await new Promise((ok) => {
    servidor = app.listen(0, ok);
  });
  base = `http://127.0.0.1:${servidor.address().port}`;
});

after(() => servidor.close());

async function api(metodo, caminho, { token, corpo } = {}) {
  const r = await fetch(base + caminho, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const tipo = r.headers.get('content-type') ?? '';
  return { status: r.status, corpo: tipo.includes('json') ? await r.json() : await r.text() };
}

const login = async (corpo) => (await api('POST', '/api/auth/login', { corpo })).corpo.token;
const tokenCarlos = () => login({ papel: 'motorista', cpf: CONTAS_DEMO.motorista.cpf, senha: '1234' });
const tokenRenata = () => login({ papel: 'operador', email: CONTAS_DEMO.operador.email, senha: 'flowdock' });
const tokenTransp = () => login({ papel: 'transportadora', email: CONTAS_DEMO.transportadora.email, senha: 'flowdock' });
const avancar = (min) => {
  for (let i = 0; i < min; i++) {
    relogio.avancar(MIN);
    sistema.passo();
  }
};
const agDoCarlosHoje = () => [...sistema.agendamentos.values()].find((a) => a.motoristaId === 'mot-carlos' && a.data === HOJE && a.estado !== 'CANCELADO');

test('RF01/RF02: cadastro de motorista e de caminhão, com validação', async () => {
  const ruim = await api('POST', '/api/auth/cadastro', { corpo: { nome: 'Ana', cpf: '111.111.111-11', cnh: '123', senha: '1234' } });
  assert.equal(ruim.status, 400);
  const ok = await api('POST', '/api/auth/cadastro', { corpo: { nome: 'Ana Paula Lima', cpf: '390.533.447-05', cnh: '12345678901', senha: '1234' } });
  assert.equal(ok.status, 201);
  const cam = await api('POST', '/api/caminhoes', { token: ok.corpo.token, corpo: { placa: 'abc1d23', porte: 'Truck', rntrc: '12345678' } });
  assert.equal(cam.status, 201);
  assert.equal(cam.corpo.placa, 'ABC1D23');
});

test('US01 (RF03, RF04): agenda um horário livre e recusa horário cheio', async () => {
  const token = await tokenCarlos();
  const janelas = (await api('GET', `/api/terminais/term-suape/janelas?data=${HOJE}`, { token })).corpo;
  const livre = janelas.find((j) => j.rotulo === '13:00');
  assert.equal(livre.disponivel, true);
  const r = await api('POST', '/api/agendamentos', {
    token,
    corpo: { terminalId: 'term-suape', janela: livre.inicio, caminhaoId: 'cam-carlos', carga: { produto: 'Diesel', perigosa: true } },
  });
  assert.equal(r.status, 201);
  assert.equal(r.corpo.janelaRotulo, '13:00');
  assert.equal(r.corpo.estado, 'AGENDADO');

  const cheia = janelas.find((j) => j.rotulo === '08:00');
  assert.equal(cheia.disponivel, false);
  const recusa = await api('POST', '/api/agendamentos', {
    token,
    corpo: { terminalId: 'term-suape', janela: cheia.inicio, caminhaoId: 'cam-carlos', carga: { produto: 'Diesel', perigosa: true } },
  });
  assert.equal(recusa.status, 409);
  assert.match(recusa.corpo.erro, /cheio/);
  await api('POST', `/api/agendamentos/${r.corpo.id}/cancelar`, { token });
});

test('US02 (RF05, RF06, RF07): bloqueia carga perigosa com documento vencido e guarda os documentos', async () => {
  const token = await tokenTransp();
  const janela = emHorario(HOJE, '14:00');
  const bloqueio = await api('POST', '/api/agendamentos', {
    token,
    corpo: { terminalId: 'term-suape', janela, motoristaId: 'mot-jose', caminhaoId: 'cam-peb2r45', carga: { produto: 'GLP', perigosa: true } },
  });
  assert.equal(bloqueio.status, 422);
  assert.equal(bloqueio.corpo.documento, 'MOPP');
  assert.match(bloqueio.corpo.erro, /MOPP vencido em 15\/09\/2026/);

  const cipp = await api('POST', '/api/agendamentos', {
    token,
    corpo: { terminalId: 'term-suape', janela, motoristaId: 'mot-marcos', caminhaoId: 'cam-klm8s90', carga: { produto: 'GLP', perigosa: true } },
  });
  assert.equal(cipp.status, 422);
  assert.equal(cipp.corpo.documento, 'CIPP');

  const conteudo = Buffer.from('<nfe>DANFE simulado</nfe>').toString('base64');
  const ok = await api('POST', '/api/agendamentos', {
    token,
    corpo: {
      terminalId: 'term-suape', janela, motoristaId: 'mot-marcos', caminhaoId: 'cam-peb2r45', carga: { produto: 'Diesel', perigosa: true },
      documentos: [{ tipo: 'DANFE', nome: 'danfe.xml', mime: 'text/xml', conteudoBase64: conteudo }],
    },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.corpo.documentos.length, 1);
  // RNF03: o documento fica cifrado em memória e só volta decifrado para quem pode vê-lo.
  const guardado = sistema.agendamentos.get(ok.corpo.id).documentos[0];
  assert.ok(!Buffer.from(guardado.cifrado.dados, 'base64').toString().includes('DANFE simulado'));
  const arquivo = await api('GET', `/api/agendamentos/${ok.corpo.id}/documentos/${guardado.id}`, { token: await tokenRenata() });
  assert.equal(arquivo.corpo, '<nfe>DANFE simulado</nfe>');
});

test('RF20: o motorista é avisado quando a transportadora agenda em nome dele', () => {
  const avisos = sistema.notificacoesDe('mot-marcos');
  assert.ok(avisos.some((n) => n.tipo === 'agendamento' && /TransNordeste/.test(n.texto)));
});

test('RNF04: cada perfil vê só os próprios dados', async () => {
  const carlos = await tokenCarlos();
  const outro = [...sistema.agendamentos.values()].find((a) => a.motoristaId !== 'mot-carlos');
  assert.equal((await api('GET', `/api/agendamentos/${outro.id}`, { token: carlos })).status, 403);
  assert.equal((await api('PUT', '/api/terminal', { token: carlos, corpo: { docas: 9 } })).status, 403);
  assert.equal((await api('GET', '/api/estado')).status, 401);
  const estado = (await api('GET', '/api/estado', { token: carlos })).corpo;
  assert.ok(estado.agendamentos.every((a) => a.motorista.id === 'mot-carlos'));
  const transp = (await api('GET', '/api/estado', { token: await tokenTransp() })).corpo;
  assert.ok(transp.agendamentos.every((a) => a.transportadora === 'TransNordeste Logística'));
});

test('US06 (RF09, RF10): o caminhão atrasado perde a posição e os seguintes avançam', () => {
  avancar(15); // 07:55: o imprevisto do FD-1044 (janela 08:30) começa às 07:50
  const atrasado = [...sistema.agendamentos.values()].find((a) => a.codigo === 'FD-1044');
  assert.equal(atrasado.fila.noPrazo, false);
  const outros = [...sistema.agendamentos.values()].filter((a) => a.fila && a.fila.noPrazo && a.janela > atrasado.janela && a.fila.etaFila < atrasado.fila.etaFila);
  assert.ok(outros.some((o) => o.fila.posicao < atrasado.fila.posicao));
  assert.ok(sistema.eventos.some((e) => e.tipo === 'reordenacao' && e.texto.includes('FD-1044')));
});

test('US03 (RF08) e US04 (RF11, RF12): check-in automático, posição e previsão de chamada', async () => {
  const token = await tokenCarlos();
  await api('PUT', '/api/terminal', { token: await tokenRenata(), corpo: { automatico: false } }); // RF17 manual no próximo teste
  const ag = agDoCarlosHoje();
  const r = await api('POST', `/api/agendamentos/${ag.id}/iniciar-viagem`, { token, corpo: { origem: 'recife' } });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.estado, 'EM_ROTA');
  assert.ok(r.corpo.eta > sistema.agora());
  assert.ok(r.corpo.fila.posicao >= 1);
  assert.ok(r.corpo.fila.previsaoChamada >= r.corpo.eta);
  avancar(10);
  assert.ok(['EM_ROTA', 'EM_APROXIMACAO'].includes(agDoCarlosHoje().estado), 'fora da área: sem check-in');
  assert.equal(agDoCarlosHoje().horarios.chegada, null);
  avancar(40);
  const depois = agDoCarlosHoje();
  assert.ok(depois.horarios.chegada, 'check-in registrado ao entrar na área do terminal');
  assert.ok(['AGUARDANDO', 'AUTORIZADO', 'NO_TERMINAL'].includes(depois.estado));
});

test('US05 (RF13) e RF17: autorização avisa o motorista; operador registra início e fim', async () => {
  const renata = await tokenRenata();
  await api('PUT', '/api/terminal', { token: renata, corpo: { automatico: false } });
  // Modo manual: a operadora libera as docas registrando início e fim dos outros atendimentos (RF17).
  for (let i = 0; i < 120 && agDoCarlosHoje().estado === 'AGUARDANDO'; i++) {
    for (const outro of [...sistema.agendamentos.values()].filter((a) => a.motoristaId !== 'mot-carlos')) {
      if (outro.estado === 'AUTORIZADO') await api('POST', `/api/agendamentos/${outro.id}/inicio`, { token: renata });
      if (outro.estado === 'NO_TERMINAL') await api('POST', `/api/agendamentos/${outro.id}/fim`, { token: renata });
    }
    avancar(1);
  }
  const ag = agDoCarlosHoje();
  if (ag.estado === 'AUTORIZADO') {
    const aviso = sistema.notificacoesDe('mot-carlos').find((n) => n.tipo === 'autorizacao');
    assert.ok(aviso, 'motorista avisado');
    assert.match(aviso.texto, /Terminal Piloto Suape/);
    assert.equal((await api('POST', `/api/agendamentos/${ag.id}/inicio`, { token: renata })).corpo.estado, 'NO_TERMINAL');
    assert.equal((await api('POST', `/api/agendamentos/${ag.id}/fim`, { token: renata })).corpo.estado, 'CONCLUIDO');
    const fb = await api('POST', `/api/agendamentos/${ag.id}/feedback`, { token: await tokenCarlos(), corpo: { nota: 5, comentario: 'Rápido' } });
    assert.equal(fb.corpo.feedback.nota, 5);
  } else {
    assert.fail(`estado inesperado: ${ag.estado}`);
  }
  await api('PUT', '/api/terminal', { token: renata, corpo: { automatico: true } });
});

test('US07 (RF14): o painel mostra fila, situação e ETA de cada veículo', async () => {
  const estado = (await api('GET', '/api/estado', { token: await tokenRenata() })).corpo;
  assert.ok(estado.agendamentos.length > 5);
  for (const a of estado.agendamentos) assert.ok(a.estado && 'eta' in a && 'fila' in a);
  assert.equal(estado.docas.length, 2);
  assert.ok(estado.metricas.projecao);
});

test('US08 (RF15): limite por janela é respeitado e a mudança vale para novos agendamentos', async () => {
  const renata = await tokenRenata();
  const transp = await tokenTransp();
  await api('PUT', '/api/terminal', { token: renata, corpo: { limites: { '15:00': 1 } } });
  const janela = emHorario(HOJE, '15:00');
  const corpo = (motoristaId) => ({ terminalId: 'term-suape', janela, motoristaId, caminhaoId: 'cam-peb2r45', carga: { produto: 'Açúcar', perigosa: false } });
  assert.equal((await api('POST', '/api/agendamentos', { token: transp, corpo: corpo('mot-jose') })).status, 201);
  assert.equal((await api('POST', '/api/agendamentos', { token: transp, corpo: corpo('mot-marcos') })).status, 409);
  await api('PUT', '/api/terminal', { token: renata, corpo: { limites: { '15:00': 2 } } });
  assert.equal((await api('POST', '/api/agendamentos', { token: transp, corpo: corpo('mot-marcos') })).status, 201);
});

test('RF05/RNF04: o motorista vê os documentos que enviou; outro motorista não', async () => {
  const carlos = await tokenCarlos();
  const futuro = [...sistema.agendamentos.values()].find((a) => a.motoristaId === 'mot-carlos' && a.data > HOJE);
  const conteudo = Buffer.from('<cte>CT-e do Carlos</cte>').toString('base64');
  const doc = await api('POST', `/api/agendamentos/${futuro.id}/documentos`, { token: carlos, corpo: { tipo: 'CTE', nome: 'cte.xml', mime: 'text/xml', conteudoBase64: conteudo } });
  assert.equal(doc.status, 201);
  const estado = (await api('GET', '/api/estado', { token: carlos })).corpo;
  const visto = estado.agendamentos.find((a) => a.id === futuro.id).documentos[0];
  assert.equal(visto.mime, 'text/xml');
  const arquivo = await api('GET', `/api/agendamentos/${futuro.id}/documentos/${visto.id}`, { token: carlos });
  assert.equal(arquivo.status, 200);
  assert.equal(arquivo.corpo, '<cte>CT-e do Carlos</cte>');
  const outro = await login({ papel: 'motorista', cpf: '390.533.447-05', senha: '1234' });
  assert.equal((await api('GET', `/api/agendamentos/${futuro.id}/documentos/${visto.id}`, { token: outro })).status, 403);
});
