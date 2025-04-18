import { expect, test, mock, describe, type Mock } from 'bun:test';
import { Tts, type SynthesisOpts } from './tts';
import type { Hume } from 'hume';
import { HumeClient } from 'hume';
import type { ConfigData } from './config';
import type { Snippet } from 'hume/api/resources/tts';

const stubGen = (id: number) => ({
  generationId: `gen_${id}`,
  audio: `audio${id}`,
});

const mockSynthesizeJson = (
  generations: Partial<Hume.tts.ReturnGeneration>[] = [stubGen(1)]
): Mock<HumeClient['tts']['synthesizeJson']> => {
  return mock(() => Promise.resolve({ generations }) as any);
};

const snippy = (
  gen: number = 1,
  snip: number = 0,
  { text, audio }: { text: string; audio: string } = {
    text: `text_${gen}_${snip}`,
    audio: `audio_${gen}_${snip}`,
  }
): Snippet => ({
  generationId: `gen_${gen}`,
  id: `gen_${gen}_${snip}`,
  text,
  audio,
});
const mockSynthesizeJsonStreaming = (
  snippets: Array<Hume.tts.Snippet> = [snippy(1, 0), snippy(1, 1)]
): Mock<HumeClient['tts']['synthesizeJsonStreaming']> => {
  return mock(() => {
    const asyncIterator = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            if (snippets.length === 0) {
              return { done: true, value: undefined };
            }
            const snippet = snippets.shift();
            return { done: false, value: snippet };
          },
        };
      },
    };
    return asyncIterator as any;
  });
};

const defaultSettings = (options?: {
  synthesizeJson?: Mock<HumeClient['tts']['synthesizeJson']>;
  synthesizeJsonStreaming?: Mock<HumeClient['tts']['synthesizeJsonStreaming']>;
}): Awaited<ReturnType<Tts['getSettings']>> => {
  const synthesizeJson = options?.synthesizeJson ?? mockSynthesizeJson();
  const synthesizeJsonStreaming = options?.synthesizeJsonStreaming ?? mockSynthesizeJsonStreaming();

  return {
    session: {} as ConfigData,
    globalConfig: {} as ConfigData,
    env: { HUME_API_KEY: 'test-key' },
    reporter: {
      mode: 'pretty',
      json: mock(() => {}),
      info: mock(() => {}),
      warn: mock(() => {}),
      withSpinner: mock((_message, callback) => callback()),
    },
    hume: {
      tts: {
        synthesizeJson,
        synthesizeJsonStreaming,
      },
    } as unknown as HumeClient,
  };
};

const setupTest = (
  args: {
    synthesizeJson?: Mock<HumeClient['tts']['synthesizeJson']>;
    synthesizeJsonStreaming?: Mock<HumeClient['tts']['synthesizeJsonStreaming']>;
    playAudioFile?: Mock<any>;
    writeAudio?: Mock<any>;
    ensureDirAndWriteFile?: Mock<any>;
    getSettings?: Mock<any>;
    getLastSynthesis?: Mock<any>;
    saveLastSynthesis?: Mock<any>;
  } = {}
) => {
  const settings =
    args.getSettings ??
    defaultSettings({
      synthesizeJson: args.synthesizeJson,
      synthesizeJsonStreaming: args.synthesizeJsonStreaming,
    });

  const mocks = Object.freeze({
    ensureDirAndWriteFile: args.ensureDirAndWriteFile ?? mock(() => Promise.resolve()),
    playAudioFile: args.playAudioFile ?? mock(() => Promise.resolve()),
    writeAudio: args.writeAudio ?? mock(() => Promise.resolve()),
    getSettings: args.getSettings ?? mock(() => Promise.resolve(settings)),
    synthesizeJson: args.synthesizeJson ?? (settings as any).hume.tts.synthesizeJson,
    synthesizeJsonStreaming:
      args.synthesizeJsonStreaming ?? (settings as any).hume.tts.synthesizeJsonStreaming,
    getLastSynthesis: args.getLastSynthesis ?? mock(() => Promise.resolve(null)),
    saveLastSynthesis: args.saveLastSynthesis ?? mock(() => Promise.resolve()),
  });

  const tts = new Tts();
  tts['ensureDirAndWriteFile'] = mocks.ensureDirAndWriteFile;
  tts['playAudioFile'] = mocks.playAudioFile;
  tts['withStdinAudioPlayer'] = (_, f) => f(mocks.writeAudio);
  tts['getSettings'] = mocks.getSettings;
  tts['getLastSynthesis'] = () => mocks.getLastSynthesis();
  tts['saveLastSynthesis'] = mocks.saveLastSynthesis;

  return { tts, mocks };
};

