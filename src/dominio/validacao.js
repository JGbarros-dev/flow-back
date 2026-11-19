import { invalido } from './erros.js';

export const soDigitos = (s) => String(s ?? '').replace(/\D/g, '');

/** Valida CPF pelos dígitos verificadores. */
export function cpfValido(cpf) {
  const d = soDigitos(cpf);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (n) => {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(d[i]) * (n + 1 - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}

/** Gera um CPF válido a partir de 9 dígitos-base (usado nos dados simulados). */
export function gerarCpf(base9) {
  const d = String(base9).padStart(9, '0').slice(0, 9).split('').map(Number);
  for (const n of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += d[i] * (n + 1 - i);
    const r = (soma * 10) % 11;
    d.push(r === 10 ? 0 : r);
  }
  return d.join('');
}

export const mascararCpf = (cpf) => {
  const d = soDigitos(cpf);
  return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
};

export const cnhValida = (cnh) => /^\d{11}$/.test(soDigitos(cnh));

/** Placa antiga (ABC1234) ou Mercosul (ABC1D23). */
export const normalizarPlaca = (p) => String(p ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const placaValida = (p) => /^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(normalizarPlaca(p));

export const rntrcValido = (r) => /^\d{8,9}$/.test(soDigitos(r));

export const dataValida = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '') && !Number.isNaN(Date.parse(s));

export const PORTES = ['Toco', 'Truck', 'Carreta', 'Carreta tanque', 'Bitrem', 'Rodotrem'];

export function exigir(cond, mensagem, campo) {
  if (!cond) throw invalido(mensagem, campo ? { campo } : {});
}

export function texto(valor, campo, { min = 1, max = 120 } = {}) {
  const s = String(valor ?? '').trim();
  exigir(s.length >= min && s.length <= max, `Informe ${campo}.`, campo);
  return s;
}

export function dataOpcional(valor, campo) {
  if (valor === undefined || valor === null || valor === '') return null;
  exigir(dataValida(valor), `${campo}: use o formato AAAA-MM-DD.`, campo);
  return valor;
}
