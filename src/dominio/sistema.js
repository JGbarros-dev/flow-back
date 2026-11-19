// Estado da aplicação e regras de negócio do FlowDock.
// Os dados ficam em memória (MVP de demonstração); o relógio e a telemetria são simulados.
import { EventEmitter } from 'node:events';
import { Relogio } from './relogio.js';
import * as geo from './geo.js';
import * as fila from './fila.js';
import { HttpError, naoEncontrado, acessoNegado, invalido, conflito } from './erros.js';
import * as val from './validacao.js';
import { MIN, dataLocal, hhmm, emHorario, dataBr, minutos } from './tempo.js';
import { hashSenha, verificarSenha, cifrar, decifrar } from '../seguranca/seguranca.js';

// RN05: estados do veículo, nesta ordem.
export const ESTADOS = ['AGENDADO', 'EM_ROTA', 'EM_APROXIMACAO', 'AGUARDANDO', 'AUTORIZADO', 'NO_TERMINAL', 'CONCLUIDO'];
const NA_FILA = new Set(['AGENDADO', 'EM_ROTA', 'EM_APROXIMACAO', 'AGUARDANDO']);
const EM_MOVIMENTO = new Set(['EM_ROTA', 'EM_APROXIMACAO']);
const NA_DOCA = new Set(['AUTORIZADO', 'NO_TERMINAL']);
const TIPOS_DOC = { DANFE: 'DANFE', CTE: 'CT-e', MDFE: 'MDF-e' };
const MAX_DOC_BYTES = 5 * 1024 * 1024;
const ETA_INTERVALO = 60_000; // RF09: ETA atualizado a cada 60 s (tempo da operação)

const sobreposicao = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const arred = (n, casas = 1) => Math.round(n * 10 ** casas) / 10 ** casas;

export class Sistema extends EventEmitter {
  constructor({ relogio } = {}) {
    super();
    this.setMaxListeners(100);
    this.relogio = relogio ?? new Relogio();
    this.limpar();
  }

  limpar() {
    this.terminais = new Map();
    this.operadores = new Map();
    this.transportadoras = new Map();
    this.motoristas = new Map();
    this.caminhoes = new Map();
    this.agendamentos = new Map();
    this.notificacoes = [];
    this.eventos = [];
    this.ordens = new Map();
    this.projecoes = new Map();
    this.seq = { ag: 1040, notif: 1, evento: 1, mot: 100, cam: 100, doc: 1 };
    this.inicioSimulacao = this.agora();
    this.ultimoPasso = this.agora();
  }

  agora() {
    return this.relogio.agora();
  }

  hoje() {
    return dataLocal(this.agora());
  }

  mudou() {
    this.emit('mudou');
  }

  // ================================================================ cadastros
  adicionarTerminal(t) {
    const terminal = {
      raioCheckinKm: 2,
      raioAproximacaoKm: 10,
      docas: 2,
      janelaMin: 30,
      duracaoAtendimentoMin: 30,
      deslocamentoMin: 5,
      toleranciaMin: 15,
      limitePadrao: 2,
      limites: {},
      abertura: '07:00',
      fechamento: '18:00',
      automatico: true,
      ...t,
    };
    this.terminais.set(terminal.id, terminal);
    return terminal;
  }

  adicionarOperador({ id, nome, email, senha, terminalId }) {
    const op = { id, nome, email: email.toLowerCase(), senhaHash: hashSenha(senha), terminalId };
    this.operadores.set(id, op);
    return op;
  }

  adicionarTransportadora({ id, nome, cnpj, responsavel, email, senha }) {
    const tr = { id, nome, cnpj, responsavel, email: email.toLowerCase(), senhaHash: hashSenha(senha) };
    this.transportadoras.set(id, tr);
    return tr;
  }

  /** RF01: cadastro de motorista com nome, CPF e número da CNH. */
  cadastrarMotorista(dados, { id, transportadoraId = null, senhaObrigatoria = true } = {}) {
    const nome = val.texto(dados.nome, 'o nome completo', { min: 3 });
    const cpf = val.soDigitos(dados.cpf);
    val.exigir(val.cpfValido(cpf), 'CPF inválido: confira os 11 dígitos.', 'cpf');
    val.exigir(val.cnhValida(dados.cnh), 'Número da CNH inválido: são 11 dígitos.', 'cnh');
    const moppValidade = val.dataOpcional(dados.moppValidade, 'Validade do MOPP');
    if (senhaObrigatoria || dados.senha) {
      val.exigir(String(dados.senha ?? '').length >= 4, 'A senha precisa ter pelo menos 4 caracteres.', 'senha');
    }
    if ([...this.motoristas.values()].some((m) => m.cpf === cpf)) throw conflito('Já existe um motorista com este CPF.');
    const mot = {
      id: id ?? `mot-${++this.seq.mot}`,
      nome,
      cpf,
      cnh: val.soDigitos(dados.cnh),
      moppValidade,
      senhaHash: dados.senha ? hashSenha(dados.senha) : null,
      transportadoraId,
      criadoEm: this.agora(),
    };
    this.motoristas.set(mot.id, mot);
    this.mudou();
    return mot;
  }

  atualizarMotorista(ator, dados) {
    const mot = this.motoristas.get(ator.id);
    if (!mot) throw naoEncontrado('Motorista');
    if ('moppValidade' in dados) mot.moppValidade = val.dataOpcional(dados.moppValidade, 'Validade do MOPP');
    this.mudou();
    return mot;
  }

  /** RF02: cadastro de caminhão com placa, porte e RNTRC. */
  cadastrarCaminhao(ator, dados, { id } = {}) {
    const placa = val.normalizarPlaca(dados.placa);
    val.exigir(val.placaValida(placa), 'Placa inválida: use o padrão ABC1234 ou ABC1D23.', 'placa');
    val.exigir(val.PORTES.includes(dados.porte), `Porte inválido: escolha entre ${val.PORTES.join(', ')}.`, 'porte');
    val.exigir(val.rntrcValido(dados.rntrc), 'RNTRC inválido: informe os 8 ou 9 dígitos do registro na ANTT.', 'rntrc');
    if ([...this.caminhoes.values()].some((c) => c.placa === placa)) throw conflito('Já existe um caminhão com esta placa.');
    const cam = {
      id: id ?? `cam-${++this.seq.cam}`,
      placa,
      porte: dados.porte,
      rntrc: val.soDigitos(dados.rntrc),
      rntrcValidade: val.dataOpcional(dados.rntrcValidade, 'Validade do RNTRC'),
      civValidade: val.dataOpcional(dados.civValidade, 'Validade do CIV'),
      cippValidade: val.dataOpcional(dados.cippValidade, 'Validade do CIPP'),
      motoristaId: ator.papel === 'motorista' ? ator.id : null,
      transportadoraId: ator.papel === 'transportadora' ? ator.id : null,
    };
    this.caminhoes.set(cam.id, cam);
    this.mudou();
    return cam;
  }

