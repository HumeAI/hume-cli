import { mkdir, writeFile } from 'node:fs/promises';
import { getLastSynthesisFromHistory, saveLastSynthesisToHistory } from './history';
import { join, dirname } from 'path';
import { assert } from 'node:console';
import {
  debug,
  type CommonOpts,
  getSettings,
  ApiKeyNotSetError,
  type Reporter,
  formatApiKeyForCurl,
  getApiKeyProvenance,
} from './common';
import type { ConfigData } from './config';
import type { Hume, HumeClient } from 'hume';
import { playAudioFile, withStdinAudioPlayer, withPcmAudioPlayer } from './play_audio';
import HumeSerialization from 'hume/serialization';
import { StreamingTtsClient, type PublishTts } from './streaming';
import { createInterface } from 'readline';
import { createSilenceFiller } from 'hume';

type SynthesisOutputOpts =
  | {
      type: 'path';
      numGenerations: 1;
      path: string;
    }
  | {
      type: 'dir';
      numGenerations: number;
      dir: string;
      prefix: string;
      format: 'wav' | 'mp3' | 'pcm';
    };

const calculateOutputOpts = (opts: {
  numGenerations: number;
  outputFilePath?: string;
  outputDir?: string;
  prefix?: string;
  format: 'wav' | 'pcm' | 'mp3';
}): SynthesisOutputOpts => {
  if (opts.numGenerations > 1 && opts.outputFilePath) {
    throw new Error('Unexpected: cannot specify both --num-generations and --output-file-path');
  }
  if (opts.outputFilePath) {
    return {
      type: 'path',
      numGenerations: 1,
      path: opts.outputFilePath,
    };
  }
  if (!opts.outputDir) {
    throw new Error('Unexpected: outputDir was not set');
  }
  if (!opts.prefix) {
    throw new Error('Unexpected: prefix was not set');
  }
  return {
    type: 'dir',
    numGenerations: opts.numGenerations,
    dir: opts.outputDir,
    prefix: opts.prefix,
    format: opts.format,
  };
};

const calculateUtterance = (opts: {
  voiceName: string | null;
  voiceId: string | null;
  text: string;
  description: string | null;
  presetVoice: boolean;
  provider?: 'CUSTOM_VOICE' | 'HUME_AI';
  speed: number | null;
  trailingSilence: number | null;
}): Hume.tts.PostedUtterance => {
  const utterance: Hume.tts.PostedUtterance = {
    text: opts.text,
  };

  // Determine provider - new --provider flag takes precedence over legacy --preset-voice flag
  // TODO: remove --preset-voice flag in the future
  let provider = opts.provider;
  if (!provider && opts.presetVoice) {
    provider = 'HUME_AI';
  }

  if (opts.voiceName) {
    utterance.voice =
      provider === 'HUME_AI'
        ? { name: opts.voiceName, provider: 'HUME_AI' }
        : { name: opts.voiceName };
  } else if (opts.voiceId) {
    utterance.voice =
      provider === 'HUME_AI' ? { id: opts.voiceId, provider: 'HUME_AI' } : { id: opts.voiceId };
  }
  if (opts.description) {
    utterance.description = opts.description;
  }
  if (opts.speed !== null) {
    utterance.speed = opts.speed;
  }
  if (opts.trailingSilence !== null) {
    utterance.trailingSilence = opts.trailingSilence;
  }
  return utterance;
};

export type SynthesisOpts = CommonOpts & {
  text?: string;
  voiceName?: string;
  voiceId?: string;
  description?: string;
  contextGenerationId?: string;
  numGenerations?: number;
  outputFilePath?: string;
  outputDir?: string;
  prefix?: string;
  play?: 'all' | 'first' | 'off';
  format?: 'wav' | 'mp3' | 'pcm';
  last?: boolean;
  lastIndex?: number;
  playCommand?: string;
  presetVoice?: boolean;
  provider?: 'CUSTOM_VOICE' | 'HUME_AI';
  speed?: number;
  trailingSilence?: number;
  streaming?: boolean;
  instantMode?: boolean;
  modelVersion?: '1' | '2';
  requestJson?: string;
  curl?: boolean;
};

export type StreamInputOpts = CommonOpts & {
  voiceName?: string;
  voiceId?: string;
  description?: string;
  provider?: 'CUSTOM_VOICE' | 'HUME_AI';
  speed?: number;
  trailingSilence?: number;
  instantMode?: boolean;
  playCommand?: string;
  play?: boolean;
};

