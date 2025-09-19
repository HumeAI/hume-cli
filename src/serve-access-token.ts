import { createServer } from 'http';
import { fetchAccessToken } from 'hume/wrapper/fetchAccessToken';
import { type CommonOpts, getSettings } from './common';

export interface ServeAccessTokenOpts extends CommonOpts {
  port?: number;
  host?: string;
  secretKey?: string;
}

export class ServeAccessToken {
  async serve(opts: ServeAccessTokenOpts): Promise<void> {
    const { globalConfig, session, env, reporter } = await getSettings(opts);

    const port = opts.port ?? 8080;
    const host = opts.host ?? 'localhost';

    // Resolve API key and secret key with priority: globalConfig > session > env > opts
    const apiKey = opts.apiKey ?? globalConfig.apiKey ?? session.apiKey ?? env.HUME_API_KEY;
    const secretKey = opts.secretKey ?? env.HUME_SECRET_KEY;

    if (!apiKey || !secretKey) {
      let warningMessage = '⚠️  Missing required credentials:\n';

      if (!apiKey) {
        warningMessage += '   API key not found. You can set it via:\n';
        warningMessage += '     - HUME_API_KEY environment variable\n';
        warningMessage += '     - --api-key command line option\n';
        warningMessage += '     - hume config set apiKey <your_key>\n';
      }

      if (!secretKey) {
        warningMessage += '   Secret key not found. You can set it via:\n';
        warningMessage += '     - HUME_SECRET_KEY environment variable\n';
        warningMessage += '     - --secret-key command line option\n';
      }

      warningMessage += '\nExample usage:\n';
      warningMessage += '   export HUME_API_KEY=your_api_key_here\n';
      warningMessage += '   export HUME_SECRET_KEY=your_secret_key_here\n';
      warningMessage += '   hume serve-access-token\n\n';
      warningMessage += 'Or with command line options:\n';
      warningMessage +=
        '   hume serve-access-token --api-key your_api_key --secret-key your_secret_key';

      reporter.warn(warningMessage);
      process.exit(1);
    }

    const server = createServer(async (req, res) => {
      // Set CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (req.url === '/access-token' && req.method === 'GET') {
        try {
          const accessToken = await fetchAccessToken({
            apiKey,
            secretKey,
            host: opts.baseUrl,
          });

          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(JSON.stringify({ access_token: accessToken }));
          return;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(500);
          res.end(JSON.stringify({ error: errorMessage }));
          return;
        }
      }

      if (req.url === '/' && req.method === 'GET') {
        res.setHeader('Content-Type', 'text/plain');
        res.writeHead(200);
        res.end(infoMessage);
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    const infoMessage = `🚀 Hume access token server listening on http://${host}:${port}

⚠️  This is a demo server meant for development use only.
   On production servers, implement an /access-token endpoint
   on your own backend infrastructure, following the directions at:
   https://dev.hume.ai/docs/introduction/api-key#token-authentication

Press Ctrl+C to stop the server.`;

    server.listen(port, host, () => {
      reporter.info(infoMessage);
    });

    // Handle graceful shutdown
    const shutdown = () => {
      reporter.info('\n📡 Shutting down server...');
      server.close(() => {
        reporter.info('✅ Server stopped.');
        process.exit(0);
      });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}
