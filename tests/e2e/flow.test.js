const crypto = require('crypto');

// Helpers for native fetch wrapper
const BASE_URL = 'http://localhost/api';

async function fetchAPI(endpoint, options = {}) {
  const url = `${BASE_URL}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const isJson = response.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    throw new Error(`API Error ${response.status} at ${endpoint}: ${JSON.stringify(data)}`);
  }
  return data;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runE2E() {
  console.log('🚀 Starting PulseTrack End-to-End Orchestrator...\n');
  const uniqueId = crypto.randomBytes(4).toString('hex');
  const email = `e2e_${uniqueId}@test.com`;
  const password = 'e2epassword123';

  // 1. Auth: Register
  console.log('1️⃣  Registering User...');
  await fetchAPI('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });

  // 2. Auth: Login
  console.log('2️⃣  Logging in...');
  const loginRes = await fetchAPI('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  const token = loginRes.token;

  // 3. Project Creation
  console.log('3️⃣  Creating Project...');
  const projectRes = await fetchAPI('/auth/projects', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: `E2E Test Project ${uniqueId}` }),
  });
  const projectId = projectRes.project.id;

  // 4. API Key Generation
  console.log('4️⃣  Generating API Key...');
  const keyRes = await fetchAPI(`/auth/projects/${projectId}/keys`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const apiKey = keyRes.apiKey.key;

  // 5. Ingestion: Firing Massive Events
  console.log(`5️⃣  Ingesting 50 Events for Project ${projectId}...`);
  const eventPromises = [];
  for (let i = 0; i < 50; i++) {
    eventPromises.push(
      fetchAPI('/events/ingest', {
        method: 'POST',
        headers: { 'X-API-Key': apiKey },
        body: JSON.stringify({
          project_id: projectId,
          event: i % 2 === 0 ? 'page_view' : 'button_click',
          properties: { source: 'e2e_test', iter: i },
        }),
      })
    );
  }
  await Promise.all(eventPromises);
  console.log('   ✅ Instantly Ingested 50 events (Redis Stream buffered)');

  // 6. Wait for Workers to Process
  console.log('6️⃣  Waiting 3 seconds for background workers to process the Redis queue...');
  await sleep(3000);

  // 7. Query Dashboard Stats
  console.log('7️⃣  Querying Dashboard Statistics...');
  const queryRes = await fetchAPI(`/query/stats/realtime?project_id=${projectId}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  
  const totalEvents = queryRes.total_events || 0;
  console.log(`   ✅ Query Result: ${totalEvents} events processed.`);
  
  if (totalEvents !== 50) {
    console.error(`   ❌ FATAL: Worker dropped events or Lag is too high. Expected 50, got ${totalEvents}`);
    process.exit(1);
  }

  // 8. Generate Report
  console.log('8️⃣  Requesting Async Report Generation...');
  const reportReq = await fetchAPI('/reports/', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      project_id: projectId,
      format: 'csv'
    }),
  });
  const reportId = reportReq.job_id;
  
  console.log('   ✅ Report Queued. Waiting 5 seconds for generation...');
  await sleep(5000);

  // 9. Fetch Report Status
  console.log('9️⃣  Checking Report Status & Pre-signed URL...');
  const reportStatus = await fetchAPI(`/reports/${reportId}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (reportStatus.status !== 'completed') {
    console.error(`   ❌ FATAL: Report did not complete. Status: ${reportStatus.status}`);
    process.exit(1);
  }

  console.log(`   ✅ Report Completed! Download URL generated successfully:`);
  console.log(`   🔗 ${reportStatus.result.downloadUrl.substring(0, 80)}...`);

  console.log('\n🎉 ALL E2E TESTS PASSED SUCCESSFULLY! The flow is pristine.');
}

runE2E().catch(err => {
  console.error('\n🚨 E2E TEST FAILED:', err.message);
  process.exit(1);
});
