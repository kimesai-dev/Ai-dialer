import express from 'express';
import { config } from 'dotenv';
import { OpenAI } from 'openai';

config();

const app = express();
app.use(express.urlencoded({ extended: true }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post('/webhook', async (req, res) => {
  const prompt = `You're Daniel's AI assistant. A seller has just called in. Start the conversation by confirming who they are and asking if they’re open to a cash offer.`;

  const response = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
  });

  const say = response.choices?.[0]?.message?.content || "Sorry, I'm having trouble.";

  res.set('Content-Type', 'text/xml');
  res.send(`
    <Response>
      <Say voice="Polly.Matthew">${say}</Say>
    </Response>
  `);
});

const PORT = process.env.PORT || 5050;
app.listen(PORT, () => {
  console.log(`✅ Server is listening on port ${PORT}`);
});
