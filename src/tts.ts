import { mkdir, writeFile } from 'node:fs/promises';
import { getLastSynthesisFromHistory, saveLastSynthesisToHistory } from './history';
import { join, dirname } from 'path';
import { assert } from 'node:console';
import { debug, type CommonOpts, getSettings, ApiKeyNotSetError, type Reporter } from './common';
import type { ConfigData } from './config';
import type { Hume } from 'hume';

const findAudioPlayer = (customCommand?: string): string | null => {
  if (customCommand) {
    return customCommand;
  }

  const isWindows = process.platform === 'win32';

  // List of popular CLI audio players, in order of preference
  // Include Windows-specific options first when on Windows
  const commonPlayers = isWindows
    ? [
        { cmd: 'powershell', args: `-c "(New-Object Media.SoundPlayer '$AUDIO_FILE').PlaySync()"` },
        { cmd: 'ffplay', args: '-nodisp -autoexit' },
        { cmd: 'mpv', args: '--no-video' },
        { cmd: 'mplayer', args: '' },
      ]
    : [
        { cmd: 'ffplay', args: '-nodisp -autoexit' },
        { cmd: 'afplay', args: '' }, // macOS
        { cmd: 'mplayer', args: '' },
        { cmd: 'mpv', args: '--no-video' },
        { cmd: 'aplay', args: '' }, // Linux
        { cmd: 'play', args: '' }, // SoX
      ];

  for (const player of commonPlayers) {
    try {
      // Quick check if command exists in PATH
      // Use "where" on Windows, "which" on other platforms
      const checkCmd = isWindows ? 'where' : 'which';
      Bun.spawnSync([checkCmd, player.cmd]);

      return player.args
        ? `${player.cmd} ${player.args.includes('$AUDIO_FILE') ? player.args : '$AUDIO_FILE ' + player.args}`.trim()
        : `${player.cmd} $AUDIO_FILE`;
    } catch (e) {
      // Command not found, try next one
      continue;
    }
  }

  return null;
};

const playAudio = (path: string, playCommand?: string): Promise<unknown> => {
  const command = findAudioPlayer(playCommand);
  const isWindows = process.platform === 'win32';

  if (!command) {
    throw new Error(
      'No audio player found. Please install ffplay or specify a custom player with --play-command'
    );
  }

  // Replace template variable with actual path
  // Ensure path is properly quoted for Windows paths with spaces
  const sanitizedPath = isWindows ? path.replace(/\\/g, '\\\\') : path;
  const finalCommand = command.replace('$AUDIO_FILE', sanitizedPath);

  // If using PowerShell on Windows, handle it specially
  if (isWindows && finalCommand.startsWith('powershell')) {
    // For PowerShell, we need to be careful with argument passing
    return Bun.spawn(['powershell', '-c', finalCommand.substring('powershell -c '.length)], {
      stdout: 'ignore',
      stderr: 'ignore',
    }).exited;
  }

  // Split into command and args for proper execution
  // This splitting is tricky with quotes, so we'll do a simple version that works for most cases
  const parts = finalCommand.split(' ');
  const cmd = parts[0];
  const args = parts.slice(1).filter((arg) => arg.length > 0);

  return Bun.spawn([cmd, ...args], {
    stdout: 'ignore',
    stderr: 'ignore',
  }).exited;
};

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
  text: string;
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
};

export class Tts {
  // Exposed for testing
  ensureDirAndWriteFile = async (path: string, data: Buffer) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  };
  getSettings = getSettings;
  playAudio = playAudio;
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
    paths: Array<string>,
    reporter: Reporter,
    playCommand?: string
  ) {
    if (play === 'off') {
      return;
    }
    if (play === 'first') {
      await reporter.withSpinner(`Playing audio ${paths[0]}`, async () => {
        await this.playAudio(paths[0], playCommand);
      });
      return;
    }
    if (play === 'all') {
      const n = paths.length;
      for (const i in paths) {
        const path = paths[i];
        await reporter.withSpinner(`Playing audio ${path} (${Number(i) + 1} of ${n})`, async () => {
          await this.playAudio(path, playCommand);
        });
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
      text,
      speed: opts.speed,
      trailingSilence: opts.trailingSilence,
      provider: opts.provider,
    });

    const tts: Hume.tts.PostedTts = {
      utterances: [utterance],
      numGenerations: outputOpts.numGenerations,
      format: { type: opts.format },
    };

    await this.maybeAddContext(opts, tts);

    if (!hume) {
      throw new ApiKeyNotSetError();
    }

    if (opts.streaming) {
      reporter.info('Using streaming mode');
      const generationIds = new Set<string>();
      const writtenFiles: Array<{ generationId: string; path: string }> = [];

      debug('Request payload: %O', JSON.stringify(tts, null, 2));

      await reporter.withSpinner('Synthesizing...', async () => {
        let snippetIndex = 0;
        let currentGenerationId: string | null = null;
        for await (const snippet of await hume.tts.synthesizeJsonStreaming(tts)) {
          if (currentGenerationId !== snippet.generationId) {
            debug(`New generation ID: ${snippet.generationId}`);
            snippetIndex = 0;
            currentGenerationId = snippet.generationId;
          }
          debug('Streaming snippet: %O', JSON.stringify(snippet, null, 2));
          debug(`snippetIndex: ${snippetIndex}; currentGenerationId: ${currentGenerationId}`);

          // Add generation ID to the set for history
          generationIds.add(snippet.generationId);

          const path =
            outputOpts.type === 'path'
              ? `${outputOpts.path}.${snippetIndex}`
              : join(
                  outputOpts.dir,
                  `${outputOpts.prefix}${snippet.generationId}.${snippetIndex}.${outputOpts.format}`
                );

          await this.ensureDirAndWriteFile(path, Buffer.from(snippet.audio, 'base64'));

          writtenFiles.push({
            generationId: snippet.generationId,
            path,
          });

          // Log the generation ID for the first snippet
          if (snippetIndex === 0) {
            reporter.info(`Generation ID: ${snippet.generationId}`);
          }

          // Play the audio if requested
          if (opts.play !== 'off') {
            // For 'first' play option, only play snippets from the first generation ID
            if (
              opts.play === 'first' &&
              !Array.from(generationIds).every((id) => id === snippet.generationId)
            ) {
              snippetIndex++;
              continue; // Skip playing this snippet as it's not from the first generation
            }
            reporter.info(`Playing snippet ${snippetIndex} of ${snippet.generationId}`);
            await this.playAudio(path, opts.playCommand);
          }
          snippetIndex++;
        }
      });

      // Save generation IDs for history/continuation
      await this.saveLastSynthesis({
        ids: Array.from(generationIds),
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
        generationIds: Array.from(generationIds),
      });

      return;
    }

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
    await this.playAudios(
      opts.play,
      writtenFiles.map(({ path }) => path),
      reporter,
      opts.playCommand
    );
  }
}
