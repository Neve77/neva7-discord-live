// Box–Muller: standard normal from two independent uniform samples.
// Reject out-of-range samples, rather than clipping and piling them onto the bounds.
function gaussianJitter({ mean = 350, stddev = 100, min = 0, max = 1000, random = Math.random } = {}) {
  if (![mean, stddev, min, max].every(Number.isFinite) || stddev <= 0 || min < 0 || min >= max || mean < min || mean > max) {
    throw new Error('Parâmetros de jitter inválidos.');
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    const u = 1 - random(), v = random();
    if (!(u > 0 && u <= 1 && v >= 0 && v < 1)) continue;
    const value = mean + stddev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    if (value >= min && value <= max) return Math.round(value);
  }
  return Math.round(mean);
}

function retryAfterMs(response, body, now = Date.now()) {
  const header = response.headers?.get('retry-after');
  const seconds = Number(header);
  const headerMs = header == null ? NaN : Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(header) - now;
  const bodyMs = typeof body?.retry_after === 'number' && body.retry_after >= 0 ? body.retry_after * 1000 : NaN;
  const waits = [headerMs, bodyMs].filter(value => Number.isFinite(value) && value >= 0);
  return waits.length ? Math.max(...waits) : 2000;
}

module.exports = { gaussianJitter, retryAfterMs };
