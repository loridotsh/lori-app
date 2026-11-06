/** Read only enough upstream error text to classify a refusal. Never buffer an
 * entire error response: providers can omit or misstate Content-Length. */
export async function readProviderRefusal(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < 4096) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, 4096 - size);
      chunks.push(chunk);
      size += chunk.byteLength;
    }
    return Buffer.concat(chunks, size).toString("utf8");
  } catch {
    return "";
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
