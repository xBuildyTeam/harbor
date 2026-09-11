const THETA_ENDPOINT = 'https://ai.thetaedgecloud.com/api/v1/chatbot/chtz4ssnbcf405uy4e05/chat/completions';

async function chatWithTheta(messages, apiToken) {
  const response = await fetch(THETA_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiToken}`
    },
    body: JSON.stringify({ messages, stream: false })
  });
  if (!response.ok) throw new Error(`Theta API error: ${response.status}`);
  const data = await response.json();
  return { content: data.choices[0].message.content, provider: 'theta' };
}

// STATUS MUST NOT COST MONEY.
// The previous checkTheta() sent a real "ping" chat completion to the chatbot
// endpoint, and dock.js polled it every 15 seconds: 4 inference calls a minute,
// ~5,760 a day, purely to colour a status dot. It only looked free because the
// missing token made it return early - so fixing the token would have switched
// on a silent credit leak. Status is now derived from token presence, and a real
// network probe is opt-in via probeTheta().
function checkTheta(apiToken) {
  if (!apiToken) {
    return Promise.resolve({ connected: false, hasToken: false, reason: 'No token' });
  }
  return Promise.resolve({ connected: null, hasToken: true, reason: 'not_probed' });
}

// Explicit, user-initiated connectivity test. Costs one inference call, so it
// must only ever run from a button press - never from a timer.
async function probeTheta(apiToken) {
  if (!apiToken) return { connected: false, hasToken: false, reason: 'No token' };
  try {
    const response = await fetch(THETA_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }], stream: false })
    });
    return { connected: response.ok, hasToken: true, status: response.status };
  } catch (e) {
    return { connected: false, hasToken: true, reason: e.message };
  }
}

module.exports = { chatWithTheta, checkTheta, probeTheta, THETA_ENDPOINT };
