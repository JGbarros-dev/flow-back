// Rotas HTTP da API do FlowDock.
import express from 'express';
import cors from 'cors';
import { HttpError, acessoNegado } from './dominio/erros.js';
import { ORIGENS } from './dominio/geo.js';
import { PORTES } from './dominio/validacao.js';
import { CONTAS_DEMO, popular, inicioPadrao } from './dominio/seed.js';
import { assinarToken, lerToken } from './seguranca/seguranca.js';

export function criarApp(sistema, { reiniciar } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true }));
  app.use(express.json({ limit: '12mb' }));

  // ------------------------------------------------------------ autenticação (RNF04)
  const autenticar = (req, _res, next) => {
    const cabecalho = req.get('authorization') ?? '';
    const token = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : req.query.token;
    const ator = lerToken(token);
    if (!ator || !sistema.conta(ator)) return next(new HttpError(401, 'Sessão expirada ou inválida: entre novamente.'));
    req.ator = ator;
    next();
  };
  const exigirPapel = (...papeis) => (req, _res, next) => (papeis.includes(req.ator.papel) ? next() : next(acessoNegado()));

  // ------------------------------------------------------------ público
  app.get('/', (_req, res) => res.json({ servico: 'FlowDock API', status: 'ok', docs: '/api/saude' }));
  app.get('/api/saude', (_req, res) => res.json({ status: 'ok', agora: sistema.agora(), relogio: sistema.relogio.estado() }));
  app.get('/api/demo', (_req, res) =>
    res.json({ contas: CONTAS_DEMO, origens: Object.entries(ORIGENS).map(([id, o]) => ({ id, nome: o.nome })), portes: PORTES }),
  );

  app.post('/api/auth/login', (req, res) => {
    const ator = sistema.autenticar(req.body ?? {});
    res.json({ token: assinarToken(ator), perfil: sistema.perfil(ator) });
  });

  /** RF01: cadastro do motorista (cria a conta e já entra). */
  app.post('/api/auth/cadastro', (req, res) => {
    const mot = sistema.cadastrarMotorista(req.body ?? {});
    const ator = { papel: 'motorista', id: mot.id };
    res.status(201).json({ token: assinarToken(ator), perfil: sistema.perfil(ator) });
  });

  // ------------------------------------------------------------ autenticado
  app.use('/api', autenticar);

  app.get('/api/me', (req, res) => res.json(sistema.perfil(req.ator)));
  app.get('/api/estado', (req, res) => res.json(sistema.snapshot(req.ator)));

  app.patch('/api/me', exigirPapel('motorista'), (req, res) => {
    sistema.atualizarMotorista(req.ator, req.body ?? {});
    res.json(sistema.perfil(req.ator));
  });

  /** RF02 */
  app.post('/api/caminhoes', exigirPapel('motorista', 'transportadora'), (req, res) => {
    res.status(201).json(sistema.cadastrarCaminhao(req.ator, req.body ?? {}));
  });

  app.get('/api/terminais/:id/janelas', (req, res) => {
    res.json(sistema.janelas(req.params.id, String(req.query.data ?? sistema.hoje())));
  });

  /** RF03 a RF07, RF20 */
  app.post('/api/agendamentos', exigirPapel('motorista', 'transportadora'), (req, res) => {
    res.status(201).json(sistema.serializar(sistema.agendar(req.ator, req.body ?? {})));
  });

  app.get('/api/agendamentos/:id', (req, res) => res.json(sistema.serializar(sistema.acessar(req.ator, req.params.id))));

  app.post('/api/agendamentos/:id/documentos', exigirPapel('motorista', 'transportadora'), (req, res) => {
    const { cifrado, ...doc } = sistema.anexarDocumento(req.ator, req.params.id, req.body ?? {});
    void cifrado;
    res.status(201).json(doc);
  });

  app.get('/api/agendamentos/:id/documentos/:docId', (req, res) => {
    const doc = sistema.lerDocumento(req.ator, req.params.id, req.params.docId);
    res.setHeader('Content-Type', doc.mime);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.nome)}"`);
    res.send(doc.conteudo);
  });

  app.post('/api/agendamentos/:id/iniciar-viagem', exigirPapel('motorista', 'operador'), (req, res) => {
    res.json(sistema.serializar(sistema.iniciarViagem(req.ator, req.params.id, req.body ?? {})));
  });
  app.post('/api/agendamentos/:id/imprevisto', exigirPapel('motorista', 'operador'), (req, res) => {
    res.json(sistema.serializar(sistema.simularImprevisto(req.ator, req.params.id, req.body?.minutos ?? 30)));
  });
  app.post('/api/agendamentos/:id/cancelar', exigirPapel('motorista', 'transportadora'), (req, res) => {
    res.json(sistema.serializar(sistema.cancelar(req.ator, req.params.id)));
  });
  app.post('/api/agendamentos/:id/feedback', exigirPapel('motorista'), (req, res) => {
    res.json(sistema.serializar(sistema.registrarFeedback(req.ator, req.params.id, req.body ?? {})));
  });

  /** RF17 */
  app.post('/api/agendamentos/:id/inicio', exigirPapel('operador'), (req, res) => {
    res.json(sistema.serializar(sistema.registrarInicio(req.ator, req.params.id)));
  });
  app.post('/api/agendamentos/:id/fim', exigirPapel('operador'), (req, res) => {
    res.json(sistema.serializar(sistema.registrarFim(req.ator, req.params.id)));
  });

  /** RF15 */
  app.put('/api/terminal', exigirPapel('operador'), (req, res) => {
    res.json(sistema.terminalPublico(sistema.configurarTerminal(req.ator, req.body ?? {})));
  });

  app.post('/api/notificacoes/lidas', exigirPapel('motorista'), (req, res) => {
    sistema.marcarLidas(req.ator);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ controle da simulação (painel do terminal)
  app.put('/api/simulacao', exigirPapel('operador'), (req, res) => {
    const { velocidade, pausado, avancarMin } = req.body ?? {};
    if (velocidade !== undefined) {
      const v = Number(velocidade);
      if (!Number.isFinite(v) || v < 1 || v > 120) throw new HttpError(400, 'Velocidade de 1 a 120.');
      sistema.relogio.definirVelocidade(v);
    }
    if (pausado !== undefined) sistema.relogio.pausar(Boolean(pausado));
    if (avancarMin !== undefined) {
      const m = Number(avancarMin);
      if (!Number.isFinite(m) || m < 1 || m > 180) throw new HttpError(400, 'Avance de 1 a 180 minutos.');
      sistema.relogio.avancar(m * 60_000);
    }
    sistema.passo();
    sistema.mudou();
    res.json(sistema.relogio.estado());
  });

  app.post('/api/simulacao/reiniciar', exigirPapel('operador'), (_req, res) => {
    if (reiniciar) reiniciar();
    else {
      sistema.relogio.definir(inicioPadrao());
      popular(sistema);
    }
    sistema.mudou();
    res.json(sistema.relogio.estado());
  });

  // ------------------------------------------------------------ tempo real (SSE)
  const clientes = new Set();
  let agendado = null;
  const transmitir = () => {
    agendado = null;
    for (const c of clientes) enviar(c);
  };
  const enviar = (c) => {
    try {
      c.res.write(`event: estado\ndata: ${JSON.stringify(sistema.snapshot(c.ator))}\n\n`);
    } catch (e) {
      c.res.write(`event: erro\ndata: ${JSON.stringify({ erro: e.message })}\n\n`);
    }
  };
  sistema.on('mudou', () => {
    if (!agendado && clientes.size) agendado = setTimeout(transmitir, 300);
  });

  app.get('/api/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    const cliente = { res, ator: req.ator };
    clientes.add(cliente);
    enviar(cliente);
    const batida = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(batida);
      clientes.delete(cliente);
    });
  });

  // ------------------------------------------------------------ erros
  app.use((req, res) => res.status(404).json({ erro: `Rota não encontrada: ${req.method} ${req.path}` }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ erro: err.message, ...err.extra });
    if (err.type === 'entity.too.large') return res.status(413).json({ erro: 'Arquivo grande demais.' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido.' });
    console.error(err);
    res.status(500).json({ erro: 'Erro interno. Tente de novo.' });
  });

  app.locals.clientes = clientes;
  return app;
}
