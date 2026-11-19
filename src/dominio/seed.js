// Dados simulados da demonstração: um dia de operação no terminal piloto de Suape.
// Personas do documento de requisitos: Carlos Mendes (motorista) e Renata Albuquerque (terminal).
// Todos os nomes, placas, CPFs e empresas são fictícios.
import { TERMINAL_PILOTO, totalKm } from './geo.js';
import { gerarCpf } from './validacao.js';
import { MIN, dataLocal, emHorario, somarDias } from './tempo.js';

export const CONTAS_DEMO = {
  motorista: { cpf: '529.982.247-25', senha: '1234', nome: 'Carlos Mendes' },
  operador: { email: 'renata@terminal.demo', senha: 'flowdock', nome: 'Renata Albuquerque' },
  transportadora: { email: 'despacho@transnordeste.demo', senha: 'flowdock', nome: 'TransNordeste Logística' },
};

const VALIDO = '2027-08-31';

// janela, origem, antecedência da chegada em relação à janela (negativo = atraso), produto, perigosa
const FROTA_SIMULADA = [
  ['Antônio Ferreira', 'PEA1B23', 'Carreta tanque', '08:00', 'cabo', 12, 'Óleo diesel S10', true, true],
  ['Severino Costa', 'KGT4C56', 'Carreta tanque', '08:00', 'recife', 3, 'GLP', true, false],
  ['Rafael Souza', 'QYU7D89', 'Carreta tanque', '08:30', 'ipojuca', 25, 'Gasolina C', true, true],
  ['João Batista Lima', 'PFZ2E34', 'Carreta tanque', '08:30', 'vitoria', 5, 'Etanol hidratado', true, true, { aposMin: 25, duracaoMin: 75 }],
  ['Marcelo Araújo', 'OYD5F67', 'Carreta tanque', '09:00', 'cabo', 8, 'Óleo combustível', true, false],
  ['Francisco Alves', 'PGB8G90', 'Carreta', '09:30', 'recife', 15, 'Contêiner (carga geral)', false, true],
  ['Luiz Carlos Silva', 'QRT3H12', 'Carreta tanque', '09:30', 'palmares', -10, 'GLP', true, false],
  ['Edson Pereira', 'KHH6J45', 'Carreta tanque', '10:00', 'ipojuca', 10, 'Óleo diesel S500', true, true],
  ['Gilson Rocha', 'PEQ9K78', 'Bitrem', '10:00', 'vitoria', 20, 'Açúcar a granel', false, false],
  ['Wellington Dias', 'QFA1L23', 'Carreta tanque', '10:30', 'recife', 0, 'Gasolina A', true, true],
  ['Roberto Nunes', 'OYX4M56', 'Carreta tanque', '11:00', 'cabo', 35, 'Biodiesel B100', true, false],
  ['Paulo Henrique Melo', 'PFJ7N89', 'Carreta tanque', '11:00', 'palmares', -25, 'Óleo diesel S10', true, true],
  ['Ivan Cavalcanti', 'KJB2P34', 'Carreta', '11:30', 'recife', 10, 'Contêiner (carga geral)', false, true],
  ['Adriano Barbosa', 'QWE5Q67', 'Carreta tanque', '12:00', 'vitoria', 15, 'GLP', true, false],
];

