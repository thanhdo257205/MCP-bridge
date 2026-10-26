export function redact(value: string): string {
  let text = value.replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password)\s*[=:]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]');
  for (const [key, secret] of Object.entries(process.env)) {
    if (/(?:TOKEN|SECRET|PASSWORD|API_KEY)$/i.test(key) && secret && secret.length >= 8) text = text.split(secret).join('[REDACTED]');
  }
  return text;
}