  caminhoesDoMotorista(mot) {
    return [...this.caminhoes.values()].filter(
      (c) => c.motoristaId === mot.id || (mot.transportadoraId && c.transportadoraId === mot.transportadoraId),
    );
  }

  // ================================================================ autenticação
  autenticar({ papel, cpf, email, senha }) {
    let conta;
    if (papel === 'motorista') {
      const d = val.soDigitos(cpf);
      conta = [...this.motoristas.values()].find((m) => m.cpf === d);
    } else if (papel === 'operador') {
      conta = [...this.operadores.values()].find((o) => o.email === String(email ?? '').toLowerCase());
    } else if (papel === 'transportadora') {
      conta = [...this.transportadoras.values()].find((t) => t.email === String(email ?? '').toLowerCase());
    } else {
      throw invalido('Perfil inválido.');
    }
    if (!conta || !verificarSenha(senha ?? '', conta.senhaHash)) throw new HttpError(401, 'Login ou senha incorretos.');
    return { papel, id: conta.id };
  }

  conta(ator) {
    if (ator.papel === 'motorista') return this.motoristas.get(ator.id);
    if (ator.papel === 'operador') return this.operadores.get(ator.id);
    if (ator.papel === 'transportadora') return this.transportadoras.get(ator.id);
    return null;
  }

  perfil(ator) {
    const c = this.conta(ator);
    if (!c) throw new HttpError(401, 'Sessão inválida: entre novamente.');
    if (ator.papel === 'motorista') {
      const tr = c.transportadoraId ? this.transportadoras.get(c.transportadoraId) : null;
      return { papel: 'motorista', id: c.id, nome: c.nome, cpf: val.mascararCpf(c.cpf), cnh: c.cnh, moppValidade: c.moppValidade, transportadora: tr?.nome ?? null };
    }
    if (ator.papel === 'operador') {
      return { papel: 'operador', id: c.id, nome: c.nome, email: c.email, terminalId: c.terminalId };
    }
    return { papel: 'transportadora', id: c.id, nome: c.nome, responsavel: c.responsavel, email: c.email, cnpj: c.cnpj };
  }

  // ================================================================ janelas (RF03, RF04, RN02)
  terminal(id) {
    const t = this.terminais.get(id);
    if (!t) throw naoEncontrado('Terminal');
    return t;
  }

  limiteDaJanela(t, inicio) {
    return t.limites[hhmm(inicio)] ?? t.limitePadrao;
  }

  ocupacao(terminalId, inicio) {
    let n = 0;
    for (const ag of this.agendamentos.values()) {
      if (ag.terminalId === terminalId && ag.janela === inicio && ag.estado !== 'CANCELADO') n++;
    }
    return n;
  }

