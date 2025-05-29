import { google } from 'googleapis';

const sheetsAuth = new google.auth.GoogleAuth({
  keyFile: './service-account.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth: sheetsAuth });

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

  const row = [
    phone,
    address,
    new Date(callTime).toISOString(),
    Array.isArray(tags) ? tags.join(',') : '',
    status,
    summary,
    JSON.stringify(messages),
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID,
    range: 'Sheet1!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
}
