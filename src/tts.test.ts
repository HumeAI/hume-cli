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

const snippy = (gen: number = 1, snip: number = 0, {text, audio}: {text: string, audio: string} = {
  text: `text_${gen}_${snip}`,
  audio: `audio_${gen}_${snip}`
}): Snippet => ({
  generationId: `gen_${gen}`,
  id: `gen_${gen}_${snip}`,
  text,
  audio
});
const mockSynthesizeJsonStreaming = (
  snippets: Array<Hume.tts.Snippet> = [
    snippy(1, 0),
    snippy(1, 1),
  ]
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
          }
        };
      }
    };
    return asyncIterator as any;
  });
};

const defaultSettings = (
  options?: {
    synthesizeJson?: Mock<HumeClient['tts']['synthesizeJson']>;
    synthesizeJsonStreaming?: Mock<HumeClient['tts']['synthesizeJsonStreaming']>;
  }
): Awaited<ReturnType<Tts['getSettings']>> => {
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
    playAudio?: Mock<Tts['playAudio']>;
    ensureDirAndWriteFile?: Mock<Tts['ensureDirAndWriteFile']>;
    getSettings?: Mock<Tts['getSettings']>;
    getLastSynthesis?: Mock<Tts['getLastSynthesis']>;
    saveLastSynthesis?: Mock<Tts['saveLastSynthesis']>;
  } = {}
) => {
  const settings = args.getSettings ?? defaultSettings({
    synthesizeJson: args.synthesizeJson,
    synthesizeJsonStreaming: args.synthesizeJsonStreaming
  });

  const mocks = Object.freeze({
    ensureDirAndWriteFile: args.ensureDirAndWriteFile ?? mock(() => Promise.resolve()),
    playAudio: args.playAudio ?? mock(() => Promise.resolve()),
    getSettings:
      args.getSettings ?? (mock(() => Promise.resolve(settings)) as Mock<Tts['getSettings']>),
    synthesizeJson: args.synthesizeJson ?? (settings as any).hume.tts.synthesizeJson,
    synthesizeJsonStreaming: args.synthesizeJsonStreaming ?? (settings as any).hume.tts.synthesizeJsonStreaming,
    getLastSynthesis: args.getLastSynthesis ?? mock(() => Promise.resolve(null)),
    saveLastSynthesis: args.saveLastSynthesis ?? mock(() => Promise.resolve()),
  });

  const tts = new Tts();
  tts['ensureDirAndWriteFile'] = mocks.ensureDirAndWriteFile;
  tts['playAudio'] = mocks.playAudio;
  tts['getSettings'] = mocks.getSettings;
  tts['getLastSynthesis'] = () => mocks.getLastSynthesis();
  tts['saveLastSynthesis'] = mocks.saveLastSynthesis;

  return { tts, mocks };
};

