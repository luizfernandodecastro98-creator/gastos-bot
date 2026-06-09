const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

// ─── CONFIGURAÇÕES ───────────────────────────────────────
const CLAUDE_API_KEY    = process.env.CLAUDE_API_KEY;
const GRUPO_ID          = process.env.GRUPO_ID;        // ex: 5544999999999-1234567890@g.us
const SPREADSHEET_ID    = process.env.SPREADSHEET_ID;  // ID da sua planilha Google
const SHEET_NAME        = 'Gastos';                    // nome da aba

// ─── AUTENTICAÇÃO GOOGLE ──────────────────────────────────
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// ─── FUNÇÃO: interpretar mensagem com Claude ──────────────
async function interpretarGasto(mensagem) {
  const hoje = new Date().toLocaleDateString('pt-BR');

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Você é um assistente que extrai dados de gastos de mensagens em português.
        
Analise esta mensagem e extraia as informações de gasto.
Se a mensagem NÃO for sobre um gasto ou despesa, retorne: {"gasto": false}
Se for um gasto, retorne SOMENTE JSON válido, sem texto extra:
{
  "gasto": true,
  "data": "data mencionada ou ${hoje} se não houver",
  "categoria": "categoria do gasto (Combustível, Alimentação, Material, Serviço, Outro)",
  "descricao": "descrição breve",
  "valor": número sem R$ ou pontos
}

Mensagem: "${mensagem}"`
      }]
    },
    {
      headers: {
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      }
    }
  );

  const texto = response.data.content[0].text.trim();
  return JSON.parse(texto);
}

// ─── FUNÇÃO: salvar no Google Sheets ─────────────────────
async function salvarNaPlanilha(dados) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:E`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        dados.data,
        dados.categoria,
        dados.descricao,
        dados.valor,
        new Date().toLocaleString('pt-BR')  // timestamp do registro
      ]]
    }
  });
}

// ─── WEBHOOK: recebe mensagens da Evolution API ───────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responde rápido pro webhook não dar timeout

  try {
    const event = req.body;

    // só processa mensagens de texto recebidas
    if (event.event !== 'messages.upsert') return;
    const msg = event.data?.message;
    if (!msg) return;

    const remoteJid = event.data.key?.remoteJid;
    const texto = msg.conversation || msg.extendedTextMessage?.text;

    // só processa o grupo configurado
    if (remoteJid !== GRUPO_ID) return;
    if (!texto) return;

    console.log(`Mensagem recebida: ${texto}`);

    // interpreta com Claude
    const dados = await interpretarGasto(texto);
    if (!dados.gasto) {
      console.log('Mensagem ignorada (não é gasto)');
      return;
    }

    // salva na planilha
    await salvarNaPlanilha(dados);
    console.log(`Gasto salvo: ${dados.descricao} - R$ ${dados.valor}`);

  } catch (err) {
    console.error('Erro:', err.message);
  }
});

app.get('/', (req, res) => res.send('Bot de gastos rodando ✓'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
