import supabase from './supabaseClient.js';

export async function logLead(data = {}) {
  const {
    phone = '',
    address = '',
    callTime = new Date().toISOString(),
    tags = [],
    status = '',
    summary = '',
    messages = [],
  } = data;

  try {
    const { error } = await supabase.from('leads').insert({
      phone,
      address,
      call_time: new Date(callTime).toISOString(),
      tags,
      status,
      summary,
      messages,
    });
    if (error) throw error;
  } catch (err) {
    console.error('Supabase insert error:', err.message || err);
    throw err;
  }
}