export class Tts {
  // Exposed for testing
  ensureDirAndWriteFile = async (path: string, data: Buffer) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  };
  getSettings = getSettings;
  playAudioFile = playAudioFile;
  withStdinAudioPlayer = withStdinAudioPlayer;

  getStdin = () => process.stdin;

  private static defaults = {
    description: null,
    contextGenerationId: null,
    voiceName: null,
    voiceId: null,
    numGenerations: 1,
    outputFilePath: '',
    outputDir: './tts-audio',
    prefix: 'tts-',
    play: 'all' as const,
    format: 'wav' as const,
    last: false,
    lastIndex: null,
    playCommand: undefined,
    presetVoice: false,
    speed: null,
    trailingSilence: null,
    streaming: true,
    instantMode: false,
    modelVersion: null,
  };

  private async writeFiles(
    opts: SynthesisOutputOpts,
    generations: Array<Hume.tts.ReturnGeneration>
  ): Promise<Array<{ generationId: string; path: string }>> {
    if (opts.type === 'path') {
      assert(generations.length === 1);
      const [generation] = generations;
      await this.ensureDirAndWriteFile(opts.path, Buffer.from(generation.audio, 'base64'));
      return [
        {
          generationId: generation.generationId,
          path: opts.path,
        },
      ];
    }
    if (opts.type === 'dir') {
      const paths: Array<{ generationId: string; path: string }> = [];
      for (const generation of generations) {
        const path = join(opts.dir, `${opts.prefix}${generation.generationId}.${opts.format}`);
        await this.ensureDirAndWriteFile(path, Buffer.from(generation.audio, 'base64'));
        paths.push({
          generationId: generation.generationId,
          path,
        });
      }
      return paths;
    }
    throw new Error('Unexpected: outputOpts was not set');
  }

  private async maybeAddContext(
    opts: {
      contextGenerationId: string | null;
      last: boolean;
      lastIndex: number | null;
    },
    tts: Hume.tts.PostedTts
  ): Promise<void> {
    if (opts.contextGenerationId) {
      tts.context = {
        generationId: opts.contextGenerationId,
      };
      return;
    }

    if (!opts.last) {
      return;
    }

    // `contextGenerationId` takes precedence over `last`. Users shouldn't
    // specify them at the same time, but if the user has `last` in a config
    // layer with lower priority session, then contextGenerationId can act as
    // an override.
    const lastSynthesis = await this.getLastSynthesis();

    if (!lastSynthesis) {
      throw new Error('No previous generation found to continue from');
    }
    const nLastGenerations = lastSynthesis.ids.length;
    if (nLastGenerations > 1 && opts.lastIndex === null) {
      throw new Error(
        `Unexpected: previous synthesis contained ${nLastGenerations} generations. Please specify --last-index as a number between 1 and ${lastSynthesis.ids.length} to select from the previous synthesis`
      );
    }
    if (opts.lastIndex !== null && opts.lastIndex > nLastGenerations) {
      throw new Error(
        `Unexpected: previous synthesis contained ${nLastGenerations} generations. Please specify --last-index as a number between 1 and ${lastSynthesis.ids.length} to select from the previous synthesis`
      );
    }
    tts.context = {
      generationId: lastSynthesis.ids[(opts.lastIndex ?? 1) - 1],
    };
  }

  private async playAudios(
    play: 'all' | 'first' | 'off',
    files: Array<{ path: string }>,
    reporter: Reporter,
    playCommand: string | null
  ) {
    if (play === 'off') {
      return;
    }
    if (play === 'first') {
      const file = files[0];
      await reporter.withSpinner(`Playing audio ${file.path}`, async () => {
        await this.playAudioFile(file.path, playCommand);
      });
      return;
    }
    if (play === 'all') {
      const n = files.length;
      for (const i in files) {
        const file = files[i];
        await reporter.withSpinner(
          `Playing audio ${file.path} (${Number(i) + 1} of ${n})`,
          async () => {
            await this.playAudioFile(file.path, playCommand);
          }
        );
      }
      return;
    }
  }

  private getLastSynthesis = getLastSynthesisFromHistory;
  private saveLastSynthesis = saveLastSynthesisToHistory;
  private static resolveOpts(
    _env: Record<string, string | undefined>,
    globalConfig: ConfigData,
    session: ConfigData,
    opts: SynthesisOpts
  ) {
    const mutuallyExclusive = (
      a: keyof SynthesisOpts & string,
      b: keyof SynthesisOpts & string
    ) => {
      if (opts[a] && opts[b]) {
        throw new Error(`Unexpected: cannot specify both --${a} and --${b}`);
      }
    };
    mutuallyExclusive('voiceName', 'voiceId');
    mutuallyExclusive('outputFilePath', 'numGenerations');
    mutuallyExclusive('last', 'contextGenerationId');

    const withPriority = <T>(priority: number, item: T | null | undefined) =>
      item === undefined || item === null ? null : { priority, item };
    // osgd = "opts else session else global else defaults"
    const osgd = <
      T extends keyof SynthesisOpts &
        keyof typeof Tts.defaults &
        keyof NonNullable<(typeof session)['tts']>,
    >(
      key: T
    ) => {
      return (
        withPriority(3, opts[key]) ??
        withPriority(2, session.tts?.[key]) ??
        withPriority(1, globalConfig?.tts?.[key]) ?? {
          priority: 0,
          item: Tts.defaults[key],
        }
      );
    };
    // od = "opts else defaults"
    const od = <T extends keyof SynthesisOpts & keyof typeof Tts.defaults>(key: T) => {
      return withPriority(1, opts[key]) ?? { priority: 0, item: Tts.defaults[key] };
    };

    const description = osgd('description').item;
    const contextGenerationId = od('contextGenerationId').item;
    const numGenerations = osgd('numGenerations').item;
    const outputFilePath = od('outputFilePath').item;
    const outputDir = osgd('outputDir').item;
    const prefix = osgd('prefix').item;
    const play = osgd('play').item;
    const format = osgd('format').item;
    const last = osgd('last').item;
    const lastIndex = osgd('lastIndex').item;
    const playCommand = osgd('playCommand').item;
    const presetVoice = osgd('presetVoice').item;
    const speed = osgd('speed').item;
    const trailingSilence = osgd('trailingSilence').item;
    const streaming = osgd('streaming').item;
    const instantMode = osgd('instantMode').item;
    const modelVersion = osgd('modelVersion').item;
    const requestJson = opts.requestJson ?? null;

    // VoiceId and voiceName are mutually exclusive within opts, but
    // not across layers. VoiceId defined with greater priority should
    // override voiceName defined with lower priority, and vice versa
    const voiceName_ = osgd('voiceName');
    const voiceId_ = osgd('voiceId');
    let voiceName = voiceName_.item;
    let voiceId = voiceId_.item;
    if (voiceName_ && voiceId_) {
      if (voiceName_.priority > voiceId_.priority) {
        voiceId = null;
      } else {
        voiceName = null;
      }
    }

    return {
      ...opts,
      description,
      contextGenerationId,
      voiceName,
      voiceId,
      numGenerations,
      outputFilePath,
      outputDir,
      prefix,
      play,
      format,
      last,
      lastIndex,
      playCommand,
      presetVoice,
      speed,
      trailingSilence,
      streaming,
      instantMode,
      modelVersion,
      requestJson,
    };
  }

  private async readStdin(): Promise<string> {
    return new Promise((resolve, reject) => {
      let content = '';
      const stdin = this.getStdin();

      stdin.setEncoding('utf8');
      stdin.on('data', (chunk) => {
        content += chunk;
      });
      stdin.on('end', () => {
        resolve(content.trim());
      });
      stdin.on('error', reject);
    });
  }

  async synthesize(rawOpts: SynthesisOpts) {
    const { session, globalConfig, env, reporter, hume } = await this.getSettings(rawOpts);
    const opts = Tts.resolveOpts(env, globalConfig, session, rawOpts);

    // Validate that either text or requestJson is provided, but not both
    if (!opts.text && !opts.requestJson) {
      throw new Error('Either text parameter or --request-json must be provided');
    }
    if (opts.text && opts.requestJson) {
      throw new Error(
        'Cannot specify both text parameter and --request-json. Use one or the other.'
      );
    }

    const outputOpts = calculateOutputOpts(opts);
    if (opts.presetVoice) {
      reporter.warn(
        'Please use --provider HUME_AI instead of --preset-voice. --preset-voice will be removed in a future version'
      );
    }

    let text = opts.text;
    if (text === '-') {
      text = await this.readStdin();
    }

    const utterance = calculateUtterance({
      ...opts,
      text: text || '',
      speed: opts.speed,
      trailingSilence: opts.trailingSilence,
      provider: opts.provider,
    });

    let tts: Hume.tts.PostedTts;

    // If requestJson is provided, parse it as JSON and use it directly
    if (opts.requestJson) {
      try {
        tts = JSON.parse(String(opts.requestJson));
        debug('Using hardcoded request body: %O', JSON.stringify(tts, null, 2));
      } catch (error) {
        throw new Error(
          `Invalid JSON in --request-json: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    } else {
      // Build TTS object from options as usual
      const baseTts = {
        utterances: [utterance],
        numGenerations: outputOpts.numGenerations,
        format: { type: opts.format },
      };

      // Only add version field if modelVersion is explicitly set (not null)
      if (opts.modelVersion !== null) {
        tts = { ...baseTts, version: opts.modelVersion };
      } else {
        tts = baseTts;
      }

      // First add context to support continuation
      await this.maybeAddContext(opts, tts);
    }

    // Validate instant_mode requirements (only when not using hardcoded request body)
    if (opts.instantMode && !opts.requestJson) {
      if (!opts.streaming) {
        throw new Error('Instant mode requires streaming to be enabled');
      }
      if (outputOpts.numGenerations !== 1) {
        throw new Error('Instant mode requires num_generations=1');
      }
      if (!utterance.voice && !tts.context) {
        throw new Error(
          'Instant mode requires a voice to be specified (use --voice-name, --voice-id, --last, or --continue)'
        );
      }
      tts.instantMode = true;
    }

    if (!hume) {
      throw new ApiKeyNotSetError();
    }

    // Handle curl generation
    if (opts.curl) {
      return this.generateCurlCommand(opts, env, globalConfig, session, reporter, tts);
    }

    if (opts.streaming) {
      return this.synthesizeStreaming(reporter, tts, hume, opts, outputOpts);
    }
    return this.synthesizeBuffered(reporter, tts, hume, opts, outputOpts);
  }

  async synthesizeStreaming(
    reporter: Reporter,
    tts: Hume.tts.PostedTts,
    hume: HumeClient,
    opts: ReturnType<typeof Tts.resolveOpts>,
    outputOpts: SynthesisOutputOpts
  ) {
    tts.stripHeaders = true;
    reporter.info('Using streaming mode');

    // Map to collect all audio chunks for each generation
    const generationAudio: Map<string, Array<Buffer>> = new Map();

    debug('Request payload: %O', JSON.stringify(tts, null, 2));

    const go = async (writeAudio: (audioBuffer: Buffer) => void) => {
      await reporter.withSpinner('Synthesizing...', async () => {
        let firstGenerationId = null;
        for await (const rawChunk of await hume.tts.synthesizeJsonStreaming(tts)) {
          const chunk = rawChunk;
          if (chunk.type === 'timestamp') {
            debug('Skipping timestamp chunk');
            continue;
          }
          if (!firstGenerationId && chunk.generationId) {
            firstGenerationId = chunk.generationId;
          }
          if (!chunk.audio || chunk.audio.length === 0) {
            debug('Skipping empty audio snippet');
            continue;
          }
          if (!chunk.generationId) {
            debug('Skipping chunk without generationId');
            continue;
          }

          const audioBuffer = Buffer.from(chunk.audio, 'base64');

          // Store audio chunk for the full generation file
          if (!generationAudio.has(chunk.generationId)) {
            generationAudio.set(chunk.generationId, []);
          }
          generationAudio.get(chunk.generationId)?.push(audioBuffer);

          if (opts.play === 'first' && chunk.generationId !== firstGenerationId) {
            debug('Skipping audio playback for non-first generation');
            continue;
          }
          debug('Writing audio chunk');
          writeAudio(audioBuffer);
        }
      });
    };

    if (opts.play !== 'off') {
      await this.withStdinAudioPlayer(opts.playCommand ?? null, go);
    } else {
      const noopWriteAudio = () => {};
      await go(noopWriteAudio);
    }

    // Write full generation files
    const writtenFiles: Array<{ generationId: string; path: string }> = [];

    for (const [generationId, audioChunks] of generationAudio.entries()) {
      // Concatenate all audio chunks
      const fullAudio = Buffer.concat(audioChunks);

      // Determine the path for the full generation
      const fullPath =
        outputOpts.type === 'path'
          ? outputOpts.path
          : join(outputOpts.dir, `${outputOpts.prefix}${generationId}.${outputOpts.format}`);

      // Write the full generation file
      await this.ensureDirAndWriteFile(fullPath, fullAudio);

      writtenFiles.push({
        generationId,
        path: fullPath,
      });
    }

    // Save generation IDs for history/continuation
    await this.saveLastSynthesis({
      ids: Array.from(generationAudio.keys()),
      timestamp: Date.now(),
    });

    // Log the written files
    if (writtenFiles.length === 1) {
      reporter.info(`Wrote ${writtenFiles[0].path}`);
    } else {
      reporter.info(`Wrote ${['', ...writtenFiles.map(({ path }) => path)].join('\n  ')}`);
    }

    reporter.json({
      writtenFiles,
      generationIds: generationAudio.keys(),
    });

    return;
  }

  async synthesizeBuffered(
    reporter: Reporter,
    tts: Hume.tts.PostedTts,
    hume: HumeClient,
    opts: ReturnType<typeof Tts.resolveOpts>,
    outputOpts: SynthesisOutputOpts
  ) {
    const result = await reporter.withSpinner('Synthesizing...', async () => {
      debug('Request payload: %O', JSON.stringify(tts, null, 2));
      const result = await hume.tts.synthesizeJson(tts);
      debug('Response: %O', JSON.stringify(result, null, 2));
      for (const generation of result.generations) {
        reporter.info(`Generation ID: ${generation.generationId}`);
      }
      await this.saveLastSynthesis({
        ids: result.generations.map((g) => g.generationId),
        timestamp: Date.now(),
      });
      return result;
    });

    const writtenFiles = await this.writeFiles(outputOpts, result.generations);
    if (writtenFiles.length === 1) {
      reporter.info(`Wrote ${writtenFiles[0].path}`);
    } else {
      reporter.info(`Wrote ${['', ...writtenFiles.map(({ path }) => path)].join('\n  ')}`);
    }
    reporter.json({ result, written_files: writtenFiles });

    await this.playAudios(opts.play, writtenFiles, reporter, opts.playCommand ?? null);
  }

  private async generateCurlCommand(
    opts: ReturnType<typeof Tts.resolveOpts>,
    env: typeof process.env,
    globalConfig: ConfigData,
    session: ConfigData,
    reporter: Reporter,
    tts: Hume.tts.PostedTts
  ) {
    const apiKeyProvenance = getApiKeyProvenance(opts, globalConfig, session, env);
    if (!apiKeyProvenance) {
      throw new ApiKeyNotSetError();
    }

    const baseUrl =
      opts.baseUrl ??
      env.HUME_BASE_URL ??
      session.baseUrl ??
      globalConfig.baseUrl ??
      'https://api.hume.ai';
    const apiKey = formatApiKeyForCurl(apiKeyProvenance);

    // Determine the endpoint based on streaming mode
    const endpoint = opts.streaming ? '/v0/tts/stream/json' : '/v0/tts';
    const url = `${baseUrl}${endpoint}`;

    const serialized = HumeSerialization.tts.PostedTts.jsonOrThrow(tts);

    // Generate curl command with URL first
    const curlCommand = [
      `curl "${url}"`,
      `  -H "X-Hume-Api-Key: ${apiKey}"`,
      `  --json '${JSON.stringify(serialized)}'`,
    ].join(' \\\n');

    reporter.info('Generated curl command:');
    console.log(curlCommand);
  }

  async streamInput(rawOpts: StreamInputOpts) {
    const { session, globalConfig, env, reporter } = await this.getSettings(rawOpts);

    // Get API key
    const apiKey = rawOpts.apiKey ?? session.apiKey ?? globalConfig.apiKey ?? env.HUME_API_KEY;
    if (!apiKey) {
      throw new ApiKeyNotSetError();
    }

    // Get base URL
    const baseUrl =
      rawOpts.baseUrl ?? env.HUME_BASE_URL ?? session.baseUrl ?? globalConfig.baseUrl;

    // Resolve options with defaults
    const voiceName = rawOpts.voiceName ?? session.tts?.voiceName ?? globalConfig.tts?.voiceName;
    const voiceId = rawOpts.voiceId ?? session.tts?.voiceId ?? globalConfig.tts?.voiceId;
    const description =
      rawOpts.description ?? session.tts?.description ?? globalConfig.tts?.description;
    const provider = rawOpts.provider ?? session.tts?.provider ?? globalConfig.tts?.provider;
    const speed = rawOpts.speed ?? session.tts?.speed ?? globalConfig.tts?.speed;
    const trailingSilence =
      rawOpts.trailingSilence ??
      session.tts?.trailingSilence ??
      globalConfig.tts?.trailingSilence;
    const instantMode =
      rawOpts.instantMode ?? session.tts?.instantMode ?? globalConfig.tts?.instantMode ?? true;
    const playCommand =
      rawOpts.playCommand ?? session.tts?.playCommand ?? globalConfig.tts?.playCommand;
    const play = rawOpts.play ?? true;

    // Build voice object
    let voice: Hume.tts.PostedUtteranceVoice | undefined;
    if (voiceName) {
      voice =
        provider === 'HUME_AI'
          ? { name: voiceName, provider: 'HUME_AI' }
          : { name: voiceName };
    } else if (voiceId) {
      voice =
        provider === 'HUME_AI' ? { id: voiceId, provider: 'HUME_AI' } : { id: voiceId };
    }

    // Connect to WebSocket
    let client: StreamingTtsClient;
    try {
      await reporter.withSpinner('Connecting to streaming API...', async () => {
        client = await StreamingTtsClient.connect({
          apiKey,
          baseUrl,
          instantMode,
          formatType: 'pcm',
          stripHeaders: true,
        });
      });
    } catch (error) {
      throw new Error(
        `Failed to connect to streaming API: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }

    reporter.info('Connected. Please type your text (Ctrl+D or Ctrl+C to exit):');

    // Set up readline interface
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    // Handle audio playback in parallel
    const handleAudioPlayback = async () => {
      if (!play) {
        // Just consume the messages without playing
        for await (const _chunk of client!) {
          // Do nothing
        }
        return;
      }

      const SilenceFiller = await createSilenceFiller();
      const silenceFiller = new SilenceFiller();

      const playbackPromise = withPcmAudioPlayer(playCommand ?? null, async (writeAudio) => {
        silenceFiller.on('data', (chunk: Buffer) => {
          writeAudio(chunk);
        });

        silenceFiller.on('error', (err: Error) => {
          debug('SilenceFiller error: %O', err);
        });

        for await (const chunk of client!) {
          if (chunk.audio) {
            const buf = Buffer.from(chunk.audio, 'base64');
            silenceFiller.writeAudio(buf);
          }
        }

        await silenceFiller.endStream();
      });

      await playbackPromise;
    };

    // Handle input
    const handleInput = async () => {
      try {
        for await (const line of rl) {
          if (!line.trim()) continue;

          // Try to parse as JSON
          let message: PublishTts;
          try {
            const parsed = JSON.parse(line);
            // If it parses as JSON, send it directly
            message = parsed;
            debug('Sending JSON message: %O', message);
          } catch {
            // Not JSON, wrap as text message
            message = {
              text: line,
              flush: true,
            };

            // Add voice if configured
            if (voice) {
              message.voice = voice;
            }
            if (description) {
              message.description = description;
            }
            if (speed !== null && speed !== undefined) {
              message.speed = speed;
            }
            if (trailingSilence !== null && trailingSilence !== undefined) {
              message.trailingSilence = trailingSilence;
            }

            debug('Sending text message: %O', message);
          }

          client!.send(message);
        }
      } finally {
        // When input ends, close the connection
        debug('Input ended, closing connection');
        client!.sendClose();
      }
    };

    // Handle Ctrl+C gracefully
    const handleExit = () => {
      debug('Received exit signal');
      try {
        client?.disconnect();
      } catch (error) {
        debug('Error disconnecting: %O', error);
      }
      process.exit(0);
    };

    process.on('SIGINT', handleExit);
    process.on('SIGTERM', handleExit);

    try {
      // Run input and playback in parallel
      await Promise.all([handleInput(), handleAudioPlayback()]);
    } catch (error) {
      reporter.warn(
        `Error during streaming: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      throw error;
    } finally {
      process.off('SIGINT', handleExit);
      process.off('SIGTERM', handleExit);
      rl.close();
    }
  }
}
