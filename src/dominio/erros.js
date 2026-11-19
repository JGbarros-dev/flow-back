export class HttpError extends Error {
  constructor(status, mensagem, extra = {}) {
    super(mensagem);
    this.status = status;
    this.extra = extra;
  }
}

export const naoEncontrado = (o = 'Registro') => new HttpError(404, `${o} não encontrado.`);
export const acessoNegado = () => new HttpError(403, 'Acesso negado: este perfil não pode ver ou alterar esses dados.');
export const invalido = (m, extra) => new HttpError(400, m, extra);
export const conflito = (m, extra) => new HttpError(409, m, extra);
