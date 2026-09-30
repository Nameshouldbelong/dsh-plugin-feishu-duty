export function buildMultipart(
  fields: Record<string, string | number>,
  fileInfo: { field: string; fileName: string; data: Buffer; contentType?: string }
): { body: Buffer; contentType: string } {
  if (fileInfo.fileName.includes('"') || fileInfo.fileName.includes('\r') || fileInfo.fileName.includes('\n')) {
    throw new Error('Invalid filename');
  }

  const boundary = `----FeishuMultipartBoundary${Math.random().toString(36).substring(2)}${Date.now()}`;
  const contentType = `multipart/form-data; boundary=${boundary}`;

  const buffers: Buffer[] = [];

  for (const [key, value] of Object.entries(fields)) {
    buffers.push(Buffer.from(`--${boundary}\r\n`));
    buffers.push(Buffer.from(`Content-Disposition: form-data; name="${key}"\r\n\r\n`));
    buffers.push(Buffer.from(`${value}\r\n`));
  }

  buffers.push(Buffer.from(`--${boundary}\r\n`));
  buffers.push(
    Buffer.from(
      `Content-Disposition: form-data; name="${fileInfo.field}"; filename="${fileInfo.fileName}"\r\n`
    )
  );
  
  if (fileInfo.contentType) {
    buffers.push(Buffer.from(`Content-Type: ${fileInfo.contentType}\r\n\r\n`));
  } else {
    buffers.push(Buffer.from(`Content-Type: application/octet-stream\r\n\r\n`));
  }

  buffers.push(fileInfo.data);
  buffers.push(Buffer.from('\r\n'));

  buffers.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    body: Buffer.concat(buffers),
    contentType,
  };
}