describe('CLI flags', () => {
  test('--text', async () => {
    const synthesizeJsonStreaming = mockSynthesizeJsonStreaming([snippy(1)]);
    const { tts, mocks } = setupTest({
      synthesizeJsonStreaming,
    });

    await tts.synthesize({ text: 'Hello world' });

    expect(synthesizeJsonStreaming).toHaveBeenCalled();
    expect(mocks.writeAudio).toHaveBeenCalled();
  });
});

describe('TTS scenarios', () => {
  test('wav with voice name, description, context, multiple generations', async () => {
    const synthesizeJsonStreaming = mockSynthesizeJsonStreaming([
      snippy(1, 0),
      snippy(1, 1),
      snippy(2, 0),
      snippy(2, 1),
    ]);

    const ensureDirAndWriteFile: Mock<Tts['ensureDirAndWriteFile']> = mock(() => Promise.resolve());

    const { tts } = setupTest({
      synthesizeJsonStreaming,
      ensureDirAndWriteFile,
    });

    await tts.synthesize({
      text: 'Test complete synthesis',
      voiceName: 'test_voice',
      description: 'test description',
      contextGenerationId: 'prev_gen',
      numGenerations: 2,
      outputDir: 'custom/output',
      prefix: 'test-',
      play: 'all',
      format: 'wav',
      json: true,
    });

    expect(synthesizeJsonStreaming.mock.calls).toEqual([
      [
        {
          utterances: [
            {
              text: 'Test complete synthesis',
              voice: { name: 'test_voice' },
              description: 'test description',
            },
          ],
          context: { generationId: 'prev_gen' },
          numGenerations: 2,
          format: { type: 'wav' },
          stripHeaders: true,
        },
      ],
    ]);

    // With our changes, we now only create 2 files (one combined file per generation)
    expect(ensureDirAndWriteFile).toHaveBeenCalledTimes(2);

    // Extract just the file paths from the calls
    const writtenPaths = ensureDirAndWriteFile.mock.calls.map((call) => call[0]);

    // Check that only the combined files were written
    expect(writtenPaths).toContain('custom/output/test-gen_1.wav');
    expect(writtenPaths).toContain('custom/output/test-gen_2.wav');
  });

  test('uses preset-voice flag to set provider HUME_AI with voiceName', async () => {
    const synthesizeJsonStreaming = mockSynthesizeJsonStreaming([snippy()]);

    const { tts } = setupTest({
      synthesizeJsonStreaming,
    });

    await tts.synthesize({
      text: 'Test with preset voice',
      voiceName: 'test_voice',
      presetVoice: true,
      format: 'wav',
    });

    expect(synthesizeJsonStreaming.mock.calls).toEqual([
      [
        {
          utterances: [
            {
              text: 'Test with preset voice',
              voice: { name: 'test_voice', provider: 'HUME_AI' },
            },
          ],
          numGenerations: 1,
          format: { type: 'wav' },
          stripHeaders: true,
        },
      ],
    ]);
  });

  test('uses preset-voice flag to set provider HUME_AI with voiceId', async () => {
    const synthesizeJsonStreaming = mockSynthesizeJsonStreaming([snippy(1)]);

    const { tts } = setupTest({
      synthesizeJsonStreaming,
    });

    await tts.synthesize({
      text: 'Test with preset voice ID',
      voiceId: 'voice_123',
      presetVoice: true,
      format: 'wav',
    });

    expect(synthesizeJsonStreaming.mock.calls).toEqual([
      [
        {
          utterances: [
            {
              text: 'Test with preset voice ID',
              voice: { id: 'voice_123', provider: 'HUME_AI' },
            },
          ],
          numGenerations: 1,
          format: { type: 'wav' },
          stripHeaders: true,
        },
      ],
    ]);
  });

  test('uses provider option to set provider with voiceId', async () => {
    const synthesizeJsonStreaming = mockSynthesizeJsonStreaming([snippy(1)]);

    const { tts } = setupTest({
      synthesizeJsonStreaming,
    });

    await tts.synthesize({
      text: 'Test with provider option',
      voiceId: 'voice_123',
      provider: 'HUME_AI',
      format: 'wav',
    });

    expect(synthesizeJsonStreaming.mock.calls).toEqual([
      [
        {
          utterances: [
            {
              text: 'Test with provider option',
              voice: { id: 'voice_123', provider: 'HUME_AI' },
            },
          ],
          numGenerations: 1,
          format: { type: 'wav' },
          stripHeaders: true,
        },
      ],
    ]);
  });

  test('pcm with voice ID and multiple generations', async () => {
    const synthesizeJsonStreaming = mockSynthesizeJsonStreaming([
      snippy(3, 0),
      snippy(3, 1),
      snippy(4, 0),
      snippy(4, 1),
      snippy(5, 0),
      snippy(5, 1),
    ]);

    const ensureDirAndWriteFile: Mock<Tts['ensureDirAndWriteFile']> = mock(() => Promise.resolve());
    const writeAudio: Mock<(buffer: Buffer) => void> = mock(() => Promise.resolve());

    const { tts } = setupTest({
      synthesizeJsonStreaming,
      ensureDirAndWriteFile,
      writeAudio,
    });

    await tts.synthesize({
      text: 'Alternative synthesis test',
      voiceId: 'voice_123',
      description: 'calm and professional',
      numGenerations: 3,
      outputDir: 'session/output',
      prefix: 'synth-',
      play: 'first',
      format: 'pcm',
      pretty: true,
    });

    expect(synthesizeJsonStreaming.mock.calls).toEqual([
      [
        {
          utterances: [
            {
              text: 'Alternative synthesis test',
              voice: { id: 'voice_123' },
              description: 'calm and professional',
            },
          ],
          numGenerations: 3,
          format: { type: 'pcm' },
          stripHeaders: true,
        },
      ],
    ]);

    // With our changes, we now only create 3 files (one combined file per generation)
    expect(ensureDirAndWriteFile).toHaveBeenCalledTimes(3);

    // Extract just the file paths from the calls
    const writtenPaths = ensureDirAndWriteFile.mock.calls.map((call) => call[0]);

    // Check that only the combined files were written
    expect(writtenPaths).toContain('session/output/synth-gen_3.pcm');
    expect(writtenPaths).toContain('session/output/synth-gen_4.pcm');
    expect(writtenPaths).toContain('session/output/synth-gen_5.pcm');

    // Verify audio playback for snippets from the first generation
    // (with play: 'first', only the first generation's snippets should be played)
    expect(writeAudio).toHaveBeenCalledTimes(2);

    // Verify all playback is done with Buffer objects (using stdin)
    const playedBuffers = writeAudio.mock.calls.filter((call) => call[0] instanceof Buffer).length;
    expect(playedBuffers).toBe(2); // Both snippets from first generation should be played
  });

  test('settings cascade env -> globalConfig -> session -> opts', async () => {
    const config: ConfigData = {
      tts: {
        voiceName: 'config_voice',
        outputDir: 'config/output',
        play: 'first',
        format: 'wav',
      },
    };

    const session: ConfigData = {
      tts: {
        voiceName: 'config_voice_2',
        play: 'all',
        format: 'mp3',
      },
      apiKey: 'key-from-session',
    };
    const opts: SynthesisOpts = {
      text: 'Hello world',
      voiceId: 'opts_voice',
      format: 'pcm',
    };

    const synthesizeJsonStreaming = mockSynthesizeJsonStreaming([snippy()]);

    const ensureDirAndWriteFile: Mock<Tts['ensureDirAndWriteFile']> = mock(() => Promise.resolve());

    const getSettingsMock = mock(() => {
      return Promise.resolve({
        session: session,
        globalConfig: config,
        env: { HUME_API_KEY: 'key-from-env' },
        reporter: {
          mode: 'pretty',
          json: mock(() => {}),
          info: mock(() => {}),
          warn: mock(() => {}),
          withSpinner: mock((_message, callback) => callback()),
        },
        hume: {
          tts: {
            synthesizeJsonStreaming,
            synthesizeJson: mockSynthesizeJson(),
          },
        } as unknown as HumeClient,
      });
    });

    const tts = new Tts();
    tts['ensureDirAndWriteFile'] = ensureDirAndWriteFile;
    tts['getSettings'] = getSettingsMock;
    tts['getLastSynthesis'] = () => Promise.resolve(null);
    tts['saveLastSynthesis'] = mock(() => Promise.resolve());

    await tts.synthesize(opts);

    // With our changes, we now only expect 1 combined file per generation
    expect(ensureDirAndWriteFile).toHaveBeenCalledTimes(1);

    // Extract just the file path from the call
    const writtenPath = ensureDirAndWriteFile.mock.calls[0][0];

    // Check that only the combined file was written
    expect(writtenPath).toBe('config/output/tts-gen_1.pcm');

    expect(synthesizeJsonStreaming.mock.calls).toEqual([
      [
        {
          numGenerations: 1,
          utterances: [
            {
              text: 'Hello world',
              voice: { id: 'opts_voice' },
            },
          ],
          format: { type: 'pcm' },
          stripHeaders: true,
        },
      ],
    ]);
  });
});