  janelas(terminalId, data) {
    const t = this.terminal(terminalId);
    val.exigir(val.dataValida(data), 'Data inválida.');
    const agora = this.agora();
    const lista = [];
    for (let m = minutos(t.abertura); m < minutos(t.fechamento); m += t.janelaMin) {
      const inicio = emHorario(data, `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
      const limite = this.limiteDaJanela(t, inicio);
      const ocupados = this.ocupacao(t.id, inicio);
      const encerrada = inicio + t.janelaMin * MIN <= agora;
      lista.push({ inicio, rotulo: hhmm(inicio), limite, ocupados, vagas: Math.max(0, limite - ocupados), encerrada, disponivel: !encerrada && ocupados < limite });
    }
    return lista;
  }

  // ================================================================ agendamento
  certificadosDe(mot, cam) {
    return [
      { nome: 'MOPP', validade: mot.moppValidade },
      { nome: 'CIV', validade: cam.civValidade },
      { nome: 'CIPP', validade: cam.cippValidade },
      { nome: 'RNTRC', validade: cam.rntrcValidade },
    ];
  }

  /** RN01 / RF06: devolve o problema do primeiro certificado irregular, ou null. */
  verificarCertificados(mot, cam, data) {
    const p = fila.certificadoProblema(this.certificadosDe(mot, cam), data);
    if (!p) return null;
    const mensagem = p.motivo === 'ausente' ? `${p.documento} não cadastrado` : `${p.documento} vencido em ${dataBr(p.validade)}`;
    return { ...p, mensagem };
  }

  /** RF03 a RF07 e RF20. */
  agendar(ator, dados) {
    let mot;
    if (ator.papel === 'motorista') {
      mot = this.motoristas.get(ator.id);
    } else if (ator.papel === 'transportadora') {
      mot = this.motoristas.get(dados.motoristaId);
      if (!mot || mot.transportadoraId !== ator.id) throw acessoNegado();
    } else {
      throw acessoNegado();
    }
    if (!mot) throw naoEncontrado('Motorista');

    const cam = this.caminhoes.get(dados.caminhaoId);
    const camPermitido =
      cam &&
      (ator.papel === 'transportadora' ? cam.transportadoraId === ator.id : this.caminhoesDoMotorista(mot).includes(cam));
    if (!camPermitido) throw invalido('Escolha um caminhão cadastrado.', { campo: 'caminhaoId' });

    const t = this.terminal(dados.terminalId);
    const janela = Number(dados.janela);
    const data = dataLocal(janela);
    const slot = Number.isFinite(janela) ? this.janelas(t.id, data).find((j) => j.inicio === janela) : null;
    if (!slot) throw invalido('Horário inválido para este terminal.', { campo: 'janela' });
    if (slot.encerrada) throw invalido('Esse horário já passou. Escolha outro.', { campo: 'janela' });

    const produto = val.texto(dados.carga?.produto, 'o produto transportado', { max: 80 });
    const perigosa = Boolean(dados.carga?.perigosa);
    const origem = dados.origem && geo.ORIGENS[dados.origem] ? dados.origem : 'recife';

    // RN01 / RF06 / RF07: bloqueia carga perigosa com certificado irregular na data da operação.
    if (perigosa) {
      const problema = this.verificarCertificados(mot, cam, data);
      if (problema) {
        this.registrarEvento(t.id, 'bloqueio', `Agendamento bloqueado (RN01): ${cam.placa} · ${mot.nome}: ${problema.mensagem}.`);
        this.mudou();
        throw new HttpError(422, `Agendamento bloqueado: ${problema.mensagem}. Regularize o documento para agendar carga perigosa.`, {
          bloqueado: true,
          documento: problema.documento,
          validade: problema.validade,
        });
      }
    }

    // RN02 / RF04: capacidade da janela.
    if (this.ocupacao(t.id, janela) >= slot.limite) {
      throw conflito(`O horário das ${slot.rotulo} está cheio (limite de ${slot.limite} veículos). Escolha outro horário.`, { cheio: true });
    }
    const duplicado = [...this.agendamentos.values()].some(
      (a) => a.motoristaId === mot.id && a.janela === janela && a.estado !== 'CANCELADO',
    );
    if (duplicado) throw conflito('Este motorista já tem agendamento neste horário.');

    const ag = this.#novoAgendamento({ mot, cam, t, janela, produto, perigosa, origem, ator });
    for (const doc of dados.documentos ?? []) this.#anexar(ag, doc);

    const tr = ator.papel === 'transportadora' ? this.transportadoras.get(ator.id) : null;
    // RF20: avisa o motorista assim que o agendamento é criado, inclusive pela transportadora.
    this.notificar(mot.id, {
      tipo: 'agendamento',
      titulo: 'Novo agendamento',
      texto: `${ag.codigo}: ${t.nome}, ${dataBr(data)} às ${slot.rotulo}${tr ? ` (feito por ${tr.nome})` : ''}.`,
      agendamentoId: ag.id,
    });
    this.registrarEvento(t.id, 'agendamento', `Novo agendamento ${ag.codigo}: ${cam.placa} · ${mot.nome}, janela ${slot.rotulo}${tr ? ` (por ${tr.nome})` : ''}.`);
    this.recalcular();
    this.mudou();
    return ag;
  }

  #novoAgendamento({ mot, cam, t, janela, produto, perigosa, origem, ator, auto = false, partidaPlanejada = null, velocidadeKmh = 60 }) {
    const ag = {
      id: `ag-${++this.seq.ag}`,
      codigo: `FD-${this.seq.ag}`,
      terminalId: t.id,
      motoristaId: mot.id,
      caminhaoId: cam.id,
      transportadoraId: mot.transportadoraId ?? cam.transportadoraId ?? null,
      criadoPor: { papel: ator.papel, id: ator.id },
      data: dataLocal(janela),
      janela,
      carga: { produto, perigosa },
      origem,
      estado: 'AGENDADO',
      auto,
      partidaPlanejada,
      velocidadeKmh,
      paradas: [],
      rota: null,
      posicao: null,
      distanciaKm: null,
      eta: null,
      etaAtualizadoEm: null,
      doca: null,
      horarios: { criado: this.agora(), partida: null, chegada: null, chamada: null, inicio: null, fim: null },
      fila: null,
      historicoFila: [],
      documentos: [],
      feedback: null,
    };
    this.agendamentos.set(ag.id, ag);
    return ag;
  }

  /** Usado pela carga de dados simulados: cria um agendamento sem as validações de tela. */
  agendarSimulado({ motoristaId, caminhaoId, terminalId, janela, produto, perigosa, origem, partidaPlanejada, velocidadeKmh, paradas = [] }) {
    const mot = this.motoristas.get(motoristaId);
    const cam = this.caminhoes.get(caminhaoId);
    const t = this.terminal(terminalId);
    const ag = this.#novoAgendamento({
      mot, cam, t, janela, produto, perigosa, origem,
      ator: { papel: mot.transportadoraId ? 'transportadora' : 'motorista', id: mot.transportadoraId ?? mot.id },
      auto: true, partidaPlanejada, velocidadeKmh,
    });
    ag.paradas = paradas;
    return ag;
  }

  podeVer(ator, ag) {
    if (ator.papel === 'motorista') return ag.motoristaId === ator.id;
    if (ator.papel === 'transportadora') return ag.transportadoraId === ator.id;
    if (ator.papel === 'operador') return this.operadores.get(ator.id)?.terminalId === ag.terminalId;
    return false;
  }

  acessar(ator, id) {
    const ag = this.agendamentos.get(id);
    if (!ag) throw naoEncontrado('Agendamento');
    if (!this.podeVer(ator, ag)) throw acessoNegado(); // RNF04
    return ag;
  }

  // ================================================================ documentos (RF05, RNF03)
  #anexar(ag, { tipo, nome, mime, conteudoBase64 }) {
    val.exigir(TIPOS_DOC[tipo], 'Tipo de documento inválido: use DANFE, CTE ou MDFE.', 'tipo');
    const buffer = Buffer.from(String(conteudoBase64 ?? ''), 'base64');
    val.exigir(buffer.length > 0, 'O arquivo está vazio.', 'conteudoBase64');
    val.exigir(buffer.length <= MAX_DOC_BYTES, 'Arquivo grande demais: o limite é 5 MB.', 'conteudoBase64');
    const doc = {
      id: `doc-${this.seq.doc++}`,
      tipo,
      rotulo: TIPOS_DOC[tipo],
      nome: val.texto(nome, 'o nome do arquivo', { max: 160 }),
      mime: String(mime || 'application/octet-stream').slice(0, 100),
      tamanho: buffer.length,
      enviadoEm: this.agora(),
      cifrado: cifrar(buffer), // RNF03: guardado cifrado (AES-256-GCM)
    };
    ag.documentos = ag.documentos.filter((d) => d.tipo !== tipo).concat(doc);
    return doc;
  }

  anexarDocumento(ator, agId, dados) {
    const ag = this.acessar(ator, agId);
    if (ator.papel === 'operador') throw acessoNegado();
    if (!['AGENDADO', 'EM_ROTA', 'EM_APROXIMACAO'].includes(ag.estado)) {
      throw conflito('Os documentos devem ser enviados antes da chegada ao terminal.');
    }
    const doc = this.#anexar(ag, dados);
    this.registrarEvento(ag.terminalId, 'documento', `${ag.codigo}: ${doc.rotulo} enviado antes da chegada.`);
    this.mudou();
    return doc;
  }

  lerDocumento(ator, agId, docId) {
    const ag = this.acessar(ator, agId);
    const doc = ag.documentos.find((d) => d.id === docId);
    if (!doc) throw naoEncontrado('Documento');
    return { nome: doc.nome, mime: doc.mime, conteudo: decifrar(doc.cifrado) };
  }

  // ================================================================ ações do motorista
  iniciarViagem(ator, agId, { origem } = {}) {
    const ag = this.acessar(ator, agId);
    if (ator.papel === 'transportadora') throw acessoNegado();
    if (ag.estado !== 'AGENDADO') throw conflito('A viagem já foi iniciada ou o agendamento não está ativo.');
    if (ag.data !== this.hoje()) throw conflito(`Só dá para iniciar a viagem no dia do agendamento (${dataBr(ag.data)}).`);
    if (origem && geo.ORIGENS[origem]) ag.origem = origem;
    this.#partir(ag, this.agora());
    this.recalcular();
    this.mudou();
    return ag;
  }

  #partir(ag, ms) {
    const rota = geo.criarRota(ag.origem);
    ag.rota = { ...rota, percorridoKm: 0, ultimoMs: ms };
    ag.estado = 'EM_ROTA';
    ag.horarios.partida = ms;
    ag.posicao = geo.pontoNaRota(ag.rota, 0);
    ag.distanciaKm = arred(geo.distanciaKm(ag.posicao, this.terminal(ag.terminalId)));
    this.#atualizarEta(ag, ms);
    this.registrarEvento(ag.terminalId, 'rota', `${ag.codigo} (${this.#placa(ag)}) saiu de ${rota.origemNome}: ETA ${hhmm(ag.eta)}.`, ms);
  }

  /** Demonstração: simula um imprevisto na estrada (o caminhão fica parado). */
  simularImprevisto(ator, agId, minutosParado) {
    const ag = this.acessar(ator, agId);
    if (ator.papel === 'transportadora') throw acessoNegado();
    const m = Number(minutosParado);
    val.exigir(Number.isFinite(m) && m >= 5 && m <= 240, 'Informe de 5 a 240 minutos.');
    const agora = this.agora();
    if (EM_MOVIMENTO.has(ag.estado)) {
      const fimAtual = Math.max(agora, ...ag.paradas.map((p) => p.fim));
      ag.paradas.push({ inicio: fimAtual, fim: fimAtual + m * MIN, motivo: 'imprevisto' });
      this.#atualizarEta(ag, agora);
    } else if (ag.estado === 'AGENDADO' && ag.auto && ag.partidaPlanejada) {
      ag.partidaPlanejada += m * MIN;
    } else {
      throw conflito('O imprevisto só pode ser simulado com o caminhão em rota.');
    }
    this.registrarEvento(ag.terminalId, 'imprevisto', `Imprevisto na estrada: ${ag.codigo} (${this.#placa(ag)}) parado por ${m} min${ag.eta ? `, novo ETA ${hhmm(ag.eta)}` : ''}.`);
    this.recalcular();
    this.mudou();
    return ag;
  }

  cancelar(ator, agId) {
    const ag = this.acessar(ator, agId);
    if (ator.papel === 'operador') throw acessoNegado();
    if (!['AGENDADO', 'EM_ROTA', 'EM_APROXIMACAO'].includes(ag.estado)) throw conflito('Este agendamento não pode mais ser cancelado.');
    ag.estado = 'CANCELADO';
    ag.fila = null;
    this.notificar(ag.motoristaId, { tipo: 'cancelamento', titulo: 'Agendamento cancelado', texto: `${ag.codigo} foi cancelado e o horário foi liberado.`, agendamentoId: ag.id });
    this.registrarEvento(ag.terminalId, 'cancelamento', `${ag.codigo} (${this.#placa(ag)}) cancelado: vaga das ${hhmm(ag.janela)} liberada.`);
    this.recalcular();
    this.mudou();
    return ag;
  }

  /** Formulário de feedback de uma pergunta, depois do atendimento (Quest #6). */
  registrarFeedback(ator, agId, { nota, comentario }) {
    const ag = this.acessar(ator, agId);
    if (ator.papel !== 'motorista') throw acessoNegado();
    if (ag.estado !== 'CONCLUIDO') throw conflito('O feedback fica disponível depois do atendimento.');
    if (ag.feedback) throw conflito('Você já respondeu sobre este atendimento.');
    const n = Number(nota);
    val.exigir(Number.isInteger(n) && n >= 1 && n <= 5, 'Escolha uma nota de 1 a 5.');
    ag.feedback = { nota: n, comentario: String(comentario ?? '').trim().slice(0, 500), em: this.agora() };
    this.registrarEvento(ag.terminalId, 'feedback', `Feedback de ${ag.codigo}: nota ${n}/5.`);
    this.mudou();
    return ag;
  }

  // ================================================================ ações do terminal
  operadorTerminal(ator) {
    if (ator.papel !== 'operador') throw acessoNegado();
    return this.terminal(this.operadores.get(ator.id).terminalId);
  }

  /** RF17: início do atendimento na doca. */
  registrarInicio(ator, agId) {
    this.operadorTerminal(ator);
    const ag = this.acessar(ator, agId);
    if (ag.estado !== 'AUTORIZADO') throw conflito('Só é possível iniciar o atendimento de um veículo autorizado.');
    this.#iniciarAtendimento(ag, this.agora());
    this.recalcular();
    this.mudou();
    return ag;
  }

  /** RF17: fim do atendimento na doca. */
  registrarFim(ator, agId) {
    this.operadorTerminal(ator);
    const ag = this.acessar(ator, agId);
    if (ag.estado !== 'NO_TERMINAL') throw conflito('Só é possível finalizar um atendimento em andamento.');
    this.#finalizarAtendimento(ag, this.agora());
    this.recalcular();
    this.mudou();
    return ag;
  }

  /** RF15: número de docas e limite de veículos de cada janela. */
  configurarTerminal(ator, dados) {
    const t = this.operadorTerminal(ator);
    const inteiro = (v, campo, min, max) => {
      const n = Number(v);
      val.exigir(Number.isInteger(n) && n >= min && n <= max, `${campo}: informe um número inteiro de ${min} a ${max}.`);
      return n;
    };
    if (dados.docas !== undefined) t.docas = inteiro(dados.docas, 'Número de docas', 1, 20);
    if (dados.limitePadrao !== undefined) t.limitePadrao = inteiro(dados.limitePadrao, 'Limite por janela', 1, 50);
    if (dados.toleranciaMin !== undefined) t.toleranciaMin = inteiro(dados.toleranciaMin, 'Tolerância', 0, 120);
    if (dados.duracaoAtendimentoMin !== undefined) t.duracaoAtendimentoMin = inteiro(dados.duracaoAtendimentoMin, 'Duração do atendimento', 5, 240);
    if (dados.automatico !== undefined) t.automatico = Boolean(dados.automatico);
    if (dados.limites !== undefined) {
      val.exigir(dados.limites && typeof dados.limites === 'object', 'Limites inválidos.');
      const limites = {};
      for (const [rotulo, n] of Object.entries(dados.limites)) {
        val.exigir(/^\d{2}:\d{2}$/.test(rotulo), `Janela inválida: ${rotulo}.`);
        if (n === null || n === '') continue;
        limites[rotulo] = inteiro(n, `Limite da janela ${rotulo}`, 0, 50);
      }
      t.limites = limites;
    }
    this.registrarEvento(t.id, 'config', `Configuração atualizada: ${t.docas} doca(s), limite padrão ${t.limitePadrao} por janela, tolerância ${t.toleranciaMin} min.`);
    this.recalcular();
    this.mudou();
    return t;
  }

  // ================================================================ simulação
  /** Avança a simulação até o horário atual do relógio. Chamado a cada segundo pelo servidor. */
  passo() {
    const agora = this.agora();
    if (agora <= this.ultimoPasso) return false;
    this.ultimoPasso = agora;

    for (const ag of this.agendamentos.values()) {
      if (ag.estado === 'AGENDADO' && ag.auto && ag.partidaPlanejada && ag.partidaPlanejada <= agora && ag.data === dataLocal(agora)) {
        this.#partir(ag, ag.partidaPlanejada);
      }
      if (EM_MOVIMENTO.has(ag.estado)) this.#mover(ag, agora);
    }
    for (const t of this.terminais.values()) {
      for (const ag of this.agendamentos.values()) {
        if (ag.terminalId !== t.id || !t.automatico) continue;
        if (ag.estado === 'AUTORIZADO' && agora >= ag.horarios.chamada + t.deslocamentoMin * MIN) {
          this.#iniciarAtendimento(ag, ag.horarios.chamada + t.deslocamentoMin * MIN);
        }
        if (ag.estado === 'NO_TERMINAL' && agora >= ag.horarios.inicio + t.duracaoAtendimentoMin * MIN) {
          this.#finalizarAtendimento(ag, ag.horarios.inicio + t.duracaoAtendimentoMin * MIN);
        }
      }
    }
    this.recalcular();
    this.mudou();
    return true;
  }

  #tempoParado(ag, de, ate) {
    return ag.paradas.reduce((s, p) => s + sobreposicao(de, ate, p.inicio, p.fim), 0);
  }

  #mover(ag, ate) {
    const r = ag.rota;
    const t = this.terminal(ag.terminalId);
    if (ate <= r.ultimoMs) return;
    const andando = ate - r.ultimoMs - this.#tempoParado(ag, r.ultimoMs, ate);
    r.percorridoKm = Math.min(r.totalKm, r.percorridoKm + (ag.velocidadeKmh * andando) / 3_600_000);
    r.ultimoMs = ate;
    ag.posicao = geo.pontoNaRota(r, r.percorridoKm);
    const dist = geo.distanciaKm(ag.posicao, t);
    ag.distanciaKm = arred(dist);

    // RF08: check-in automático ao entrar na área definida em volta do terminal (geofence).
    if (dist <= t.raioCheckinKm || r.percorridoKm >= r.totalKm) {
      this.#checkin(ag, ate);
      return;
    }
    if (ag.estado === 'EM_ROTA' && dist <= t.raioAproximacaoKm) {
      ag.estado = 'EM_APROXIMACAO';
      this.#atualizarEta(ag, ate);
      this.notificar(ag.motoristaId, { tipo: 'aproximacao', titulo: 'Você está chegando', texto: `Faltam ${ag.distanciaKm} km para o ${t.nome}. O check-in será automático.`, agendamentoId: ag.id });
    }
    // RF09: atualiza o ETA a cada 60 segundos enquanto o veículo está em rota.
    if (ate - ag.etaAtualizadoEm >= ETA_INTERVALO) this.#atualizarEta(ag, ate);
  }

  #atualizarEta(ag, ms) {
    const t = this.terminal(ag.terminalId);
    const restanteKm = Math.max(0, ag.rota.totalKm - ag.rota.percorridoKm - t.raioCheckinKm);
    // Só conta paradas que já começaram: o sistema não adivinha imprevistos futuros.
    const parado = ag.paradas.filter((p) => p.inicio <= ms).reduce((s, p) => s + Math.max(0, p.fim - ms), 0);
    ag.eta = Math.round(ms + (restanteKm / ag.velocidadeKmh) * 3_600_000 + parado);
    ag.etaAtualizadoEm = ms;
  }

  #checkin(ag, ms) {
    const t = this.terminal(ag.terminalId);
    ag.estado = 'AGUARDANDO';
    ag.horarios.chegada = ms;
    ag.eta = ms;
    ag.etaAtualizadoEm = ms;
    const situacao = ms <= ag.janela + t.toleranciaMin * MIN ? 'dentro do prazo' : 'fora da janela';
    this.notificar(ag.motoristaId, {
      tipo: 'checkin',
      titulo: 'Chegada registrada',
      texto: `Check-in automático às ${hhmm(ms)} (${situacao}). Aguarde no pátio: você será avisado quando puder seguir para a doca.`,
      agendamentoId: ag.id,
    });
    this.registrarEvento(t.id, 'checkin', `Check-in automático (geofence): ${ag.codigo} (${this.#placa(ag)}) às ${hhmm(ms)}, ${situacao}.`, ms);
  }

