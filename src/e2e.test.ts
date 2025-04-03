import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { spawn, type SpawnOptions } from 'child_process';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import type { SnippetAudioChunk as SnippetAudioChunk_ } from 'hume/serialization/resources/tts/types';
import type { Hume } from 'hume';

type SnippetAudioChunk = Hume.tts.SnippetAudioChunk;
type RawSnippetAudioChunk = SnippetAudioChunk_.Raw;

// Test utility function for logging during tests
// Only logs when BUN_TEST_VERBOSE=1 is set
function log(...args: any[]): void {
  if (process.env.BUN_TEST_VERBOSE === '1') {
    console.log(...args);
  }
}

/**
 * Test Environment - provides everything needed for running CLI tests
 */
class TestEnvironment {
  private server: MockHumeServer = new MockHumeServer();
  private tempDir: string = '';
  private humeDir: string = '';
  private apiUrl: string = '';

  async setup() {
    await this.server.start();
    this.server.setupDefaultTtsStreamHandler();
    this.apiUrl = this.server.getBaseUrl();

    // Set up test filesystem
    this.tempDir = await mkdtemp(join(tmpdir(), 'tts-cli-test-'));
    this.humeDir = join(this.tempDir, '.hume');
    await mkdir(this.humeDir, { recursive: true });

    return this;
  }

  async cleanup() {
    this.server.stop();

    if (this.tempDir && existsSync(this.tempDir)) {
      await rm(this.tempDir, { recursive: true, force: true });
    }
  }

  async createOutputDir(name: string) {
    const outputDir = join(this.tempDir, name);
    await mkdir(outputDir, { recursive: true });
    return outputDir;
  }

  /**
   * Configure the mock TTS server response
   */
  configureTtsResponse(options: MockTtsOptions) {
    this.server.configureTtsResponse(options);
    return this;
  }

  /**
   * Get all recorded requests to the mock server
   */
  getRecordedRequests() {
    return this.server.getRecordedRequests();
  }

  /**
   * Find requests made to a specific path
   */
  findRequestsTo(path: string) {
    return this.server.findRequestsTo(path);
  }

  /**
   * Clear recorded requests history
   */
  clearRecordedRequests() {
    this.server.clearRecordedRequests();
    return this;
  }

  /**
   * Get the TTS API requests specifically
   */
  getTtsRequests() {
    return this.server.findRequestsTo('/v0/tts/stream/json');
  }

  /**
   * Get the list voices requests
   */
  getListVoicesRequests() {
    return this.server.findRequestsTo('/v0/tts/voices').filter(req => req.method === 'GET');
  }

  /**
   * Get the delete voice requests
   */
  getDeleteVoiceRequests() {
    return this.server.findRequestsTo('/v0/tts/voices').filter(req => req.method === 'DELETE');
  }

  /**
   * Run a CLI command for testing
   */
  async runCliTtsCommand(
    args: string[],
    options: {
      stdin?: string;
      env?: Record<string, string>;
    } = {}
  ) {
    const baseArgs = ['--play', 'off', '--json', '--base-url', this.apiUrl];

    return this.runCliCommand(['tts', ...args, ...baseArgs], options);
  }

  /**
   * Run a config or session CLI command for testing
   * Config and session commands don't accept reporter-mode or base-url flags
   */
  async runCliCommand(
    args: string[],
    options: {
      stdin?: string;
      env?: Record<string, string>;
    } = {}
  ) {
    // Config commands don't take any of the TTS flags
    return this.executeCommand([...args], {
      env: {
        HOME: this.tempDir,
        ...(options.env ?? {}),
      },
      stdin: options.stdin,
    });
  }

