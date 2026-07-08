import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import neotalkRouter from './routes/neotalk.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT ?? 3000);

app.use(express.json({ limit: '32kb' }));
app.use('/api/neotalk', neotalkRouter);
app.use('/plugin', express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.listen(port, () => {
  console.log(`NeoTalk plugin server running on port ${port}`);
});
