import { createKDNAServer } from '../../index.js';

function nodeRequestToWebRequest(req, options = {}) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers.host || 'localhost';
  const baseUrl = `${proto}://${host}`;
  const url = new URL(req.originalUrl || req.url || '/', baseUrl);
  if (options.basePath && url.pathname.startsWith(options.basePath)) {
    url.pathname = url.pathname.slice(options.basePath.length) || '/';
  }

  const init = {
    method: req.method,
    headers: req.headers,
  };
  if (!['GET', 'HEAD'].includes(req.method)) {
    init.body = req;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

function mountedOperation(req) {
  const pathname = new URL(req.url || '/', 'http://kdna.invalid').pathname;
  if (pathname === '/' || pathname === '') return 'health';
  const match = /^\/([a-z]+(?:-[a-z]+)*)\/?$/.exec(pathname);
  return match ? match[1] : '__invalid_route__';
}

async function sendWebResponse(res, webResponse) {
  res.statusCode = webResponse.status;
  webResponse.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await webResponse.arrayBuffer()));
}

export function createKDNARouter(options = {}) {
  const server = createKDNAServer(options);

  return async function kdnaRouter(req, res, next) {
    try {
      const request = nodeRequestToWebRequest(req, options);
      const response = await server.handle(request, { operation: mountedOperation(req) });
      await sendWebResponse(res, response);
    } catch (error) {
      if (typeof next === 'function') next(error);
      else throw error;
    }
  };
}