describe('continue functionality', () => {
  test('throws error when continue is used without previous generation', async () => {
    const { tts } = setupTest({
      getLastSynthesis: mock(() => Promise.resolve(null)),
    });

    await expect(
      tts.synthesize({
        text: 'Hello world',
        last: true,
        lastIndex: 1,
      })
    ).rejects.toThrow('No previous generation found to continue from');
  });

  test('uses first generation when continue is used without index', async () => {
    const lastGeneration = {
      ids: ['gen_1'],
      timestamp: Date.now(),
    };

    const synthesizeJsonStreaming = mockSynthesizeJsonStreaming([snippy(10)]);

    const { tts, mocks } = setupTest({
      getLastSynthesis: mock(() => Promise.resolve(lastGeneration)),
      synthesizeJsonStreaming,
    });

    await tts.synthesize({
      text: 'Hello world',
      last: true,
    });

    expect(synthesizeJsonStreaming.mock.calls).toEqual([
      [
        {
          format: expect.anything(),
          utterances: expect.anything(),
          context: { generationId: 'gen_1' },
          numGenerations: 1,
          stripHeaders: true,
        },
      ],
    ]);
  });

  test('uses specified generation when continue is used with index', async () => {
    const lastGeneration = {
      ids: ['gen_1', 'gen_2', 'gen_3'],
      timestamp: Date.now(),
    };

    const synthesizeJsonStreaming = mockSynthesizeJsonStreaming([snippy(10)]);

    const { tts } = setupTest({
      getLastSynthesis: mock(() => Promise.resolve(lastGeneration)),
      synthesizeJsonStreaming,
    });

    await tts.synthesize({
      text: 'Hello world',
      last: true,
      lastIndex: 2,
    });

    expect(synthesizeJsonStreaming.mock.calls).toEqual([
      [
        {
          format: expect.anything(),
          utterances: expect.anything(),
          context: { generationId: 'gen_2' },
          numGenerations: 1,
          stripHeaders: true,
        },
      ],
    ]);
  });

  test('throws error when continue index is invalid', async () => {
    const lastGeneration = {
      ids: ['gen_1', 'gen_2'],
      timestamp: Date.now(),
    };

    const { tts } = setupTest({
      getLastSynthesis: mock(() => Promise.resolve(lastGeneration)),
    });

    await expect(
      tts.synthesize({
        text: 'Hello world',
        last: true,
        lastIndex: 3,
      })
    ).rejects.toThrow(
      'Unexpected: previous synthesis contained 2 generations. Please specify --last-index as a number between 1 and 2 to select from the previous synthesis'
    );
  });
});

