const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'supersegreto';

function authenticateToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.sendStatus(401);
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

function requireRole(...roles) {
  return [
    authenticateToken,
    (req, res, next) => {
      if (!roles.includes(req.user?.ruolo)) {
        return res.status(403).json({ message: 'Accesso negato' });
      }
      next();
    }
  ];
}

module.exports = { authenticateToken, requireRole };
