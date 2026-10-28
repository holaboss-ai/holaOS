import assert from "node:assert/strict";
import test from "node:test";

import {
  isLocalModelEndpoint,
  withDefaultHttpScheme,
  withLocalContextGuidance,
} from "./local-model-endpoint.js";

test("isLocalModelEndpoint recognizes loopback, LAN and local hostnames", () => {
  for (const baseUrl of [
    "http://localhost:8080",
    "http://LOCALHOST:1234/v1/",
    "http://lmstudio.localhost/v1",
    "http://127.0.0.1:11434/v1",
    "http://127.10.20.30",
    "http://[::1]:8000/v1",
    "http://0.0.0.0:30000/v1",
    "http://host.docker.internal:11434",
    "http://mac-studio.local:1234/v1",
    "http://10.0.0.5:8000/v1",
    "http://172.16.0.1/v1",
    "http://172.31.255.254/v1",
    "http://192.168.1.20:1234/v1",
    "http://169.254.10.10:8080",
    "https://192.168.1.20/v1",
  ]) {
    assert.equal(isLocalModelEndpoint(baseUrl), true, baseUrl);
  }
});

test("isLocalModelEndpoint accepts base URLs without a scheme", () => {
  assert.equal(isLocalModelEndpoint("localhost:8080"), true);
  assert.equal(isLocalModelEndpoint("127.0.0.1:1234/v1"), true);
  assert.equal(isLocalModelEndpoint("[::1]:8080"), true);
  assert.equal(isLocalModelEndpoint("api.openai.com/v1"), false);
});

test("isLocalModelEndpoint rejects public hosts, near-miss ranges and invalid input", () => {
  for (const baseUrl of [
    "https://api.openai.com/v1",
    "https://openrouter.ai/api/v1",
    "https://localhost.example.com/v1",
    "https://example.local.dev/v1",
    "http://172.15.0.1/v1",
    "http://172.32.0.1/v1",
    "http://192.169.1.1/v1",
    "http://8.8.8.8/v1",
    "http://[2001:db8::1]/v1",
    "http://",
    "not a url",
    "",
    "   ",
    null,
    undefined,
  ]) {
    assert.equal(isLocalModelEndpoint(baseUrl), false, String(baseUrl));
  }
});

test("withDefaultHttpScheme only prefixes scheme-less URLs", () => {
  assert.equal(withDefaultHttpScheme("localhost:8080"), "http://localhost:8080");
  assert.equal(withDefaultHttpScheme(" https://host/v1 "), "https://host/v1");
  assert.equal(withDefaultHttpScheme(""), "");
});

test("context overflow errors from local providers get guidance; others are untouched", () => {
  const llama = "400 request (13537 tokens) exceeds the available context size (8192 tokens), try increasing it";
  const guided = withLocalContextGuidance(llama, "local_llamacpp_1234");
  assert.ok(guided.startsWith(llama));
  assert.match(guided, /-c 32768/);
  assert.match(withLocalContextGuidance("This model's maximum context length is 4096 tokens", "local_vllm"), /max-model-len/);
  assert.equal(withLocalContextGuidance(llama, "openai"), llama);
  assert.equal(withLocalContextGuidance("401 unauthorized", "local_ollama"), "401 unauthorized");
});

test("an overflow on an already large context suggests a new chat instead of -c 32768", () => {
  const grown = "400 request (36764 tokens) exceeds the available context size (32768 tokens), try increasing it";
  const guided = withLocalContextGuidance(grown, "local_llamacpp_1234");
  assert.match(guided, /grown past the 32,768-token context/);
  assert.match(guided, /Start a new chat/);
  assert.doesNotMatch(guided, /-c 32768/);
});
