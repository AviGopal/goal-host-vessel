export function repairSignatureOf(
  failureClass: string,
  producedShapes: string[] = []
): string {
  const payload = '1f|' + failureClass + '|' + [...producedShapes].sort().join(',');
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(payload);
  const hex = hasher.digest('hex');
  return hex.slice(0, 32);
}

export function classifyFailure(reason: string | null | undefined): string {
  if (reason && /hollow|not reached|incomplete/i.test(reason)) {
    return 'hollow';
  }
  return 'failed';
}
