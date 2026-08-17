function normalizzaNome(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[''`]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '');
}

function genUsernameFrom(nome, cognome) {
  const n = normalizzaNome(nome);
  const c = normalizzaNome(cognome);
  return `${n}.${c}`;
}

// Genera username unico (nome.cognome, nome.cognome2, nome.cognome3, …)
// excludeAllievoId: se passato, ignora l'utente già associato a quell'allievo
async function genUsernameUnique(nome, cognome, pool, excludeAllievoId = null) {
  const base = genUsernameFrom(nome, cognome);
  let candidate = base;
  let n = 2;
  while (true) {
    const { rows } = await pool.query(
      `SELECT u.id FROM utenti u
       WHERE u.username = $1
         AND ($2::int IS NULL OR u.allievo_id IS DISTINCT FROM $2)`,
      [candidate, excludeAllievoId]
    );
    if (rows.length === 0) return candidate;
    candidate = `${base}${n}`;
    n++;
  }
}

module.exports = { genUsernameFrom, genUsernameUnique };
