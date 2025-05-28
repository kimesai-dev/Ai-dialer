import express from 'express';
import { config } from 'dotenv';
import { OpenAI } from 'openai';
import twilio from 'twilio';

config();

const app = express();
app.use(express.urlencoded({ extended: true }));

// Optional: for debugging OpenAI POSTs in the future
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const conversations = new Map();

const systemPrompt = "You're Daniel's AI assistant. A seller has just called in. Start the conversation by confirming who they are and asking if they’re open to a cash offer.";

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

// Optional GET route to test if the server is live in browser
app.get('/', (req, res) => {
  res.send('🧠 AI Dialer is running');
});

const PORT = process.env.PORT || 5050;
app.listen(PORT, () => {
  console.log(`✅ Server is listening on port ${PORT}`);
});
