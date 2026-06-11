const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const { google } = require('googleapis');
const express = require('express');

const app = express();
app.use(express.json());
app.get('/', (req, res) => res.send('Bot rodando ✓'));
app.listen(process.env.PORT || 3000);

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const GRUPO_ID       = process.env.GRUPO_ID;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME     = 'Gastos';

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

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
  return JSON.parse(response.data.content[0].text.trim());
}

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
        new Date().toLocaleString('pt-BR')
      ]]
    }
  });
  console.log(`Salvo: ${dados.descricao} - R$ ${dados.valor}`);
}

async function conectarWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\nEscaneie o QR Code abaixo com o WhatsApp:\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const deveReconectar = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (deveReconectar) {
        setTimeout(conectarWhatsApp, 5000);
      } else {
        console.log('Desconectado. Faça login novamente.');
      }
    }
    if (connection === 'open') {
      console.log('WhatsApp conectado!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue;
      if (msg.key.remoteJid !== GRUPO_ID) continue;
      if (msg.key.fromMe) continue;

      const texto =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text;

      if (!texto) continue;

      console.log(`Mensagem recebida: ${texto}`);

      try {
        const dados = await interpretarGasto(texto);
        if (!dados.gasto) {
          console.log('Ignorada (nao e gasto)');
          continue;
        }
        await salvarNaPlanilha(dados);
      } catch (err) {
        console.error('Erro:', err.message);
      }
    }
  });
}

conectarWhatsApp();