describe('streaming functionality', () => {
  test('streams synthesis using synthesizeJsonStreaming', async () => {
    const synthesizeJsonStreaming = mockSynthesizeJsonStreaming([
      snippy(1, 0),
      snippy(1, 1),
      snippy(1, 2),
    ]);

    const writeAudio: Mock<(buffer: Buffer) => void> = mock(() => Promise.resolve());
    const ensureDirAndWriteFile: Mock<Tts['ensureDirAndWriteFile']> = mock(() => Promise.resolve());

    const { tts, mocks } = setupTest({
      synthesizeJsonStreaming,
      writeAudio,
      ensureDirAndWriteFile,
    });

    await tts.synthesize({
      text: 'Test streaming synthesis',
      streaming: true,
      outputDir: 'stream/output',
      prefix: 'stream-',
      format: 'wav',
      play: 'all',
    });

    // Verify synthesizeJsonStreaming was called with the correct parameters
    expect(synthesizeJsonStreaming).toHaveBeenCalled();

    // We expect only 1 file (the combined output)
    expect(ensureDirAndWriteFile).toHaveBeenCalledTimes(1);

    // Extract the file path from the call
    const writtenPath = ensureDirAndWriteFile.mock.calls[0][0];

    // Check that only the combined file was written
    expect(writtenPath).toBe('stream/output/stream-gen_1.wav');

    // Verify the correct number of audio playback calls (one for each snippet)
    expect(writeAudio).toHaveBeenCalledTimes(3);

    // With stdin playback, we should be using Buffer objects in the calls
    const playedBuffers = writeAudio.mock.calls.filter((call) => call[0] instanceof Buffer).length;
    expect(playedBuffers).toBe(3); // All 3 snippets should be played via stdin

    // Verify generation IDs were saved for history/continuation
    expect(mocks.saveLastSynthesis).toHaveBeenCalledWith({
      ids: ['gen_1'],
      timestamp: expect.any(Number),
    });
  });

  test('filters out empty audio chunks during streaming', async () => {
    // Create test data with one empty audio chunk in between valid chunks
    const testSnippets = [
      snippy(1, 0, { text: 'Hello', audio: 'audio1' }),
      // Empty audio chunk that should be filtered out
      { ...snippy(1, 1, { text: 'Empty', audio: '' }), audio: '' },
      snippy(1, 2, { text: 'World', audio: 'audio3' }),
    ];

    const synthesizeJsonStreaming = mockSynthesizeJsonStreaming(testSnippets);
    const writeAudio: Mock<(buffer: Buffer) => void> = mock(() => Promise.resolve());
    const ensureDirAndWriteFile: Mock<Tts['ensureDirAndWriteFile']> = mock(() => Promise.resolve());

    const { tts } = setupTest({
      synthesizeJsonStreaming,
      writeAudio,
      ensureDirAndWriteFile,
    });

    await tts.synthesize({
      text: 'Test empty audio filtering',
      streaming: true,
      outputDir: 'stream/output',
      prefix: 'stream-',
      format: 'wav',
      play: 'all',
    });

    // Verify only 1 file is written (the combined file)
    expect(ensureDirAndWriteFile).toHaveBeenCalledTimes(1);

    // Extract the file path from the call
    const writtenPath = ensureDirAndWriteFile.mock.calls[0][0];

    // Check that only the combined file was written
    expect(writtenPath).toBe('stream/output/stream-gen_1.wav');

    // Verify only non-empty chunks are played
    expect(writeAudio).toHaveBeenCalledTimes(2); // Only 2 chunks out of 3 should be played

    // With stdin playback, we should be using Buffer objects in the calls
    const playedBuffers = writeAudio.mock.calls.filter((call) => call[0] instanceof Buffer).length;
    expect(playedBuffers).toBe(2); // Both non-empty snippets should be played via stdin
  });

  test('uses non-streaming path when streaming is disabled', async () => {
    const synthesizeJson = mockSynthesizeJson([{ generationId: 'gen_1', audio: 'audio1' }]);
    const synthesizeJsonStreaming = mockSynthesizeJsonStreaming();
    const { tts, mocks } = setupTest({
      synthesizeJson,
      synthesizeJsonStreaming,
    });

    await tts.synthesize({
      text: 'Test with streaming disabled',
      streaming: false,
    });

    expect(synthesizeJson).toHaveBeenCalled();
    expect(mocks.synthesizeJsonStreaming).not.toHaveBeenCalled();
  });
});