  #autorizar(t, agora) {
    const ocupadas = new Set();
    for (const ag of this.agendamentos.values()) {
      if (ag.terminalId === t.id && NA_DOCA.has(ag.estado)) ocupadas.add(ag.doca);
    }
    const livres = [];
    for (let d = 1; d <= t.docas; d++) if (!ocupadas.has(d)) livres.push(d);
    if (!livres.length) return;

    const tol = t.toleranciaMin * MIN;
    const cmp = fila.comparador(tol);
    const candidatos = [...this.agendamentos.values()]
      .filter((ag) => ag.terminalId === t.id && ag.estado === 'AGUARDANDO')
      .map((ag) => ({ id: ag.id, eta: ag.horarios.chegada, janela: ag.janela, ag }))
      .sort(cmp);

    for (const c of candidatos) {
      if (!livres.length) break;
      const ag = c.ag;
      // RN05: só chega a Autorizado se cumprir a RN01 (carga perigosa).
      if (ag.carga.perigosa) {
        const problema = this.verificarCertificados(this.motoristas.get(ag.motoristaId), this.caminhoes.get(ag.caminhaoId), ag.data);
        if (problema) {
          if (!ag.alertaRn01) {
            ag.alertaRn01 = true;
            this.registrarEvento(t.id, 'bloqueio', `${ag.codigo} não pode ser autorizado (RN01): ${problema.mensagem}.`);
          }
          continue;
        }
      }
      const doca = livres.shift();
      ag.estado = 'AUTORIZADO';
      ag.doca = doca;
      ag.horarios.chamada = agora;
      ag.fila = null;
      // RF13: avisa o motorista que ele pode seguir para o terminal.
      this.notificar(ag.motoristaId, {
        tipo: 'autorizacao',
        titulo: `Siga para a doca ${doca}`,
        texto: `Autorizado às ${hhmm(agora)}: siga agora para a doca ${doca} do ${t.nome}.`,
        agendamentoId: ag.id,
      });
      this.registrarEvento(t.id, 'autorizacao', `${ag.codigo} (${this.#placa(ag)}) autorizado para a doca ${doca}; esperou ${Math.round((agora - ag.horarios.chegada) / MIN)} min no pátio.`);
    }
  }

  #iniciarAtendimento(ag, ms) {
    ag.estado = 'NO_TERMINAL';
    ag.horarios.inicio = ms;
    this.notificar(ag.motoristaId, { tipo: 'inicio', titulo: 'Atendimento iniciado', texto: `Atendimento iniciado na doca ${ag.doca} às ${hhmm(ms)}.`, agendamentoId: ag.id });
    this.registrarEvento(ag.terminalId, 'inicio', `Doca ${ag.doca}: início do atendimento de ${ag.codigo} (${this.#placa(ag)}).`, ms);
  }

  #finalizarAtendimento(ag, ms) {
    ag.estado = 'CONCLUIDO';
    ag.horarios.fim = ms;
    this.notificar(ag.motoristaId, { tipo: 'concluido', titulo: 'Atendimento concluído', texto: `${ag.codigo} concluído às ${hhmm(ms)}. Conte como foi: leva 10 segundos.`, agendamentoId: ag.id });
    this.registrarEvento(ag.terminalId, 'fim', `Doca ${ag.doca}: fim do atendimento de ${ag.codigo} (${this.#placa(ag)}).`, ms);
  }

  // ================================================================ fila (RF10, RF11, RF12, RF19)
  /** ETA usado na fila: chegada real, ETA em rota ou estimativa para quem ainda não saiu. */
  etaNaFila(ag, agora) {
    if (ag.estado === 'AGUARDANDO') return ag.horarios.chegada;
    if (EM_MOVIMENTO.has(ag.estado)) return ag.eta;
    const viagem = (geo.totalKm(ag.origem) / ag.velocidadeKmh) * 3_600_000;
    if (ag.auto && ag.partidaPlanejada) return Math.max(ag.partidaPlanejada, agora) + viagem;
    return Math.max(ag.janela, agora + viagem);
  }

  recalcular() {
    const agora = this.agora();
    const hoje = dataLocal(agora);
    for (const t of this.terminais.values()) {
      this.#autorizar(t, agora);
      const tol = t.toleranciaMin * MIN;
      const duracaoMs = (t.deslocamentoMin + t.duracaoAtendimentoMin) * MIN;

      const livres = [];
      for (let d = 1; d <= t.docas; d++) {
        const atual = [...this.agendamentos.values()].find((a) => a.terminalId === t.id && NA_DOCA.has(a.estado) && a.doca === d);
        let livre = agora;
        if (atual?.estado === 'AUTORIZADO') livre = atual.horarios.chamada + duracaoMs;
        if (atual?.estado === 'NO_TERMINAL') livre = atual.horarios.inicio + t.duracaoAtendimentoMin * MIN;
        livres.push(Math.max(agora, livre));
      }

      const veiculos = [...this.agendamentos.values()]
        .filter((a) => a.terminalId === t.id && a.data === hoje && NA_FILA.has(a.estado))
        .map((a) => ({ id: a.id, eta: this.etaNaFila(a, agora), janela: a.janela, ag: a }));

      const plano = fila.planejarDinamico(veiculos, livres, { duracaoMs, toleranciaMs: tol });
      const estatico = fila.planejarEstatico(veiculos, livres, { duracaoMs });
      const cfg = { docas: t.docas, duracaoMs };
      this.projecoes.set(t.id, {
        veiculos: veiculos.length,
        dinamica: fila.metricas(plano, agora, cfg),
        estatica: fila.metricas(estatico, agora, cfg),
      });

      const ordemAnterior = this.ordens.get(t.id) ?? [];
      const ordemNova = plano.map((p) => p.veiculo.id);
      const porId = new Map(veiculos.map((v) => [v.id, v]));
      plano.forEach((p, k) => {
        const ag = p.veiculo.ag;
        const prazo = fila.noPrazo(p.veiculo, tol);
        const anterior = ag.fila;
        ag.fila = {
          posicao: k + 1,
          total: plano.length,
          previsaoChamada: p.inicio,
          docaPrevista: p.doca,
          etaFila: p.veiculo.eta,
          noPrazo: prazo,
          esperaPrevistaMin: Math.round(p.espera / MIN),
          motivo: anterior?.motivo ?? null,
        };
        // RN03 / RF10: o veículo passou da tolerância e perdeu a garantia do horário.
        if (anterior && anterior.noPrazo && !prazo) {
          this.registrarEvento(t.id, 'reordenacao', `Fila reorganizada (RF10): ${ag.codigo} (${this.#placa(ag)}) com ETA ${hhmm(p.veiculo.eta)}, além da janela ${hhmm(ag.janela)} + ${t.toleranciaMin} min. Os veículos no prazo avançam.`);
        }
        const de = ordemAnterior.indexOf(ag.id);
        if (de >= 0 && de !== k) this.#registrarMudanca(t, ag, de, k, ordemAnterior, ordemNova, p.veiculo, tol, porId);
      });
      this.ordens.set(t.id, ordemNova);
    }
  }

  /** RF19: explica ao motorista por que a posição dele mudou. */
  #registrarMudanca(t, ag, de, para, ordemAnterior, ordemNova, veiculo, tol, porId) {
    const cod = (id) => this.agendamentos.get(id)?.codigo ?? id;
    const lista = (ids) => ids.map(cod).join(', ');
    let motivo;
    let tipo;
    if (para < de) {
      const chamados = ordemAnterior.slice(0, de).filter((id) => !ordemNova.includes(id));
      const ultrapassados = ordemAnterior.slice(0, de).filter((id) => ordemNova.indexOf(id) > para);
      const atrasados = ultrapassados.filter((id) => porId.has(id) && !fila.noPrazo(porId.get(id), tol));
      const depois = ultrapassados.filter((id) => !atrasados.includes(id));
      const partes = [];
      if (atrasados.length) partes.push(`${lista(atrasados)} não vai chegar no prazo e perdeu a prioridade`);
      if (depois.length) partes.push(`sua chegada prevista (${hhmm(veiculo.eta)}) é anterior à de ${lista(depois)}, então a doca livre fica com você`);
      if (chamados.length) partes.push(`${lista(chamados)} já foi chamado para a doca ou saiu da fila`);
      tipo = ultrapassados.length ? 'reordenacao' : 'andou';
      motivo = `Você avançou ${de - para} posição(ões): ${partes.join('; ') || 'a fila foi refeita'}.`;
    } else {
      if (!fila.noPrazo(veiculo, tol)) {
        tipo = 'perdeu-prioridade';
        motivo = `Sua previsão de chegada (${hhmm(veiculo.eta)}) passou do limite da sua janela (${hhmm(ag.janela)} + ${t.toleranciaMin} min de tolerância). Quem chega no prazo tem prioridade (RN06).`;
      } else {
        const passaram = ordemNova.slice(0, para).filter((id) => {
          const i = ordemAnterior.indexOf(id);
          return i === -1 || i > de;
        });
        const novos = passaram.filter((id) => !ordemAnterior.includes(id));
        tipo = 'reordenacao';
        motivo = novos.length
          ? `${lista(passaram)} entrou na fila com janela anterior à sua.`
          : `${lista(passaram)} passou à frente: chegou ou vai chegar antes, dentro da própria janela (RN06).`;
      }
    }
    ag.fila.motivo = motivo;
    if (tipo === 'andou') return; // a fila só andou: o motivo aparece, mas não vira histórico nem aviso
    const agora = this.agora();
    ag.historicoFila = [{ em: agora, de: de + 1, para: para + 1, motivo, tipo }, ...ag.historicoFila].slice(0, 20);
    // Evita excesso de avisos: no máximo um a cada 10 min, salvo quando o motorista perde a prioridade.
    if (tipo === 'perdeu-prioridade' || !ag.ultimoAvisoFila || agora - ag.ultimoAvisoFila >= 10 * MIN) {
      ag.ultimoAvisoFila = agora;
      this.notificar(ag.motoristaId, { tipo: 'fila', titulo: `Sua posição mudou: ${de + 1}º → ${para + 1}º`, texto: motivo, agendamentoId: ag.id });
    }
  }

  // ================================================================ notificações e eventos
  notificar(motoristaId, { tipo, titulo, texto, agendamentoId }) {
    const n = { id: this.seq.notif++, motoristaId, tipo, titulo, texto, agendamentoId, em: this.agora(), lida: false };
    this.notificacoes.push(n);
    if (this.notificacoes.length > 2000) this.notificacoes.splice(0, this.notificacoes.length - 2000);
    return n;
  }

  notificacoesDe(motoristaId, limite = 40) {
    return this.notificacoes.filter((n) => n.motoristaId === motoristaId).slice(-limite).reverse();
  }

  marcarLidas(ator) {
    if (ator.papel !== 'motorista') throw acessoNegado();
    for (const n of this.notificacoes) if (n.motoristaId === ator.id) n.lida = true;
    this.mudou();
  }

  registrarEvento(terminalId, tipo, texto, em = this.agora()) {
    this.eventos.push({ id: this.seq.evento++, terminalId, tipo, texto, em });
    if (this.eventos.length > 500) this.eventos.splice(0, this.eventos.length - 500);
  }

  #placa(ag) {
    return this.caminhoes.get(ag.caminhaoId)?.placa ?? '';
  }

  // ================================================================ métricas e visões
  metricas(t) {
    const agora = this.agora();
    const hoje = dataLocal(agora);
    const ags = [...this.agendamentos.values()].filter((a) => a.terminalId === t.id && a.data === hoje);
    const chamados = ags.filter((a) => a.horarios.chamada && a.horarios.chegada);
    const esperaMedia = chamados.length
      ? chamados.reduce((s, a) => s + (a.horarios.chamada - a.horarios.chegada), 0) / chamados.length / MIN
      : 0;
    const inicio = Math.max(emHorario(hoje, t.abertura), this.inicioSimulacao);
    let ocupado = 0;
    for (const a of ags) {
      if (!a.horarios.chamada) continue;
      ocupado += sobreposicao(inicio, agora, a.horarios.chamada, a.horarios.fim ?? agora);
    }
    const total = Math.max(0, t.docas * (agora - inicio));
    const conta = (estados) => ags.filter((a) => estados.includes(a.estado)).length;
    const notas = ags.filter((a) => a.feedback).map((a) => a.feedback.nota);
    const proj = this.projecoes.get(t.id);
    return {
      agendados: conta(['AGENDADO']),
      aCaminho: conta(['EM_ROTA', 'EM_APROXIMACAO']),
      aguardando: conta(['AGUARDANDO']),
      emAtendimento: conta(['AUTORIZADO', 'NO_TERMINAL']),
      concluidos: conta(['CONCLUIDO']),
      esperaMediaMin: arred(esperaMedia),
      ociosidadeMin: Math.round(Math.max(0, total - ocupado) / MIN),
      ocupacaoPct: total ? Math.round((ocupado / total) * 100) : 0,
      notaMedia: notas.length ? arred(notas.reduce((s, n) => s + n, 0) / notas.length) : null,
      respostasFeedback: notas.length,
      projecao: proj
        ? {
            veiculos: proj.veiculos,
            esperaFlowDockMin: arred(proj.dinamica.esperaMediaMin),
            esperaEstaticaMin: arred(proj.estatica.esperaMediaMin),
            fimFlowDock: proj.dinamica.fim,
            fimEstatica: proj.estatica.fim,
          }
        : null,
    };
  }

  serializar(ag) {
    const mot = this.motoristas.get(ag.motoristaId);
    const cam = this.caminhoes.get(ag.caminhaoId);
    const tr = ag.transportadoraId ? this.transportadoras.get(ag.transportadoraId) : null;
    const agora = this.agora();
    const parada = ag.paradas.find((p) => p.inicio <= agora && agora < p.fim);
    return {
      id: ag.id,
      codigo: ag.codigo,
      terminalId: ag.terminalId,
      data: ag.data,
      janela: ag.janela,
      janelaRotulo: hhmm(ag.janela),
      estado: ag.estado,
      carga: ag.carga,
      origem: ag.origem,
      origemNome: geo.ORIGENS[ag.origem]?.nome,
      motorista: { id: mot.id, nome: mot.nome },
      caminhao: { id: cam.id, placa: cam.placa, porte: cam.porte },
      transportadora: tr?.nome ?? null,
      criadoPor: ag.criadoPor.papel,
      simulado: ag.auto,
      posicao: ag.posicao,
      distanciaKm: ag.distanciaKm,
      eta: ag.estado === 'AGENDADO' ? null : ag.eta,
      etaAtualizadoEm: ag.etaAtualizadoEm,
      doca: ag.doca,
      horarios: ag.horarios,
      fila: ag.fila,
      historicoFila: ag.historicoFila,
      rota: ag.rota
        ? { pontos: ag.rota.pontos, totalKm: arred(ag.rota.totalKm), percorridoKm: arred(ag.rota.percorridoKm), velocidadeKmh: ag.velocidadeKmh }
        : { pontos: geo.ORIGENS[ag.origem]?.pontos ?? [], totalKm: arred(geo.totalKm(ag.origem)), percorridoKm: 0, velocidadeKmh: ag.velocidadeKmh },
      parado: parada ? { ate: parada.fim } : null,
      documentos: ag.documentos.map(({ id, tipo, rotulo, nome, mime, tamanho, enviadoEm }) => ({ id, tipo, rotulo, nome, mime, tamanho, enviadoEm })),
      feedback: ag.feedback,
    };
  }

  terminalPublico(t) {
    const { id, nome, local, lat, lng, raioCheckinKm, raioAproximacaoKm, docas, janelaMin, duracaoAtendimentoMin, deslocamentoMin, toleranciaMin, limitePadrao, limites, abertura, fechamento, automatico } = t;
    return { id, nome, local, lat, lng, raioCheckinKm, raioAproximacaoKm, docas, janelaMin, duracaoAtendimentoMin, deslocamentoMin, toleranciaMin, limitePadrao, limites, abertura, fechamento, automatico };
  }

  /** Visão de cada perfil (RNF04: cada um recebe só os próprios dados). */
  snapshot(ator) {
    const base = { agora: this.agora(), hoje: this.hoje(), relogio: this.relogio.estado() };
    const ordenar = (lista) => lista.sort((a, b) => a.janela - b.janela);
    if (ator.papel === 'motorista') {
      const mot = this.motoristas.get(ator.id);
      if (!mot) throw new HttpError(401, 'Sessão inválida: entre novamente.');
      return {
        ...base,
        perfil: this.perfil(ator),
        terminais: [...this.terminais.values()].map((t) => this.terminalPublico(t)),
        caminhoes: this.caminhoesDoMotorista(mot),
        agendamentos: ordenar([...this.agendamentos.values()].filter((a) => a.motoristaId === mot.id).map((a) => this.serializar(a))),
        notificacoes: this.notificacoesDe(mot.id),
      };
    }
    if (ator.papel === 'operador') {
      const t = this.operadorTerminal(ator);
      const hoje = this.hoje();
      const ags = [...this.agendamentos.values()].filter((a) => a.terminalId === t.id && a.data >= hoje);
      const docas = [];
      for (let d = 1; d <= t.docas; d++) {
        const atual = ags.find((a) => NA_DOCA.has(a.estado) && a.doca === d);
        docas.push({ numero: d, agendamentoId: atual?.id ?? null });
      }
      return {
        ...base,
        perfil: this.perfil(ator),
        terminal: this.terminalPublico(t),
        agendamentos: ordenar(ags.map((a) => this.serializar(a))),
        docas,
        metricas: this.metricas(t),
        eventos: this.eventos.filter((e) => e.terminalId === t.id).slice(-80).sort((a, b) => b.em - a.em || b.id - a.id),
      };
    }
    if (ator.papel === 'transportadora') {
      const tr = this.transportadoras.get(ator.id);
      if (!tr) throw new HttpError(401, 'Sessão inválida: entre novamente.');
      const motoristas = [...this.motoristas.values()].filter((m) => m.transportadoraId === tr.id);
      return {
        ...base,
        perfil: this.perfil(ator),
        terminais: [...this.terminais.values()].map((t) => this.terminalPublico(t)),
        motoristas: motoristas.map((m) => ({ id: m.id, nome: m.nome, cpf: val.mascararCpf(m.cpf), moppValidade: m.moppValidade })),
        caminhoes: [...this.caminhoes.values()].filter((c) => c.transportadoraId === tr.id),
        agendamentos: ordenar([...this.agendamentos.values()].filter((a) => a.transportadoraId === tr.id && a.data >= this.hoje()).map((a) => this.serializar(a))),
      };
    }
    throw acessoNegado();
  }
}
