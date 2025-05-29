/* ---------------------------------------------------------------------- */
/*  AI Dialer – Full Server File                                          */
/*  Requires:                                                             */
/*    - OPENAI_API_KEY                                                    */
/*    - OPENAI_MODEL        (optional, default = gpt-4o)                  */
/*    - DEALMACHINE_API_KEY                                               */
/*    - TWILIO_ACCOUNT_SID                                                */
/*    - TWILIO_AUTH_TOKEN                                                 */
/*    - TWILIO_PHONE_NUMBER                                               */
/* ---------------------------------------------------------------------- */

import express from 'express';
import { config } from 'dotenv';
import { OpenAI } from 'openai';
import twilio from 'twilio';
import axios from 'axios';
import { logLead } from './logLead.js';   // 📝  your Google-Sheets helper

config();                                  // loads .env

/* ----------  Express setup  ---------- */

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* ----------  OpenAI & Twilio clients  ---------- */

const openai       = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);

/* ----------  In-memory conversation store  ---------- */

const conversations = new Map();
const systemPrompt =
  "You're Daniel's AI assistant. A seller has just called in. " +
  "Start the conversation by confirming who they are and asking if they’re open to a cash offer.";

/* ---------------------------------------------------------------------- */
/*  /webhook  – Twilio <Gather> POST back                                 */
/* ---------------------------------------------------------------------- */
app.post('/webhook', async (req, res) => {
  const { CallSid: callSid, SpeechResult: speechResult } = req.body;

  console.log(`📞  Incoming call  | CallSid: ${callSid}`);
  console.log(`🗣️   Caller said   | ${speechResult}`);

  if (!conversations.has(callSid)) {
    conversations.set(callSid, [{ role: 'system', content: systemPrompt }]);
  }
  const messages = conversations.get(callSid);

  if (speechResult) {
    messages.push({ role: 'user', content: speechResult });
  }

  /* ----  Ask OpenAI what to say next  ---- */
  let sayText = "Sorry, I'm having trouble understanding you.";

  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      messages,
    });

    const aiMessage = response.choices?.[0]?.message?.content?.trim();
    if (aiMessage) {
      messages.push({ role: 'assistant', content: aiMessage });
      sayText = aiMessage;
    }
  } catch (err) {
    console.error('❌ OpenAI error:', err.response?.data || err.message || err);
  }

  /* ----  Build TwiML and respond  ---- */
  const { VoiceResponse } = twilio.twiml;
  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    input: 'speech',
    action: '/webhook',
    method: 'POST',
  });
  gather.say({ voice: 'Polly.Matthew' }, sayText);

  res.type('text/xml');
  res.send(twiml.toString());
});

/* ---------------------------------------------------------------------- */
/*  Root route for quick uptime checks                                    */
/* ---------------------------------------------------------------------- */
app.get('/', (_req, res) => {
  res.send('🧠 AI Dialer is running');
});

/* ---------------------------------------------------------------------- */
/*  /dealsync  – Pull leads & autodial                                    */
/*    Query param ?limit=N  caps calls per run (default 3)                */
/* ---------------------------------------------------------------------- */
app.get('/dealsync', async (req, res) => {
  const maxCalls = parseInt(req.query.limit, 10) || 3;

  /* ---  Axios instance that points at DealMachine  --- */
  const dm = axios.create({
    baseURL: 'https://api.dealmachine.com/api/v1',
    headers: {
      Authorization: `Bearer ${process.env.DEALMACHINE_API_KEY}`,
      Accept: 'application/json',
    },
  });

  let page = 1;
  let placedCalls = 0;

  try {
    while (placedCalls < maxCalls) {
      const { data } = await dm.get('/leads', {
        params: {
          'filter[tags]': 'Follow Up Needed',
          include: 'owner,phones',
          'page[number]': page,
          'page[size]': 100,
        },
      });

      const leads = data.data;
      if (leads.length === 0) break;             // no more pages

      for (const lead of leads) {
        const phones = lead.attributes.owner?.phones ?? [];

        for (const p of phones) {
          if (p.do_not_call) continue;           // respect DNC
          if (!p.number || !p.number.startsWith('+1')) continue;

          console.log(`📞 Calling: ${p.number}`);

          /* -- Optional Google-Sheets log -- */
          await logLead({
            phone:   p.number,
            address: lead.attributes.address || 'Unknown',
            callTime: new Date().toISOString(),
            tags:    lead.attributes.tags || [],
            status:  'Not contacted yet',
            summary: '',
            messages: [],
          });

          /* -- Launch outbound call with Twilio -- */
          await twilioClient.calls.create({
            url:  'https://ai-dialer.onrender.com/webhook',   // public HTTPS URL
            to:   p.number,
            from: process.env.TWILIO_PHONE_NUMBER,
          });

          placedCalls += 1;
          if (placedCalls >= maxCalls) break;
        }
        if (placedCalls >= maxCalls) break;
      }

      page += 1;                                   // next DealMachine page
    }

    console.log(`✅ Called ${placedCalls} leads`);
    res.send(`✅ Called ${placedCalls} leads`);
  } catch (err) {
    console.error('❌ dealsync error:', err.response?.data || err.message);
    res.status(500).send('Failed to sync leads');
  }
});

/* ---------------------------------------------------------------------- */
/*  /log-lead – called by client code to push final notes to Sheets        */
/* ---------------------------------------------------------------------- */
app.post('/log-lead', async (req, res) => {
  try {
    await logLead(req.body);
    res.send('✅ Lead logged');
  } catch (err) {
    console.error('❌ Failed to log lead:', err.response?.data || err.message);
    res.status(500).send('Failed to log lead');
  }
});

/* ---------------------------------------------------------------------- */
/*  /test-log – sanity check your Google-Sheets helper                     */
/* ---------------------------------------------------------------------- */
app.get('/test-log', async (_req, res) => {
  try {
    await logLead({
      phone: '+12601234567',
      address: '123 Testing St',
      callTime: new Date().toISOString(),
      tags: ['test'],
      status: 'Test',
      summary: 'Testing Sheets logging',
      messages: [{ role: 'assistant', content: 'Hello from AI' }],
    });
    res.send('✅ Test row written to Google Sheet');
  } catch (err) {
    console.error('❌ Test log failed:', err.message);
    res.status(500).send('Failed to log test lead');
  }
});

/* ---------------------------------------------------------------------- */
/*  Start server                                                          */
/* ---------------------------------------------------------------------- */
const PORT = process.env.PORT || 5050;
app.listen(PORT, () => {
  console.log(`✅ Server is listening on port ${PORT}`);
});
