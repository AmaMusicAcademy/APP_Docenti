function getAnnoAccademico(date = new Date()) {
  const y = date.getFullYear();
  const m = date.getMonth() + 1; // 1-12
  return m >= 9 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

module.exports = { getAnnoAccademico };
