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

async function checkTheta(apiToken) {
  if (!apiToken) return { connected: false, reason: 'No token' };
  try {
    const response = await fetch(THETA_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }], stream: false })
    });
    return { connected: response.ok, status: response.status };
  } catch (e) {
    return { connected: false, reason: e.message };
  }
}

module.exports = { chatWithTheta, checkTheta, THETA_ENDPOINT };
