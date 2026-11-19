# FlowDock · API (flow-back)

API em Node.js do MVP do FlowDock. Concentra o motor de fila dinâmica (a evolução da PoC `fila_dinamica.js`), as regras de negócio, a simulação da rota e do ETA dos caminhões, e a transmissão em tempo real para o app do motorista, o painel do terminal e a área da transportadora.

## Rodar localmente

```bash
npm install
npm run dev      # http://localhost:4000, reinicia ao salvar
npm test         # 15 testes: cenários da PoC + histórias US01 a US08
```

Requer Node.js 20 ou superior. As dependências são só `express` e `cors`.

## Deploy no Railway

1. Crie um serviço a partir do repositório e defina **Root Directory = `flow-back`**.
2. O Railway detecta o Node e roda `npm install` e depois `npm start`. A porta vem de `PORT`, que o próprio Railway define.
3. Variáveis de ambiente (veja `.env.example`):

| Variável | Para quê |
| --- | --- |
| `TOKEN_SECRET` | Assina os tokens de sessão. **Defina em produção.** |
| `DOC_KEY` | Chave AES-256-GCM que cifra os documentos fiscais. **Defina em produção.** |
| `CORS_ORIGIN` | URL do frontend (ex.: `https://flowdock.vercel.app`). Sem valor, aceita qualquer origem. |
| `SIM_VELOCIDADE` | Velocidade inicial da simulação (padrão 10x). |

4. Em **Settings → Networking**, gere um domínio público. É ele que vai em `NEXT_PUBLIC_API_URL` no frontend.

Os dados ficam em memória: cada reinício do serviço volta ao início do dia simulado (07:40). Isso é intencional neste MVP, porque o banco de dados está no quadrante Won't do MoSCoW. Ao passar das 18:30 simuladas, o dia recomeça sozinho.

## Como funciona

- **Relógio simulado** (`src/dominio/relogio.js`): a operação corre 10x mais rápido que o tempo real (ajustável no painel do terminal), para um dia de operação caber numa apresentação.
- **Simulação** (`Sistema.passo`, uma vez por segundo real): cada caminhão em rota avança pela sua rota (`src/dominio/geo.js`) e o ETA é recalculado a cada 60 segundos da operação (RF09). Ao entrar no raio de 2 km do terminal, o check-in é automático (RF08). Quando uma doca fica livre, o próximo da fila é autorizado e o motorista recebe o aviso (RF13).
- **Motor de fila** (`src/dominio/fila.js`): funções puras portadas da PoC, com várias docas. Quem chega até a tolerância depois da janela tem prioridade, na ordem da janela (RN06). Os atrasados vêm depois, pela ordem do ETA (RN03, RF10). O motor também produz a posição (RF11), a previsão de chamada (RF12) e a comparação com a agenda estática.
- **Motivo da mudança** (RF19): a cada recálculo, o sistema compara a ordem nova com a anterior e explica ao motorista por que a posição dele mudou.

## Rastreabilidade dos requisitos

| Requisito | Onde |
| --- | --- |
| RF01, RF02 | `POST /api/auth/cadastro`, `POST /api/caminhoes` (CPF, CNH, placa e RNTRC validados) |
| RF03, RF04, RN02 | `GET /api/terminais/:id/janelas`, `POST /api/agendamentos` (recusa janela cheia com 409) |
| RF05, RNF03 | `POST /api/agendamentos/:id/documentos` (AES-256-GCM em repouso) |
| RF06, RF07, RN01 | `Sistema.agendar` (422 informando qual documento está vencido) e nova checagem na autorização (RN05) |
| RF08, RF09, RF10, RN03 | `Sistema.passo`, `#mover`, `#atualizarEta`, `recalcular` |
| RF11, RF12, RF19, RN06 | `Sistema.recalcular`, `#registrarMudanca`, `fila.js` |
| RF13, RF20 | `Sistema.notificar` (aviso no app + notificação do celular pelo PWA) |
| RF14, RF15, RF17 | `GET /api/estado` (perfil operador), `PUT /api/terminal`, `POST /api/agendamentos/:id/inicio` e `/fim` |
| RF16 | `GET /api/estado` (perfil transportadora) |
| RF18, RF21 | `horarios` de cada agendamento; histórico separado no app |
| RNF02 | teste com 2.000 veículos planejados em menos de 1 s |
| RNF04 | token assinado + `Sistema.podeVer`: 403 para dados de outro perfil (testado) |
| RNF10 | `npm test` (regressão de agendamento, check-in e avisos) |
| Feedback (item novo da Quest #6) | `POST /api/agendamentos/:id/feedback` |

## Principais rotas

`POST /api/auth/login` · `GET /api/stream?token=` (SSE com a visão do perfil) · `GET /api/estado` · `POST /api/agendamentos/:id/iniciar-viagem` · `POST /api/agendamentos/:id/imprevisto` (demonstração) · `PUT /api/simulacao` (velocidade, pausa, avançar) · `POST /api/simulacao/reiniciar`.

## Contas de demonstração

| Perfil | Login | Senha |
| --- | --- | --- |
| Motorista (Carlos Mendes) | CPF 529.982.247-25 | 1234 |
| Terminal (Renata Albuquerque) | renata@terminal.demo | flowdock |
| Transportadora (TransNordeste) | despacho@transnordeste.demo | flowdock |

Todos os nomes, placas, CPFs e empresas são fictícios.
