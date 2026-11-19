// Datas e horários no fuso de Suape (America/Recife, UTC-3, sem horário de verão).
// Internamente todo horário é um timestamp em milissegundos.

export const MIN = 60_000;
const OFFSET = 3 * 60 * MIN;

/** 'AAAA-MM-DD' no fuso local. */
export const dataLocal = (ms) => new Date(ms - OFFSET).toISOString().slice(0, 10);

/** 'HH:MM' no fuso local. */
export const hhmm = (ms) => new Date(ms - OFFSET).toISOString().slice(11, 16);

/** Meia-noite local da data 'AAAA-MM-DD'. */
export const inicioDoDia = (data) => Date.parse(`${data}T00:00:00-03:00`);

/** 'HH:MM' → minutos desde a meia-noite. */
export const minutos = (rotulo) => {
  const [h, m] = rotulo.split(':').map(Number);
  return h * 60 + m;
};

/** Timestamp da data local às HH:MM. */
export const emHorario = (data, rotulo) => inicioDoDia(data) + minutos(rotulo) * MIN;

/** 'AAAA-MM-DD' → 'DD/MM/AAAA'. */
export const dataBr = (iso) => iso.split('-').reverse().join('/');

/** Soma dias a uma data 'AAAA-MM-DD'. */
export const somarDias = (data, dias) => dataLocal(inicioDoDia(data) + 12 * 60 * MIN + dias * 24 * 60 * MIN);
