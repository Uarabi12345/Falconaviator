import 'dotenv/config';
import express from 'express';

const app = express();
const PORT = process.env.PORT || 4000;

app.get('/', (req, res) => {
  res.send('<h1>Message is live</h1>');
});

app.listen(PORT, () => {
  console.log(`Wallet listening on http://localhost:${PORT}`);
});