import { criarApp } from './app.js';
import { Sistema } from './dominio/sistema.js';
import { Relogio } from './dominio/relogio.js';
import { popular, inicioPadrao } from './dominio/seed.js';
import { hhmm } from './dominio/tempo.js';

const PORTA = Number(process.env.PORT) || 4000;
const VELOCIDADE = Number(process.env.SIM_VELOCIDADE) || 10;

const sistema = new Sistema({ relogio: new Relogio({ inicio: inicioPadrao(), velocidade: VELOCIDADE }) });

function reiniciar() {
  sistema.relogio.definir(inicioPadrao());
  popular(sistema);
}
reiniciar();

const app = criarApp(sistema, { reiniciar });

// Avança a simulação (posição, ETA, check-in, fila e docas) a cada segundo real.
setInterval(() => {
  try {
    // Fim do dia simulado: recomeça às 07:40 para o servidor poder ficar sempre no ar.
    if (hhmm(sistema.agora()) >= '18:30') {
      console.log('Fim do dia simulado: reiniciando a simulação.');
      reiniciar();
    }
    sistema.passo();
  } catch (e) {
    console.error('Erro no passo da simulação:', e);
  }
}, 1000);

app.listen(PORTA, () => {
  console.log(`FlowDock API em http://localhost:${PORTA} (simulação ${VELOCIDADE}x)`);
});
