// Thin client for the studio companion proxy endpoints.
//
// Rewritten from the original deepseek-client.js: same request framing, now
// pointed at the studio routes /api/health, /api/chat, /api/memory/compress.
export class LlmClient {
  constructor(basePath = '/api') {
    this.basePath = basePath || '/api';
  }

  setBasePath(basePath) {
    this.basePath = basePath || '/api';
  }

  async checkHealth() {
    const response = await fetch(`${this.basePath}/health`);
    if (!response.ok) {
      throw new Error(`Health check failed: ${response.status}`);
    }
    return response.json();
  }

  async chat(payload) {
    return this.#post('/chat', payload);
  }

  async compress(payload) {
    return this.#post('/memory/compress', payload);
  }

  async #post(path, payload) {
    const response = await fetch(`${this.basePath}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || `Request failed: ${response.status}`);
    }

    return data;
  }
}
