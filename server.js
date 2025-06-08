const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/api/test', (req, res) => {
  res.json({ message: 'API funzionante!' });
});

app.listen(PORT, () => {
  console.log(`Server in ascolto sulla porta ${PORT}`);
});


// rotta per testare la connessione a MySQL
app.get('/api/dbtest', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1 + 1 AS solution');
    res.json({ dbResult: rows[0].solution });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server in ascolto sulla porta ${PORT}`);
});
