/* ---------------------------------------------------------------------- */
/*  AI Dialer – Full Server File                                          */
/* ---------------------------------------------------------------------- */

import express from 'express';
import { config } from 'dotenv';
import { OpenAI } from 'openai';
import twilio from 'twilio';
import axios from 'axios';
import util from 'util';
import { logLead } from './logLead.js';

config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* ----------  Clients  ---------- */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);
const pretty = (o) => util.inspect(o, { depth: 4, colors: false });

/* ----------  Conversation store  ---------- */
const conversations = new Map();
const systemPrompt =
  "You're Daniel's AI assistant. A seller has just called in. " +
  "Start the conversation by confirming who they are and asking if they’re open to a cash offer.";

/* ----------  /webhook  ---------- */
app.post('/webhook', async (req, res) => {
  const { CallSid: sid, SpeechResult: speech } = req.body;

  if (!conversations.has(sid))
    conversations.set(sid, [{ role: 'system', content: systemPrompt }]);
  const msgs = conversations.get(sid);
  if (speech) msgs.push({ role: 'user', content: speech });

  let say = "Sorry, I'm having trouble understanding you.";
  try {
    const r = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      messages: msgs,
    });
    const ai = r.choices?.[0]?.message?.content?.trim();
    if (ai) {
      msgs.push({ role: 'assistant', content: ai });
      say = ai;
    }
  } catch (e) {
    console.error('OpenAI error:', e.response?.data || e.message);
  }

  const { VoiceResponse } = twilio.twiml;
  const twiml = new VoiceResponse();
  twiml
    .gather({ input: 'speech', action: '/webhook', method: 'POST' })
    .say({ voice: 'Polly.Matthew' }, say);

  res.type('text/xml').send(twiml.toString());
});

/* ----------  Health check  ---------- */
app.get('/', (_, res) => res.send('🧠 AI Dialer is running'));

/* ----------  /dealsync  ---------- */
app.get('/dealsync', async (req, res) => {
  const maxCalls = parseInt(req.query.limit, 10) || 3;

  /* ✅  DealMachine base URL */
  const dm = axios.create({
    baseURL: 'https://api.dealmachine.com/public/v1',
    headers: {
      Authorization: `Bearer ${process.env.DEALMACHINE_API_KEY}`,
      Accept: 'application/json',
    },
  });

  let page = 1;
  let placed = 0;

  try {
    while (placed < maxCalls) {
      /* 🔑  LIST ENDPOINT */
      const { data: body, status, request } = await dm.get('/properties/', {
        params: {
          'filter[tags]': 'Follow Up Needed',
          include: 'owner,phones,contacts',
          'page[number]': page,
          'page[size]': 100,
        },
      });
      console.log(`🛰️  DM GET ${request.path} → HTTP ${status}`);

      const leads = Array.isArray(body?.data) ? body.data : [];
      if (!leads.length) break;

      console.log(`🔎  Page ${page} → ${leads.length} leads`);

      for (const lead of leads) {
        let phones = lead.attributes.owner?.phones ?? [];
        if (!phones.length && lead.attributes.contacts?.length) {
          const cp = lead.attributes.contacts[0].phone;
          if (cp) phones = [{ number: cp, do_not_call: false }];
        }

        for (const p of phones) {
          if (p.do_not_call) continue;
          if (!p.number?.startsWith('+1')) continue;

          await logLead({
            phone: p.number,
            address: lead.attributes.address || 'Unknown',
            callTime: new Date().toISOString(),
            tags: lead.attributes.tags || [],
            status: 'Not contacted yet',
            summary: '',
            messages: [],
          });

          try {
            await twilioClient.calls.create({
              url: 'https://ai-dialer.onrender.com/webhook',
              to: p.number,
              from: process.env.TWILIO_PHONE_NUMBER,
            });
            console.log('✅ Queued:', p.number);
          } catch (tErr) {
            console.error('❌ Twilio error:', tErr.code, tErr.message);
          }

          if (++placed >= maxCalls) break;
        }
        if (placed >= maxCalls) break;
      }

      page += 1;
    }

    res.send(`✅ Called ${placed} leads`);
  } catch (err) {
    const msg = err.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;
    console.error('❌ dealsync error:', msg);
    res.status(500).send(`Failed to sync leads: ${msg}`);
  }
});

/* ----------  Misc routes  ---------- */
app.post('/log-lead', async (req, res) => {
  try {
    await logLead(req.body);
    res.send('✅ Lead logged');
  } catch {
    res.status(500).send('Failed to log lead');
  }
});
app.get('/test-log', async (_, res) => {
  try {
    await logLead({
      phone: '+12601234567',
      address: '123 Testing St',
      callTime: new Date().toISOString(),
      tags: ['test'],
      status: 'Test',
      summary: 'Testing',
      messages: [{ role: 'assistant', content: 'Hello' }],
    });
    res.send('✅ Test row written');
  } catch {
    res.status(500).send('Sheets write failed');
  }
});

/* Temporary Supabase test route */
app.get('/test-supabase', async (_, res) => {
  try {
    await logLead({
      phone: '+15555550123',
      address: '1 Supabase Way',
      callTime: new Date().toISOString(),
      tags: ['test'],
      status: 'Testing',
      summary: 'Supabase write test',
      messages: [],
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ----------  Start server  ---------- */
const PORT = process.env.PORT || 5050;
app.listen(PORT, () => console.log(`✅ Server listening on ${PORT}`));