describe('instant mode functionality', () => {
  test('uses instant mode in streaming request', async () => {
    const synthesizeJsonStreaming = mockSynthesizeJsonStreaming([snippy(1, 0), snippy(1, 1)]);

    const { tts } = setupTest({
      synthesizeJsonStreaming,
    });

    await tts.synthesize({
      text: 'Test instant mode',
      streaming: true,
      instantMode: true,
      voiceName: 'test_voice', // Add voice name to satisfy validation
    });

    // Verify synthesizeJsonStreaming was called with instantMode set to true
    expect(synthesizeJsonStreaming.mock.calls).toEqual([
      [
        expect.objectContaining({
          instantMode: true,
          numGenerations: 1,
          stripHeaders: true,
          utterances: [
            expect.objectContaining({
              voice: expect.objectContaining({
                name: 'test_voice'
              })
            })
          ]
        }),
      ],
    ]);
  });

  test('throws error when instantMode is enabled but streaming is disabled', async () => {
    const { tts } = setupTest();

    await expect(
      tts.synthesize({
        text: 'Test instant mode with streaming disabled',
        streaming: false,
        instantMode: true,
      })
    ).rejects.toThrow('Instant mode requires streaming to be enabled');
  });

  test('throws error when instantMode is enabled with multiple generations', async () => {
    const { tts } = setupTest();

    await expect(
      tts.synthesize({
        text: 'Test instant mode with multiple generations',
        streaming: true,
        instantMode: true,
        numGenerations: 2,
      })
    ).rejects.toThrow('Instant mode requires num_generations=1');
  });

  test('throws error when instantMode is enabled without a voice', async () => {
    const { tts } = setupTest();

    await expect(
      tts.synthesize({
        text: 'Test instant mode without voice',
        streaming: true,
        instantMode: true,
      })
    ).rejects.toThrow('Instant mode requires a voice to be specified (use --voice-name or --voice-id)');
  });
});
