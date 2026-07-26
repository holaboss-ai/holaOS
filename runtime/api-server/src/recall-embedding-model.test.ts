import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { createRecallEmbeddingModelClient } from './recall-embedding-model.js';

const ORIGINAL_RUNTIME_CONFIG_PATH = process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
const tempDirs: string[] = [];

afterEach(() => {
  if (ORIGINAL_RUNTIME_CONFIG_PATH === undefined) {
    delete process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
  } else {
    process.env.HOLABOSS_RUNTIME_CONFIG_PATH = ORIGINAL_RUNTIME_CONFIG_PATH;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test('createRecallEmbeddingModelClient prefers holaboss embeddings when the proxy is available', () => {
  const root = makeTempDir('hb-recall-embedding-config-');
  const configPath = path.join(root, 'runtime-config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        runtime: {
          background_tasks: {
            provider: 'holaboss_model_proxy',
            model: 'gpt-5.4-mini',
          },
          sandbox_id: 'desktop:test-sandbox',
        },
        providers: {
          holaboss_model_proxy: {
            kind: 'holaboss_proxy',
            api_key: 'hbmk.test-token',
            base_url: 'https://proxy.example/api/v1/model-proxy',
          },
          openai_direct: {
            kind: 'openai_compatible',
            base_url: 'https://api.openai.com/v1',
            api_key: 'sk-test-openai',
          },
        },
        integrations: {
          holaboss: {
            auth_token: 'hbmk.test-token',
            sandbox_id: 'desktop:test-sandbox',
            user_id: 'user-1',
          },
        },
        holaboss: {
          auth_token: 'hbmk.test-token',
          sandbox_id: 'desktop:test-sandbox',
          user_id: 'user-1',
          model_proxy_api_key: 'hbmk.test-token',
          model_proxy_base_url: 'https://proxy.example/api/v1/model-proxy',
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = configPath;

  const client = createRecallEmbeddingModelClient({
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    inputId: 'input-1',
  });

  assert.ok(client);
  assert.equal(client?.baseUrl, 'https://proxy.example/api/v1/model-proxy/openai/v1');
  assert.equal(client?.modelId, 'text-embedding-3-small');
});