export function popular(sistema, { inicio } = {}) {
  sistema.limpar();
  const agora = inicio ?? sistema.agora();
  const hoje = dataLocal(agora);
  sistema.inicioSimulacao = agora;
  sistema.ultimoPasso = agora;

  const t = sistema.adicionarTerminal({
    id: 'term-suape',
    nome: 'Terminal Piloto Suape',
    local: 'Complexo Industrial Portuário de Suape, Ipojuca (PE)',
    lat: TERMINAL_PILOTO.lat,
    lng: TERMINAL_PILOTO.lng,
  });

  sistema.adicionarOperador({ id: 'op-renata', nome: 'Renata Albuquerque', email: CONTAS_DEMO.operador.email, senha: CONTAS_DEMO.operador.senha, terminalId: t.id });

  const tr = sistema.adicionarTransportadora({
    id: 'tr-transnordeste',
    nome: 'TransNordeste Logística',
    cnpj: '12.345.678/0001-90',
    responsavel: 'Paulo Lima (despachante)',
    email: CONTAS_DEMO.transportadora.email,
    senha: CONTAS_DEMO.transportadora.senha,
  });
  const trAtor = { papel: 'transportadora', id: tr.id };

  // Persona 1: Carlos Mendes, caminhoneiro autônomo que leva combustível a Suape.
  const carlos = sistema.cadastrarMotorista(
    { nome: 'Carlos Mendes', cpf: CONTAS_DEMO.motorista.cpf, cnh: '04512378901', moppValidade: '2027-08-15', senha: CONTAS_DEMO.motorista.senha },
    { id: 'mot-carlos' },
  );
  const camCarlos = sistema.cadastrarCaminhao(
    { papel: 'motorista', id: carlos.id },
    { placa: 'PEX3A21', porte: 'Carreta tanque', rntrc: '045123789', rntrcValidade: '2028-03-10', civValidade: '2027-05-20', cippValidade: '2027-05-20' },
    { id: 'cam-carlos' },
  );

  // Frota da transportadora sem agendamento: serve para demonstrar o bloqueio por certificado vencido (RF07).
  const jose = sistema.cadastrarMotorista(
    { nome: 'José Ribamar Santos', cpf: gerarCpf(318004512), cnh: '09876543210', moppValidade: '2026-09-15' },
    { id: 'mot-jose', transportadoraId: tr.id, senhaObrigatoria: false },
  );
  sistema.cadastrarCaminhao(trAtor, { placa: 'PEB2R45', porte: 'Carreta tanque', rntrc: '078451236', rntrcValidade: VALIDO, civValidade: VALIDO, cippValidade: VALIDO }, { id: 'cam-peb2r45' });
  const marcos = sistema.cadastrarMotorista(
    { nome: 'Marcos Vieira', cpf: gerarCpf(442617093), cnh: '11223344556', moppValidade: VALIDO },
    { id: 'mot-marcos', transportadoraId: tr.id, senhaObrigatoria: false },
  );
  sistema.cadastrarCaminhao(trAtor, { placa: 'KLM8S90', porte: 'Carreta tanque', rntrc: '078459912', rntrcValidade: VALIDO, civValidade: VALIDO, cippValidade: '2026-10-30' }, { id: 'cam-klm8s90' });
  sistema.registrarEvento(t.id, 'bloqueio', `Agendamento bloqueado (RN01): KLM8S90 · ${marcos.nome}: CIPP vencido em 30/10/2026.`, agora - 25 * MIN);
  void jose;

  // Caminhões simulados (andam sozinhos pela rota).
  FROTA_SIMULADA.forEach(([nome, placa, porte, janelaRot, origem, antecedencia, produto, perigosa, daFrota, incidente], i) => {
    const transportadoraId = daFrota ? tr.id : null;
    const mot = sistema.cadastrarMotorista(
      { nome, cpf: gerarCpf(201000000 + i * 7919), cnh: String(30000000000 + i * 1234567), moppValidade: VALIDO },
      { id: `mot-sim-${i + 1}`, transportadoraId, senhaObrigatoria: false },
    );
    const cam = sistema.cadastrarCaminhao(
      daFrota ? trAtor : { papel: 'motorista', id: mot.id },
      { placa, porte, rntrc: String(50000000 + i * 3571), rntrcValidade: VALIDO, civValidade: VALIDO, cippValidade: VALIDO },
      { id: `cam-sim-${i + 1}` },
    );
    const velocidadeKmh = 55 + ((i * 7) % 14);
    const janela = emHorario(hoje, janelaRot);
    const viagemMs = (totalKm(origem) / velocidadeKmh) * 3_600_000;
    const partidaPlanejada = Math.round(janela - antecedencia * MIN - viagemMs);
    const paradas = incidente
      ? [{ inicio: partidaPlanejada + incidente.aposMin * MIN, fim: partidaPlanejada + (incidente.aposMin + incidente.duracaoMin) * MIN, motivo: 'imprevisto' }]
      : [];
    sistema.agendarSimulado({ motoristaId: mot.id, caminhaoId: cam.id, terminalId: t.id, janela, produto, perigosa, origem, partidaPlanejada, velocidadeKmh, paradas });
  });

  // Agendamento do Carlos para hoje às 09:00 (ele inicia a viagem pelo app).
  const agCarlos = sistema.agendarSimulado({
    motoristaId: carlos.id, caminhaoId: camCarlos.id, terminalId: t.id,
    janela: emHorario(hoje, '09:00'), produto: 'Óleo diesel S10', perigosa: true, origem: 'recife', partidaPlanejada: null, velocidadeKmh: 60,
  });
  agCarlos.auto = false;
  agCarlos.criadoPor = { papel: 'motorista', id: carlos.id };
  sistema.notificar(carlos.id, { tipo: 'agendamento', titulo: 'Novo agendamento', texto: `${agCarlos.codigo}: Terminal Piloto Suape, hoje às 09:00. Toque em "Iniciar viagem" quando sair.`, agendamentoId: agCarlos.id });

  // Um agendamento futuro (amanhã) para mostrar o histórico e a tela de próximas viagens (RF21).
  const amanha = somarDias(hoje, 1);
  const agFuturo = sistema.agendarSimulado({
    motoristaId: carlos.id, caminhaoId: camCarlos.id, terminalId: t.id,
    janela: emHorario(amanha, '14:00'), produto: 'Gasolina C', perigosa: true, origem: 'recife', partidaPlanejada: null, velocidadeKmh: 60,
  });
  agFuturo.auto = false;
  agFuturo.criadoPor = { papel: 'motorista', id: carlos.id };

  sistema.registrarEvento(t.id, 'config', `Simulação iniciada: ${t.docas} docas, janelas de ${t.janelaMin} min com limite de ${t.limitePadrao} veículos, tolerância de ${t.toleranciaMin} min.`, agora);
  sistema.ultimoPasso = agora - 1; // força o primeiro passo: caminhões que já saíram aparecem na estrada
  sistema.passo();
  return { terminal: t, carlos, transportadora: tr };
}

/** Horário inicial da simulação: hoje às 07:40 em Suape. */
export function inicioPadrao() {
  return emHorario(dataLocal(Date.now()), '07:40');
}
