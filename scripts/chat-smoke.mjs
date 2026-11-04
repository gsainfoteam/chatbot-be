// Local-only smoke run. Uses existing credentials without printing the session token.
const base = new URL(process.env.CHAT_TEST_BASE_URL || 'http://localhost:3000');
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
  throw new Error('CHAT_TEST_BASE_URL must point to a local server.');
}
const question = process.argv
  .slice(2)
  .filter((arg, i) => i !== 0 || arg !== '--')
  .join(' ')
  .trim();
if (!question || question.length > 4000) {
  throw new Error(
    'Usage: bun run test:chat:smoke -- "GIST 관련 질문" (1–4000 characters)',
  );
}
const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
const request = async (path, options = {}) => {
  const response = await fetch(new URL(path, base), {
    ...options,
    signal: abort.signal,
  });
  if (!response.ok)
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response;
};
let token = process.env.CHAT_TEST_SESSION_TOKEN;
if (!token) {
  const widgetKey = process.env.CHAT_TEST_WIDGET_KEY;
  const pageUrl = process.env.CHAT_TEST_PAGE_URL;
  if (!widgetKey || !pageUrl) {
    throw new Error(
      'Set CHAT_TEST_SESSION_TOKEN, or CHAT_TEST_WIDGET_KEY and CHAT_TEST_PAGE_URL.',
    );
  }
  const response = await request('/api/v1/widget/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ widgetKey, pageUrl }),
  });
  token = (await response.json()).sessionToken;
  if (typeof token !== 'string' || !token)
    throw new Error('Missing sessionToken');
}
const headers = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
};
const startedAt = Date.now();
const response = await request('/api/v1/widget/messages/chat/stream', {
  method: 'POST',
  headers,
  body: JSON.stringify({ question }),
});
if (!response.headers.get('content-type')?.includes('text/event-stream')) {
  throw new Error('Expected text/event-stream');
}
let pending = '';
let done = false;
let content = '';
let firstContentMs;
const sources = [];
const consumeLine = (line) => {
  if (!line.startsWith('data:')) return;
  const data = line.slice(5).trim();
  if (data === '[DONE]') {
    done = true;
    return;
  }
  if (!data) return;
  const event = JSON.parse(data);
  if (event.error) throw new Error(`SSE: ${event.error}`);
  if (event.type === 'step') console.log(`[${event.status}] ${event.label}`);
  if (typeof event.content === 'string') {
    firstContentMs ??= Date.now() - startedAt;
    content += event.content;
  }
  if (['sources', 'web_sources', 'resources'].includes(event.type))
    sources.push(event);
};
try {
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    pending += chunk.value;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) consumeLine(line);
  }
  if (pending) consumeLine(pending);
  if (!done) throw new Error('Stream ended without [DONE]');
  console.log('\n' + content);
  console.log(
    JSON.stringify(
      { firstContentMs, totalMs: Date.now() - startedAt, sources },
      null,
      2,
    ),
  );
  const history = await (
    await request('/api/v1/widget/messages?limit=2', { headers })
  ).json();
  const answer = history.messages?.find(
    (message) => message.role === 'assistant',
  );
  console.log(
    'Saved evaluation:',
    JSON.stringify(answer?.metadata?.evaluation ?? null, null, 2),
  );
} finally {
  abort.abort();
}
