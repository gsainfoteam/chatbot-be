/**
 * Explicit, billable smoke test. Only a synthetic image is sent; no DB writes.
 * Run: bun src/scripts/platform-vision-smoke.ts
 */
import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import sharp from 'sharp';
import { LetsurLlmService } from '../chat/llm/letsur-llm.service';
import { PLATFORM_IMAGE_PROMPT } from '../platform-chat/platform-prompts';
import { parseImageAnalysis } from '../platform-chat/platform-chat.service';
import { assertSecureEndpoint } from '../embedding/embedding-endpoint';
import type { LlmRequestMessage } from '../chat/types/llm.types';

async function main() {
  if ((process.env.LLM_PROVIDER || 'letsur') !== 'letsur')
    throw new Error('This check targets Letsur only');
  assertSecureEndpoint(process.env.LETSUR_AI_GATEWAY_BASE_URL ?? '', 'Letsur');
  const client = new LetsurLlmService(
    new HttpService(),
    new ConfigService(process.env),
  );
  const model = client.getModel('heavy');
  const marker = 'VISION_CHECK_4812';
  const png = await sharp(
    Buffer.from(
      '<svg width="1000" height="360" xmlns="http://www.w3.org/2000/svg">' +
        '<rect width="100%" height="100%" fill="white"/>' +
        '<text x="40" y="80" font-size="36">GIST scholarship notice - TEST ONLY</text>' +
        '<text x="40" y="160" font-size="48">' +
        marker +
        '</text>' +
        '<text x="40" y="230" font-size="30">This is a synthetic integration test.</text></svg>',
    ),
  )
    .png()
    .toBuffer();
  const messages: LlmRequestMessage[] = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: '이 테스트용 GIST 안내 이미지의 내용을 설명하고 식별 코드를 정확히 읽어 주세요.',
        },
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,' + png.toString('base64') },
        },
      ],
    },
  ];
  const analysis = await client.callLLM(
    [{ role: 'system', content: PLATFORM_IMAGE_PROMPT }, ...messages],
    model,
    { max_tokens: 8000, timeoutMs: 60000, temperature: 0 },
  );
  const parsed = parseImageAnalysis(analysis.choices[0]?.message.content ?? '');
  if (!parsed.summary.includes(marker))
    throw new Error('The model did not read the image marker');
  const stream = await client.generateFinalResponseStream(messages, [], model, {
    max_tokens: 8000,
    timeoutMs: 60000,
    temperature: 0,
  });
  let buffer = '';
  let text = '';
  let done = false;
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        done = true;
        continue;
      }
      if (!data) continue;
      const event = JSON.parse(data);
      if (event.error) throw new Error('Provider returned a streaming error');
      text += event.choices?.[0]?.delta?.content ?? '';
    }
  }
  if (!done || !text.includes(marker))
    throw new Error('Vision streaming check failed');
  console.log(
    JSON.stringify({
      model,
      imageAnalysis: 'passed',
      imageStreaming: 'passed',
      databaseWrites: false,
    }),
  );
}

main().catch(() => {
  // Provider logs redact inline images. Do not dump request/config objects here.
  console.error(
    'Platform Vision smoke check failed. Check the selected heavy model and gateway access.',
  );
  process.exitCode = 1;
});
