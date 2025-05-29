import express from 'express';
import { config } from 'dotenv';
import { OpenAI } from 'openai';
import twilio from 'twilio';
import axios from 'axios';
import { google } from 'googleapis';

config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const conversations = new Map();

// Google Sheets setup
const sheetsAuth = new google.auth.GoogleAuth({
  keyFile: './service-account.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth: sheetsAuth });

const systemPrompt =
  "You're Daniel's AI assistant. A seller has just called in. Start the conversation by confirming who they are and asking if they’re open to a cash offer.";

// === AI Webhook ===
app.post('/webhook', async (req, res) => {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult;

  console.log(`📞 Incoming call from CallSid: ${callSid}`);
  console.log(`🗣️ SpeechResult: ${speechResult}`);

  if (!conversations.has(callSid)) {
    conversations.set(callSid, [{ role: 'system', content: systemPrompt }]);
  }

  const messages = conversations.get(callSid);

  if (speechResult) {
    messages.push({ role: 'user', content: speechResult });
  }

  let sayText = "Sorry, I'm having trouble.";

  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      messages,
    });

    console.log('🤖 OpenAI response:', JSON.stringify(response, null, 2));

    const aiMessage = response.choices?.[0]?.message?.content?.trim();
    if (aiMessage) {
      messages.push({ role: 'assistant', content: aiMessage });
      sayText = aiMessage;
    }
  } catch (err) {
    console.error('❌ OpenAI error:', err.response?.data || err.message || err);
  }

  const { VoiceResponse } = twilio.twiml;
  const twiml = new VoiceResponse();
  const gather = twiml.gather({ input: 'speech', action: '/webhook', method: 'POST' });
  gather.say({ voice: 'Polly.Matthew' }, sayText);

  res.type('text/xml');
  res.send(twiml.toString());
});

// === Root Test Route ===
app.get('/', (req, res) => {
  res.send('🧠 AI Dialer is running');
});

// === DealMachine Sync & Call Route ===
app.get('/dealsync', async (req, res) => {
  const { limit = 5 } = req.query;
  const maxCalls = parseInt(limit, 10) || 5;

  try {
    const response = await axios.get('https://api.dealmachine.com/api/v1/properties', {
      headers: {
        Authorization: `Bearer ${process.env.DEALMACHINE_API_KEY}`,
      },
    });

    const leads = response.data?.data || [];
    console.log('🔍 Raw DealMachine leads:', JSON.stringify(leads.slice(0, 3), null, 2));

    let count = 0;

    for (const lead of leads) {
      const phone = lead.attributes?.owner_phone;

      if (!phone || !phone.startsWith('+1')) continue;

      console.log(`📞 Calling: ${phone}`);

      try {
        await logLead({
          phone,
          address: lead.attributes?.address,
          callTime: new Date().toISOString(),
          tags: lead.attributes?.tags || [],
          status: 'Not contacted yet',
          summary: '',
          messages: [],
        });
      } catch (err) {
        console.error('❌ Failed to log lead:', err.response?.data || err.message || err);
      }

      await twilioClient.calls.create({
        url: 'https://ai-dialer.onrender.com/webhook',
        to: phone,
        from: process.env.TWILIO_PHONE_NUMBER,
      });

      count++;
      if (count >= maxCalls) break;
    }

    res.send(`✅ Called ${count} DealMachine leads`);
  } catch (err) {
    console.error('❌ DealMachine sync failed:', err.response?.data || err.message);
    res.status(500).send('Failed to sync leads');
  }
});

// === Lead Logging Helper ===
export async function logLead(data) {
  const {
    phone = '',
    address = '',
    status = '',
    summary = '',
    tags = [],
    callTime = new Date().toISOString(),
    messages = [],
  } = data || {};

  const row = [
    phone,
    address,
    status,
    summary,
    Array.isArray(tags) ? tags.join(',') : '',
    new Date(callTime).toISOString(),
    JSON.stringify(messages),
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID,
    range: 'Sheet1!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
}

// === Log Lead Route ===
app.post('/log-lead', async (req, res) => {
  try {
    await logLead(req.body);
    res.send('✅ Lead logged');
  } catch (err) {
    console.error('❌ Failed to log lead:', err.response?.data || err.message || err);
    res.status(500).send('Failed to log lead');
  }
});

// === Start Server ===
const PORT = process.env.PORT || 5050;
app.listen(PORT, () => {
  console.log(`✅ Server is listening on port ${PORT}`);
});