  private async executeCommand(
    args: string[],
    options: SpawnOptions & {
      stdin?: string;
      env?: Record<string, string>;
    } = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      // Use the same bun executable that's running the tests
      const cmd = process.execPath;
      const fullArgs = ['run', 'src/index.ts', ...args];

      // Use our log util for consistent log control
      log(`Running command: ${cmd} ${fullArgs.join(' ')}`);

      const env = {
        ...options.env,
        // Ensure we capture errors instead of letting them disappear
        NODE_OPTIONS: '--no-warnings',
        // Make sure PATH includes the directory containing bun
        PATH: `${process.env.PATH}`,
      };

      const proc = spawn(cmd, fullArgs, {
        ...options,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        const str = data.toString();
        stdout += str;
        log(`[STDOUT] ${str.trim()}`);
      });

      proc.stderr.on('data', (data) => {
        const str = data.toString();
        stderr += str;
        log(`[STDERR] ${str.trim()}`);
      });

      if (options.stdin) {
        proc.stdin.write(options.stdin);
        proc.stdin.end();
      }

      proc.on('close', (exitCode) => {
        resolve({
          stdout,
          stderr,
          exitCode: exitCode ?? -1,
        });
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }

  getApiUrl() {
    return this.apiUrl;
  }

  getTempDir() {
    return this.tempDir;
  }
}

interface MockTtsOptions {
  chunks?: Array<RawSnippetAudioChunk>;
  error?: {
    status: number;
    message: string;
  };
}

// Store request data for later assertions
interface RecordedRequest {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: any;
  timestamp: number;
}

// Mock HTTP server to simulate Hume API
class MockHumeServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private requestHandlers: Record<string, (req: Request) => Response | Promise<Response>> = {};
  private port: number = 0;
  private recordedRequests: RecordedRequest[] = [];
  private ttsOptions: MockTtsOptions = {};

  async start(): Promise<number> {
    if (this.server) {
      throw new Error('Server already started');
    }

    this.server = Bun.serve({
      port: 0, // Let the OS choose an available port
      fetch: async (req) => {
        const url = new URL(req.url);
        const path = url.pathname;

        // Record the request for later assertion
        const headers: Record<string, string> = {};
        req.headers.forEach((value, key) => {
          // Store headers in lowercase for consistent access in tests
          headers[key.toLowerCase()] = value;
        });

        // Create a clone before reading the body
        const clonedReq = req.clone();

        // Process the handler first to avoid double-consuming the body
        const handler = this.requestHandlers[path];
        let response;

        if (handler) {
          response = await handler(req);
        } else {
          log(`No handler for ${path}`);
          response = new Response('Not found', { status: 404 });
        }

        // Now try to read the body from the clone
        let body = null;
        if (clonedReq.method !== 'GET') {
          try {
            const bodyText = await clonedReq.text();

            if (bodyText) {
              try {
                body = JSON.parse(bodyText);
              } catch (parseError) {
                log(`Failed to parse JSON from body text: ${parseError}`);
              }
            }
          } catch (e) {
            log(`Failed to read request body text: ${e}`);
          }
        }

        this.recordedRequests.push({
          path,
          method: clonedReq.method,
          headers,
          body,
          timestamp: Date.now(),
        });

        return response;
      },
    });

    this.port = this.server.port;
    log(`Mock Hume server started on port ${this.port}`);
    return this.port;
  }

  stop() {
    if (this.server) {
      this.server.stop();
      this.server = null;
      this.recordedRequests = [];
    }
  }

  addHandler(path: string, handler: (req: Request) => Response | Promise<Response>) {
    this.requestHandlers[path] = handler;
  }

  getBaseUrl() {
    if (!this.server) {
      throw new Error('Server not started');
    }
    return `http://localhost:${this.port}`;
  }

  getRecordedRequests() {
    return [...this.recordedRequests];
  }

  clearRecordedRequests() {
    this.recordedRequests = [];
  }

  findRequestsTo(path: string) {
    return this.recordedRequests.filter((req) => req.path === path);
  }

  configureTtsResponse(options: MockTtsOptions) {
    this.ttsOptions = options;
    this.setupDefaultTtsStreamHandler();
  }

  // Default handlers for all endpoints
  setupDefaultTtsStreamHandler() {
    // TTS stream API endpoint
    this.addHandler('/v0/tts/stream/json', async (req) => {
      try {
        const body = await req.json();

        // If error is configured, return that instead
        if (this.ttsOptions.error) {
          return new Response(JSON.stringify({ error: this.ttsOptions.error.message }), {
            status: this.ttsOptions.error.status,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const numGenerations = body.numGenerations || 1;

        let snippets;
        if (this.ttsOptions.chunks && this.ttsOptions.chunks.length > 0) {
          snippets = this.ttsOptions.chunks;
        } else {
          // Otherwise create default mock generations
          const mockAudio = Buffer.from('mock-audio-data').toString('base64');

          snippets = Array.from({ length: numGenerations }, (_, i) => ({
            generation_id: `mock_gen_${i + 1}`,
            audio: mockAudio,
            id: `mock_snippet_${i + 1}`,
            text: 'mock text',
            utteranceIndex: 0,
          }));
        }

        return new Response(snippets!.map((x) => JSON.stringify(x) + '\n').join(''), {
          status: 200,
          headers: { 'Content-Type': 'text-plain; charset=utf-8' },
        });
      } catch (error) {
        log(`Error in mock handler: ${error}`);
        return new Response(JSON.stringify({ error: 'Internal server error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    });
    
    // Add handler for voices endpoint
    this.addHandler('/v0/tts/voices', async (req) => {
      // Check if it's a GET or DELETE request
      if (req.method === 'GET') {
        // For listing voices
        const url = new URL(req.url);
        const provider = url.searchParams.get('provider') || 'CUSTOM_VOICE';
        
        let voices = [];
        if (provider === 'CUSTOM_VOICE') {
          voices = [
            { id: 'custom1', name: 'my-narrator', createdAt: '2023-01-01T00:00:00Z' },
            { id: 'custom2', name: 'my-assistant', createdAt: '2023-01-02T00:00:00Z' }
          ];
        } else {
          voices = [
            { id: 'shared1', name: 'hume-narrator', createdAt: '2023-01-01T00:00:00Z' },
            { id: 'shared2', name: 'hume-assistant', createdAt: '2023-01-02T00:00:00Z' },
            { id: 'shared3', name: 'hume-podcaster', createdAt: '2023-01-03T00:00:00Z' }
          ];
        }
        
        return Response.json({ data: voices });
      } else if (req.method === 'DELETE') {
        // For deleting a voice
        const url = new URL(req.url);
        const name = url.searchParams.get('name');
        
        if (!name) {
          return new Response(JSON.stringify({ error: 'Missing name parameter' }), { status: 400 });
        }
        
        return Response.json({ success: true });
      } else if (req.method === 'POST') {
        // For saving a voice (already implemented in the original code)
        const body = await req.json();
        return Response.json({ 
          id: 'new-voice-123', 
          name: body.name, 
          createdAt: new Date().toISOString() 
        });
      }
      
      // Fallback
      return new Response('Method not supported', { status: 405 });
    });
  }
}

describe('CLI Error Handling', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await new TestEnvironment().setup();
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  // Helper to check error conditions without being too specific
  const assertErrorFound = (result: { exitCode: number; stderr: string }) => {
    expect(result.exitCode).not.toBe(0); // Should have non-zero exit
    expect(result.stderr.length).toBeGreaterThan(0); // Should contain something in stderr

    // Will match most clipanion error patterns
    return (
      result.stderr.includes('Error') ||
      result.stderr.includes('error') ||
      result.stderr.includes('require') ||
      result.stderr.includes('valid') ||
      result.stderr.includes('option') ||
      result.stderr.includes('command')
    );
  };

  test('Shows error for unknown command', async () => {
    const result = await testEnv.runCliCommand(['nonexistent-command']);

    expect(result.exitCode).not.toBe(0);
    // Clipanion's default error messages should contain at least some kind of error message
    const foundError = assertErrorFound(result);
    expect(foundError).toBe(true);
  });

  test('Shows error for unknown option', async () => {
    const result = await testEnv.runCliCommand(['tts', 'text', '--unknown-flag']);

    expect(result.exitCode).not.toBe(0);
    const foundError = assertErrorFound(result);
    expect(foundError).toBe(true);
  });

  test('Shows error for invalid config option', async () => {
    const result = await testEnv.runCliCommand(['config', 'set', 'invalid.option', 'value']);

    expect(result.exitCode).not.toBe(0);
    const foundError = assertErrorFound(result);
    expect(foundError).toBe(true);
  });

  test('Shows error for invalid enum value', async () => {
    const result = await testEnv.runCliCommand(['config', 'set', 'tts.play', 'invalid_value']);

    expect(result.exitCode).not.toBe(0);
    const foundError = assertErrorFound(result);
    expect(foundError).toBe(true);
  });

  test('Shows error when config set is used without required arguments', async () => {
    const result = await testEnv.runCliCommand(['config', 'set']);

    expect(result.exitCode).not.toBe(0);
    const foundError = assertErrorFound(result);
    expect(foundError).toBe(true);
  });
});

describe('CLI End-to-End Tests', () => {
  let testEnv: TestEnvironment;

  // Common test values
  const API_KEY = 'test-api-key';
  const DEFAULT_ENV = { HUME_API_KEY: API_KEY };

  // Helper functions
  // Use NonNullable to ensure TypeScript knows we're accessing a valid type
  const createChunk = (partial: Partial<SnippetAudioChunk>): RawSnippetAudioChunk => {
    const generationId = partial.generationId ?? 'test_gen_123';
    const id = `${generationId}-0`;
    return {
      chunk_index: partial.chunkIndex ?? 0,
      is_last_chunk: partial.isLastChunk ?? true,
      generation_id: generationId,
      audio: Buffer.from(`audio-data-${generationId}-${id}`).toString('base64'),
      utterance_index: partial.utteranceIndex ?? 0,
    };
  };

  // Helper to check common test failure details
  const logFailureDetails = (result: { exitCode: number; stdout: string; stderr: string }) => {
    if (result.exitCode !== 0) {
      log(`API Response Failed. Exit code: ${result.exitCode}`);
      log(`STDOUT: ${result.stdout}`);
      log(`STDERR: ${result.stderr}`);
    }
  };

  beforeAll(async () => {
    testEnv = await new TestEnvironment().setup();
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  // Reset requests before each test
  beforeEach(() => {
    testEnv.clearRecordedRequests();
  });

  test('Basic text-to-speech with description', async () => {
    // Configure a custom response
    testEnv.configureTtsResponse({
      chunks: [createChunk({ generationId: 'test_gen_123' })],
    });

    const outputDir = await testEnv.createOutputDir('tts-output');

    const result = await testEnv.runCliTtsCommand(
      ['Hello world', '--description', 'A friendly male voice', '--output-dir', outputDir],
      { env: DEFAULT_ENV }
    );

    logFailureDetails(result);

    // Assert on CLI output
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('generationId');
    expect(result.stdout).toContain('test_gen_123');

    // Get and assert on the request made to the server
    const ttsRequests = testEnv.getTtsRequests();
    expect(ttsRequests.length).toBe(1);

    // Assert on request headers
    const apiKeyHeader = ttsRequests[0].headers['x-hume-api-key'];
    expect(apiKeyHeader).toBe(API_KEY);

    // Assert on request body
    const requestBody = ttsRequests[0].body;
    expect(requestBody.utterances[0].text).toBe('Hello world');
    expect(requestBody.utterances[0].description).toBe('A friendly male voice');
  });

  test('Multiple generations with specific format', async () => {
    // Configure a custom response with multiple generations
    testEnv.configureTtsResponse({
      chunks: [
        createChunk({ generationId: 'multi_gen_1' }),
        createChunk({ generationId: 'multi_gen_2' }),
        createChunk({ generationId: 'multi_gen_3' }),
      ],
    });

    const outputDir = await testEnv.createOutputDir('tts-output-multi');

    const result = await testEnv.runCliTtsCommand(
      [
        'Generate multiple variations',
        '--num-generations',
        '3',
        '--format',
        'mp3',
        '--output-dir',
        outputDir,
      ],
      { env: DEFAULT_ENV }
    );

    logFailureDetails(result);

    expect(result.exitCode).toBe(0);

    // Verify all three generations were created
    expect(result.stdout).toContain('multi_gen_1');
    expect(result.stdout).toContain('multi_gen_2');
    expect(result.stdout).toContain('multi_gen_3');

    // Get and assert on the request made to the server
    const ttsRequests = testEnv.getTtsRequests();
    expect(ttsRequests.length).toBe(1);

    // Assert on the request body
    const requestBody = ttsRequests[0].body;
    expect(requestBody.utterances[0].text).toBe('Generate multiple variations');
    expect(requestBody.num_generations).toBe(3);
    expect(requestBody.format?.type).toBe('mp3');
  });

  test('Reading from stdin', async () => {
    // Configure a custom response
    testEnv.configureTtsResponse({
      chunks: [createChunk({ generationId: 'stdin_gen_123' })],
    });

    const inputText = 'This is text from standard input';
    const outputDir = await testEnv.createOutputDir('tts-output-stdin');

    const result = await testEnv.runCliTtsCommand(
      [
        '-', // Dash indicates reading from stdin
        '--output-dir',
        outputDir,
      ],
      {
        stdin: inputText,
        env: DEFAULT_ENV,
      }
    );

    logFailureDetails(result);

    expect(result.exitCode).toBe(0);

    // Verify output contains our generation ID
    expect(result.stdout).toContain('generationId');
    expect(result.stdout).toContain('stdin_gen_123');

    // Get and assert on the request made to the server
    const ttsRequests = testEnv.getTtsRequests();
    expect(ttsRequests.length).toBe(1);

    // Verify the text from stdin was properly passed to the API
    const requestBody = ttsRequests[0].body;
    expect(requestBody.utterances[0].text).toBe(inputText);
  });

  test('Error handling with missing API key', async () => {
    const result = await testEnv.runCliTtsCommand(['This should fail']);

    // Should exit with non-zero code due to missing API key
    expect(result.exitCode).not.toBe(0);

    // Should show appropriate error message about API key
    expect(result.stderr).toContain('API key');

    // Verify no requests were made to the server (since it should fail before that)
    const ttsRequests = testEnv.getTtsRequests();
    expect(ttsRequests.length).toBe(0);
  });

  test('Error response handling', async () => {
    // Configure an error response
    testEnv.configureTtsResponse({
      error: {
        status: 400,
        message: 'Invalid request parameters',
      },
    });

    const result = await testEnv.runCliTtsCommand(['This should get a server error'], {
      env: DEFAULT_ENV,
    });

    // Should exit with non-zero code due to API error
    expect(result.exitCode).not.toBe(0);

    // Should contain error information
    expect(result.stderr).toContain('error');

    // Verify the request was made but handled the error properly
    const ttsRequests = testEnv.getTtsRequests();
    expect(ttsRequests.length).toBe(1);
    expect(ttsRequests[0].body.utterances[0].text).toBe('This should get a server error');
  });

  test('Config, session and TTS with continuation', async () => {
    // Step 1: Set global config with three settings
    // Use runConfigCli which avoids adding TTS-specific flags
    const configResult = await testEnv.runCliCommand(
      ['config', 'set', 'tts.description', 'A professional voice with slight British accent'],
      { env: DEFAULT_ENV }
    );
    expect(configResult.exitCode).toBe(0);

    const formatResult = await testEnv.runCliCommand(['config', 'set', 'tts.format', 'mp3'], {
      env: DEFAULT_ENV,
    });
    expect(formatResult.exitCode).toBe(0);

    // Use a valid config option - numGenerations is passed as a command-line arg, not stored in config
    const playResult = await testEnv.runCliCommand(['config', 'set', 'tts.play', 'off'], {
      env: DEFAULT_ENV,
    });
    expect(playResult.exitCode).toBe(0);

    // Clear requests before next step
    testEnv.clearRecordedRequests();

    // Step 2: Set session to override two of the global settings
    const sessionDescResult = await testEnv.runCliCommand(
      ['session', 'set', 'tts.description', 'An energetic voice with American accent'],
      { env: DEFAULT_ENV }
    );
    expect(sessionDescResult.exitCode).toBe(0);

    const sessionPlayResult = await testEnv.runCliCommand(['session', 'set', 'tts.play', 'first'], {
      env: DEFAULT_ENV,
    });
    expect(sessionPlayResult.exitCode).toBe(0);

    // Clear requests before TTS calls
    testEnv.clearRecordedRequests();

    // Configure the TTS responses for first call with 3 generations
    testEnv.configureTtsResponse({
      chunks: [
        createChunk({ generationId: 'config_test_gen_1' }),
        createChunk({ generationId: 'config_test_gen_2' }),
        createChunk({ generationId: 'config_test_gen_3' }),
      ],
    });

    const outputDir = await testEnv.createOutputDir('tts-config-test');

    // Step 3: Run TTS with overrides
    const ttsResult = await testEnv.runCliTtsCommand(
      [
        'This is the first part of a sentence',
        '--output-dir',
        outputDir,
        '--prefix',
        'custom-', // Override the default prefix
        '--num-generations',
        '3', // Set this directly since it's not in config
      ],
      { env: DEFAULT_ENV }
    );

    logFailureDetails(ttsResult);
    expect(ttsResult.exitCode).toBe(0);

    // Verify three generations were made
    expect(ttsResult.stdout).toContain('config_test_gen_1');
    expect(ttsResult.stdout).toContain('config_test_gen_2');
    expect(ttsResult.stdout).toContain('config_test_gen_3');

    // Verify request payload has expected values
    const ttsRequests = testEnv.getTtsRequests();
    expect(ttsRequests.length).toBe(1);
    expect(ttsRequests[0].body.utterances[0].text).toBe('This is the first part of a sentence');
    expect(ttsRequests[0].body.utterances[0].description).toBe(
      'An energetic voice with American accent'
    ); // From session
    expect(ttsRequests[0].body.num_generations).toBe(3); // From command line
    expect(ttsRequests[0].body.format?.type).toBe('mp3'); // From global config

    // Clear requests for continuation test
    testEnv.clearRecordedRequests();

    // Configure the TTS response for continuation
    testEnv.configureTtsResponse({
      chunks: [createChunk({ generationId: 'continuation_gen_1' })],
    });

    // Step 4: Run TTS with continuation using --last and --last-index
    const continuationResult = await testEnv.runCliTtsCommand(
      [
        'which continues seamlessly',
        '--output-dir',
        outputDir,
        '--last',
        '--last-index',
        '2', // Use the second generation from previous run
      ],
      { env: DEFAULT_ENV }
    );

    logFailureDetails(continuationResult);
    expect(continuationResult.exitCode).toBe(0);

    // Verify continuation generation was made
    expect(continuationResult.stdout).toContain('continuation_gen_1');

    // Verify continuation request has correct context
    const continuationRequests = testEnv.getTtsRequests();
    expect(continuationRequests.length).toBe(1);
    expect(continuationRequests[0].body.utterances[0].text).toBe('which continues seamlessly');
    expect(continuationRequests[0].body.context?.generation_id).toBe('config_test_gen_2'); // Should use the second generation
    expect(continuationRequests[0].body.format?.type).toBe('mp3'); // Should still use mp3 from config
  });

  // Voice management command tests
  test('Voice list command structure', async () => {
    // We're only checking the command structure, not the actual API call
    const result = await testEnv.runCliCommand(['voices', 'list', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('List available voices');
    expect(result.stdout).toContain('--provider');
  });
  
  test('Voice list with provider option', async () => {
    // Test that the provider option is recognized
    const result = await testEnv.runCliCommand(['voices', 'list', '--provider', 'HUME_AI', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('List available voices');
    expect(result.stdout).toContain('--provider');
  });
  
  test('Voice delete command structure', async () => {
    // We're only checking the command structure, not the actual API call
    const result = await testEnv.runCliCommand(['voices', 'delete', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Delete a saved voice');
    expect(result.stdout).toContain('--name');
  });
  
  test('Error when deleting a voice without name', async () => {
    const result = await testEnv.runCliCommand(['voices', 'delete']);
    expect(result.exitCode).not.toBe(0);
    // Test that we get an error, but don't be specific about the message
    // since the error format might vary
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});
