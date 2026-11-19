// Relógio simulado: a operação do terminal corre mais rápido que o tempo real
// para caber numa demonstração (ex.: velocidade 10 = 1 minuto real vale 10 minutos).

export class Relogio {
  constructor({ inicio, velocidade = 10, pausado = false } = {}) {
    this.base = inicio ?? Date.now();
    this.realBase = Date.now();
    this.velocidade = velocidade;
    this.pausado = pausado;
  }

  agora() {
    if (this.pausado) return Math.round(this.base);
    return Math.round(this.base + (Date.now() - this.realBase) * this.velocidade);
  }

  #rebase() {
    this.base = this.agora();
    this.realBase = Date.now();
  }

  definirVelocidade(velocidade) {
    this.#rebase();
    this.velocidade = velocidade;
  }

  pausar(pausado) {
    this.#rebase();
    this.pausado = pausado;
  }

  /** Avança o relógio manualmente (usado nos testes e no botão "avançar"). */
  avancar(ms) {
    this.#rebase();
    this.base += ms;
  }

  definir(ms) {
    this.base = ms;
    this.realBase = Date.now();
  }

  estado() {
    return { agora: this.agora(), velocidade: this.velocidade, pausado: this.pausado };
  }
}
