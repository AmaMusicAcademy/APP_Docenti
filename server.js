const express = require('express');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Endpoint di test
app.get('/api/test', (req, res) => {
  res.json({ message: 'API funzionante!' });
});



// Avvio server
app.listen(PORT, () => {
  console.log(`Server in ascolto sulla porta ${PORT}`);
});
