/* eslint-disable no-console */
require('dotenv').config();
const axios = require('axios');

async function main() {
  const baseUrl = process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
  const username = process.env.SITE_USERNAME || 'admin';
  const password = process.env.SITE_PASSWORD || 'admin';
  const limit = Number(process.env.SMOKE_LIMIT || 1);
  const dryRun = process.env.SMOKE_DRY_RUN !== '0';

  const login = await axios.post(`${baseUrl}/api/login`, { username, password }, { validateStatus: () => true });
  if (login.status !== 200) {
    throw new Error(`Login failed (${login.status}): ${JSON.stringify(login.data)}`);
  }

  const cookie = (login.headers['set-cookie'] || []).map((v) => v.split(';')[0]).join('; ');
  const upload = await axios.post(
    `${baseUrl}/api/tiktok/upload-approved`,
    { limit, dryRun },
    {
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      validateStatus: () => true,
      timeout: 10 * 60 * 1000,
    }
  );

  console.log('status:', upload.status);
  console.log(JSON.stringify(upload.data, null, 2));

  if (upload.status >= 400) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

