function genUsernameFrom(nome, cognome) {
  const norm = (s) =>
    String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[''`]/g, '')
      .toLowerCase()
      .trim();
  const n = norm(nome);
  const c = norm(cognome).replace(/\s+/g, '');
  return `${n ? n[0] : ''}.${c}`;
}

module.exports = { genUsernameFrom };