describe('CLI flags', () => {
  test('--text', async () => {
    const synthesizeJsonStreaming = mockSynthesizeJsonStreaming([
      snippy(1)
    ]);
    const playAudio = mock(() => Promise.resolve());
    const { tts } = setupTest({
      synthesizeJsonStreaming,
      playAudio
    });

    await tts.synthesize({ text: 'Hello world' });

    expect(synthesizeJsonStreaming).toHaveBeenCalled();
    expect(playAudio).toHaveBeenCalled();
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
    
    const playAudio: Mock<Tts['playAudio']> = mock(() => Promise.resolve());
    const ensureDirAndWriteFile: Mock<Tts['ensureDirAndWriteFile']> = mock(() => Promise.resolve());

    const { tts } = setupTest({
      synthesizeJsonStreaming,
      playAudio,
      ensureDirAndWriteFile
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

    expect(synthesizeJsonStreaming).toHaveBeenCalledWith({
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
    });

    expect(ensureDirAndWriteFile.mock.calls).toEqual([
      ['custom/output/test-gen_1.0.wav', expect.any(Buffer)],
      ['custom/output/test-gen_1.1.wav', expect.any(Buffer)],
      ['custom/output/test-gen_2.0.wav', expect.any(Buffer)],
      ['custom/output/test-gen_2.1.wav', expect.any(Buffer)],
    ]);
  });

  test('uses preset-voice flag to set provider HUME_AI with voiceName', async () => {
    const synthesizeJsonStreaming = mockSynthesizeJsonStreaming([
      snippy()
    ]);

    const { tts, mocks } = setupTest({
      synthesizeJsonStreaming,
    });

    await tts.synthesize({
      text: 'Test with preset voice',
      voiceName: 'test_voice',
      presetVoice: true,
      format: 'wav',
    });

    expect(synthesizeJsonStreaming).toHaveBeenCalledWith({
      utterances: [
        {
          text: 'Test with preset voice',
          voice: { name: 'test_voice', provider: 'HUME_AI' },
        },
      ],
      numGenerations: 1,
      format: { type: 'wav' },
    });
  });

  test('uses preset-voice flag to set provider HUME_AI with voiceId', async () => {
    const synthesizeJsonStreaming = mockSynthesizeJsonStreaming([
      snippy(1)
    ]);

    const { tts, mocks } = setupTest({
      synthesizeJsonStreaming,
    });

    await tts.synthesize({
      text: 'Test with preset voice ID',
      voiceId: 'voice_123',
      presetVoice: true,
      format: 'wav',
    });

    expect(synthesizeJsonStreaming).toHaveBeenCalledWith({
      utterances: [
        {
          text: 'Test with preset voice ID',
          voice: { id: 'voice_123', provider: 'HUME_AI' },
        },
      ],
      numGenerations: 1,
      format: { type: 'wav' },
    });
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
    const playAudio: Mock<Tts['playAudio']> = mock(() => Promise.resolve());

    const { tts } = setupTest({
      synthesizeJsonStreaming,
      ensureDirAndWriteFile,
      playAudio,
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

    expect(synthesizeJsonStreaming).toHaveBeenCalledWith({
      utterances: [
        {
          text: 'Alternative synthesis test',
          voice: { id: 'voice_123' },
          description: 'calm and professional',
        },
      ],
      numGenerations: 3,
      format: { type: 'pcm' },
    });

    expect(ensureDirAndWriteFile.mock.calls).toEqual([
      ['session/output/synth-gen_3.0.pcm', expect.any(Buffer)],
      ['session/output/synth-gen_3.1.pcm', expect.any(Buffer)],
      ['session/output/synth-gen_4.0.pcm', expect.any(Buffer)],
      ['session/output/synth-gen_4.1.pcm', expect.any(Buffer)],
      ['session/output/synth-gen_5.0.pcm', expect.any(Buffer)],
      ['session/output/synth-gen_5.1.pcm', expect.any(Buffer)],
    ]);

    // With play: 'first', only the first generation's snippets should be played
    expect(playAudio).toHaveBeenCalledTimes(2);
    expect(playAudio.mock.calls).toEqual([
      ['session/output/synth-gen_3.0.pcm', undefined],
      ['session/output/synth-gen_3.1.pcm', undefined],
    ]);
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

    const synthesizeJsonStreaming = mockSynthesizeJsonStreaming([
      snippy()
    ]);
    
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
    tts['playAudio'] = mock(() => Promise.resolve());
    tts['getSettings'] = getSettingsMock;
    tts['getLastSynthesis'] = () => Promise.resolve(null);
    tts['saveLastSynthesis'] = mock(() => Promise.resolve());

    await tts.synthesize(opts);

    expect(ensureDirAndWriteFile.mock.calls).toEqual([
      ['config/output/tts-gen_1.0.pcm', expect.any(Buffer)],
    ]);
    
    expect(synthesizeJsonStreaming).toHaveBeenCalledWith({
      numGenerations: 1,
      utterances: [
        {
          text: 'Hello world',
          voice: { id: 'opts_voice' },
        },
      ],
      format: { type: 'pcm' },
    });
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

    const synthesizeJsonStreaming = mockSynthesizeJsonStreaming([
      snippy(10)
    ]);

    const { tts, mocks } = setupTest({
      getLastSynthesis: mock(() => Promise.resolve(lastGeneration)),
      synthesizeJsonStreaming,
    });

    await tts.synthesize({
      text: 'Hello world',
      last: true,
    });

    expect(synthesizeJsonStreaming).toHaveBeenCalledWith({
      format: expect.anything(),
      utterances: expect.anything(),
      context: { generationId: 'gen_1' },
      numGenerations: 1,
    });
  });

  test('uses specified generation when continue is used with index', async () => {
    const lastGeneration = {
      ids: ['gen_1', 'gen_2', 'gen_3'],
      timestamp: Date.now(),
    };

    const synthesizeJsonStreaming = mockSynthesizeJsonStreaming([
      snippy(10)
    ]);
    
    const { tts } = setupTest({
      getLastSynthesis: mock(() => Promise.resolve(lastGeneration)),
      synthesizeJsonStreaming,
    });

    await tts.synthesize({
      text: 'Hello world',
      last: true,
      lastIndex: 2,
    });
    
    expect(synthesizeJsonStreaming).toHaveBeenCalledWith({
      format: expect.anything(),
      utterances: expect.anything(),
      context: { generationId: 'gen_2' },
      numGenerations: 1,
    });
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
    
    const playAudio: Mock<Tts['playAudio']> = mock(() => Promise.resolve());
    const ensureDirAndWriteFile: Mock<Tts['ensureDirAndWriteFile']> = mock(() => Promise.resolve());
    
    const { tts, mocks } = setupTest({
      synthesizeJsonStreaming,
      playAudio,
      ensureDirAndWriteFile
    });

    await tts.synthesize({
      text: 'Test streaming synthesis',
      streaming: true,
      outputDir: 'stream/output',
      prefix: 'stream-',
      format: 'wav',
      play: 'all'
    });

    // Verify synthesizeJsonStreaming was called with the correct parameters
    expect(synthesizeJsonStreaming).toHaveBeenCalled();
    
    // Verify each snippet was written to the correct file with the correct naming pattern
    expect(ensureDirAndWriteFile).toHaveBeenCalledTimes(3);
    expect(ensureDirAndWriteFile.mock.calls).toEqual([
      ['stream/output/stream-gen_1.0.wav', expect.any(Buffer)],
      ['stream/output/stream-gen_1.1.wav', expect.any(Buffer)],
      ['stream/output/stream-gen_1.2.wav', expect.any(Buffer)]
    ]);
    
    // Verify each snippet was played as it was received
    expect(playAudio).toHaveBeenCalledTimes(3);
    expect(playAudio.mock.calls).toEqual([
      ['stream/output/stream-gen_1.0.wav', undefined],
      ['stream/output/stream-gen_1.1.wav', undefined],
      ['stream/output/stream-gen_1.2.wav', undefined]
    ]);
    
    // Verify generation IDs were saved for history/continuation
    expect(mocks.saveLastSynthesis).toHaveBeenCalledWith({
      ids: ['gen_1'],
      timestamp: expect.any(Number)
    });
  });

  test('uses non-streaming path when streaming is disabled', async () => {
    const synthesizeJson = mockSynthesizeJson([{ generationId: 'gen_1', audio: 'audio1' }]);
    const synthesizeJsonStreaming = mockSynthesizeJsonStreaming();
    const { tts, mocks } = setupTest({
      synthesizeJson,
      synthesizeJsonStreaming
    });

    await tts.synthesize({
      text: 'Test with streaming disabled',
      streaming: false
    });

    expect(synthesizeJson).toHaveBeenCalled();
    expect(mocks.synthesizeJsonStreaming).not.toHaveBeenCalled();
  });
});
