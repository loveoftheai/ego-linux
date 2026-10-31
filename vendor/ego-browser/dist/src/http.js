import { js } from "./cdp-eval.js";
async function serverFetch(url, options = {}) {
  const { timeout = 20, headers = {}, ...fetchOptions } = options;
  const response = await fetch(url, {
    ...fetchOptions,
    headers: { "User-Agent": "Mozilla/5.0", ...headers },
    signal: AbortSignal.timeout(timeout * 1e3)
  });
  if (!response.ok) {
    throw new Error(
      `${fetchOptions.method || "GET"} ${url} failed: HTTP ${response.status}`
    );
  }
  return response.text();
}
async function browserFetch(url, options = {}) {
  const { timeout = 20, ...fetchOptions } = options;
  const payload = JSON.stringify({ url, options: fetchOptions, timeout });
  return js(`(async () => {
    const { url, options, timeout } = ${payload};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout * 1000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) {
        throw new Error(\`\${options.method || "GET"} \${url} failed: HTTP \${response.status}\`);
      }
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  })()`);
}
export {
  browserFetch,
  serverFetch
};
