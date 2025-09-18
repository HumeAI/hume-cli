import { createServer } from 'http';
import { fetchAccessToken } from 'hume/wrapper/fetchAccessToken';
import { type CommonOpts, makeReporter, getSettings } from './common';

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
      reporter.warn('⚠️  Missing required credentials:');
      if (!apiKey) {
        reporter.warn('   API key not found. You can set it via:');
        reporter.warn('     - HUME_API_KEY environment variable');
        reporter.warn('     - --api-key command line option');
        reporter.warn('     - hume config set apiKey <your_key>');
      }
      if (!secretKey) {
        reporter.warn('   Secret key not found. You can set it via:');
        reporter.warn('     - HUME_SECRET_KEY environment variable');
        reporter.warn('     - --secret-key command line option');
      }
      reporter.warn('');
      reporter.warn('Example usage:');
      reporter.warn('   export HUME_API_KEY=your_api_key_here');
      reporter.warn('   export HUME_SECRET_KEY=your_secret_key_here');
      reporter.warn('   hume serve-access-token');
      reporter.warn('');
      reporter.warn('Or with command line options:');
      reporter.warn('   hume serve-access-token --api-key your_api_key --secret-key your_secret_key');
      process.exit(1);
    }

    const server = createServer(async (req, res) => {
      // Set CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      // Handle preflight OPTIONS request
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.url === '/access-token' && (req.method === 'GET' || req.method === 'POST')) {
        try {
          const accessToken = await fetchAccessToken({
            apiKey,
            secretKey,
            host: opts.baseUrl,
          });

          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(JSON.stringify({ access_token: accessToken }));
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(500);
          res.end(JSON.stringify({ error: errorMessage }));
        }
      } else if (req.url === '/' && req.method === 'GET') {
        // Serve a simple info page
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Hume Access Token Server</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 40px; line-height: 1.6; }
        .warning { background: #fff3cd; border: 1px solid #ffecb5; padding: 15px; border-radius: 5px; margin: 20px 0; }
        .endpoint { background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0; }
        code { background: #f1f3f4; padding: 2px 6px; border-radius: 3px; font-family: 'SF Mono', Monaco, monospace; }
    </style>
</head>
<body>
    <h1>Hume Access Token Server</h1>
    <p>This development server is running on <strong>http://${host}:${port}</strong></p>

    <div class="warning">
        ⚠️ <strong>Development Only:</strong> This server is meant for development use only.
        On production servers, implement an /access-token endpoint on your own backend infrastructure.
    </div>

    <h2>Available Endpoints</h2>

    <div class="endpoint">
        <strong>GET/POST</strong> <code>/access-token</code><br>
        Returns a new access token in JSON format: <code>{"access_token": "..."}</code>
    </div>

    <h2>Usage Example</h2>
    <pre><code>fetch('http://${host}:${port}/access-token')
  .then(response => response.json())
  .then(data => console.log('Access Token:', data.access_token));</code></pre>

    <p>For more information, see the <a href="https://dev.hume.ai/docs/introduction/api-key#token-authentication" target="_blank">Hume API documentation</a>.</p>
</body>
</html>`;

        res.setHeader('Content-Type', 'text/html');
        res.writeHead(200);
        res.end(html);
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    server.listen(port, host, () => {
      reporter.info(`🚀 Hume access token server listening on http://${host}:${port}`);
      reporter.info('');
      reporter.info('Available endpoints:');
      reporter.info(`   GET/POST  http://${host}:${port}/access-token`);
      reporter.info('');
      reporter.info('⚠️  This is a demo server meant for development use only.');
      reporter.info('   On production servers, implement an /access-token endpoint');
      reporter.info('   on your own backend infrastructure, following the directions at:');
      reporter.info('   https://dev.hume.ai/docs/introduction/api-key#token-authentication');
      reporter.info('');
      reporter.info('Press Ctrl+C to stop the server.');
    });

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      reporter.info('\n📡 Shutting down server...');
      server.close(() => {
        reporter.info('✅ Server stopped.');
        process.exit(0);
      });
    });

    process.on('SIGTERM', () => {
      reporter.info('\n📡 Shutting down server...');
      server.close(() => {
        reporter.info('✅ Server stopped.');
        process.exit(0);
      });
    });
  }
}
