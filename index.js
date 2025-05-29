import express from 'express';
import { config } from 'dotenv';
import { OpenAI } from 'openai';
import twilio from 'twilio';
import axios from 'axios';
import { logLead } from './logLead.js';

config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const conversations = new Map();

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
  const maxCalls = parseInt(req.query.limit, 10) || 3;

  try {
    const response = await axios.get(
      'https://api.dealmachine.com/api/v1/properties',
      {
        headers: { Authorization: `Bearer ${process.env.DEALMACHINE_API_KEY}` },
        params: { tag: 'Follow Up Needed' },
      }
    );

    const leads = response.data?.data || [];
    let count = 0;

    for (const lead of leads) {
      const phone =
        lead.attributes?.owner_phone ||
        lead.attributes?.contacts?.[0]?.phone ||
        lead.attributes?.skip_traced_phones?.[0]?.number ||
        null;

      if (!phone || !phone.startsWith('+1')) continue;

      console.log(`📞 Calling: ${phone}`);

      try {
        await logLead({
          phone,
          address: lead.attributes?.address || 'Unknown',
          callTime: new Date().toISOString(),
          tags: lead.attributes?.tags || [],
          status: 'Not contacted yet',
          summary: '',
          messages: [],
        });
      } catch (err) {
        console.error(err.message);
      }

      await twilioClient.calls.create({
        url: 'https://ai-dialer.onrender.com/webhook',
        to: phone,
        from: process.env.TWILIO_PHONE_NUMBER,
      });

      count++;
      if (count >= maxCalls) break;
    }

    console.log(`✅ Called ${count} leads`);
    res.send(`✅ Called ${count} leads`);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Failed to sync leads');
  }
});

// === Lead Logging API Route ===
app.post('/log-lead', async (req, res) => {
  try {
    await logLead(req.body);
    res.send('✅ Lead logged');
  } catch (err) {
    console.error('❌ Failed to log lead:', err.response?.data || err.message || err);
    res.status(500).send('Failed to log lead');
  }
});
// === Test Google Sheets Logging ===
app.get('/test-log', async (req, res) => {
  try {
    await logLead({
      phone: '+12601234567',
      address: '123 Testing St',
      callTime: new Date().toISOString(),
      tags: ['test'],
      status: 'Test',
      summary: 'Testing Sheets logging',
      messages: [{ role: 'assistant', content: 'Hello from AI' }]
    });

    res.send('✅ Test row written to Google Sheet');
  } catch (err) {
    console.error('❌ Test log failed:', err.message);
    res.status(500).send('Failed to log test lead');
  }
});

// === Start Server ===
const PORT = process.env.PORT || 5050;
app.listen(PORT, () => {
  console.log(`✅ Server is listening on port ${PORT}`);
});
