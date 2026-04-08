import http from 'k6/http';
import { check, sleep } from 'k6';
import { randomString, randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';

export let options = {
  stages: [
    { duration: '30s', target: 50 },  // Ramp-up to 50 users
    { duration: '1m', target: 50 },   // Sustain 50 users (expected ~1,000-2,000 RPS depending on latency)
    { duration: '30s', target: 100 }, // Spike to 100 users
    { duration: '30s', target: 0 },   // Ramp-down
  ],
  thresholds: {
    // 99% of requests must finish within 150ms.
    http_req_duration: ['p(99)<150'],
    // Less than 1% of errors allowed
    http_req_failed: ['rate<0.01'],   
  },
};

const PROJECT_ID = 2; // Test project ID
const API_KEY = __ENV.API_KEY || 'pk_223e6fc43f8641c5b7b8243b74aad4a5'; // Use env var or fallback

// Use local host directly hitting nginx
const BASE_URL = 'http://host.docker.internal/api/events/ingest';

export default function () {
  const payload = JSON.stringify({
    project_id: PROJECT_ID,
    event: 'page_view',
    properties: {
      url: `https://example.com/${randomString(5)}`,
      user_agent: 'k6-load-test',
      session_id: randomIntBetween(1, 100000)
    }
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
    },
  };

  let res = http.post(BASE_URL, payload, params);

  // Validate that ingest accepts it. It should return 202.
  check(res, {
    'status is 202': (r) => r.status === 202,
  });

  // Short sleep to prevent completely saturating local machine network stack 
  // (0.01s = 10ms = ~100 requests per second per VU)
  sleep(0.01); 
}
