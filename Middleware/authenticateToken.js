const jwt = require('jsonwebtoken');
const JWT_SECRET = 'supersegreto'; // In produzione usa una variabile d'ambiente

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // formato: Bearer <token>

  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403); // token scaduto o invalido
    req.user = user; // { id, ruolo }
    next();
  });
}

module.exports = authenticateToken;
