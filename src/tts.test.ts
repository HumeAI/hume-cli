import { expect, test, mock, describe, type Mock } from 'bun:test';
import { Tts, type SynthesisOpts } from './tts';
import type { Hume } from 'hume';
import { HumeClient } from 'hume';
import type { ConfigData } from './config';

const stubGen = (id: number) => ({
  generationId: `gen_${id}`,
  audio: `audio${id}`,
});

const mockSynthesizeJson = (
  generations: Partial<Hume.tts.ReturnGeneration>[] = [stubGen(1)]
): Mock<HumeClient['tts']['synthesizeJson']> => {
  return mock(() => Promise.resolve({ generations }) as any);
};

const defaultSettings = (
  synthesizeJson?: Mock<HumeClient['tts']['synthesizeJson']>
): Awaited<ReturnType<Tts['getSettings']>> => {
  return {
    session: {} as ConfigData,
    globalConfig: {} as ConfigData,
    env: { HUME_API_KEY: 'test-key' },
    reporter: {
      mode: 'pretty',
      json: mock(() => {}),
      info: mock(() => {}),
      withSpinner: mock((message, callback) => callback()),
    },
    hume: {
      tts: { synthesizeJson: synthesizeJson ?? mockSynthesizeJson() },
    } as unknown as HumeClient,
  };
};

const setupTest = (
  args: {
    synthesizeJson?: Mock<HumeClient['tts']['synthesizeJson']>;
    playAudio?: Mock<Tts['playAudio']>;
    ensureDirAndWriteFile?: Mock<Tts['ensureDirAndWriteFile']>;
    getSettings?: Mock<Tts['getSettings']>;
    getLastSynthesis?: Mock<Tts['getLastSynthesis']>;
    saveLastSynthesis?: Mock<Tts['saveLastSynthesis']>;
  } = {}
) => {
  const settings = args.getSettings ?? defaultSettings(args.synthesizeJson ?? mockSynthesizeJson());

  const mocks = Object.freeze({
    ensureDirAndWriteFile: args.ensureDirAndWriteFile ?? mock(() => Promise.resolve()),
    playAudio: args.playAudio ?? mock(() => Promise.resolve()),
    getSettings:
      args.getSettings ?? (mock(() => Promise.resolve(settings)) as Mock<Tts['getSettings']>),
    synthesizeJson: args.synthesizeJson ?? mockSynthesizeJson(),
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
    const { tts, mocks } = setupTest();

    await tts.synthesize({ text: 'Hello world' });

    expect(mocks.playAudio).toHaveBeenCalled();
  });
});

describe('TTS scenarios', () => {
  test('wav with voice name, description, context, multiple generations', async () => {
    const synthesizeJson = mockSynthesizeJson([
      { generationId: 'gen_1', audio: 'audio1' },
      { generationId: 'gen_2', audio: 'audio2' },
    ]);

    const { tts, mocks } = setupTest({
      synthesizeJson,
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

    expect(mocks.synthesizeJson.mock.calls).toEqual([
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
        },
      ],
    ]);

    expect(mocks.ensureDirAndWriteFile.mock.calls).toEqual([
      ['custom/output/test-gen_1.wav', expect.any(Buffer)],
      ['custom/output/test-gen_2.wav', expect.any(Buffer)],
    ]);
  });

  test('uses preset-voice flag to set provider HUME_AI with voiceName', async () => {
    const synthesizeJson = mockSynthesizeJson([{ generationId: 'gen_1', audio: 'audio1' }]);

    const { tts, mocks } = setupTest({
      synthesizeJson,
    });

    await tts.synthesize({
      text: 'Test with preset voice',
      voiceName: 'test_voice',
      presetVoice: true,
      format: 'wav',
    });

    expect(mocks.synthesizeJson.mock.calls).toEqual([
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
        },
      ],
    ]);
  });

  test('uses preset-voice flag to set provider HUME_AI with voiceId', async () => {
    const synthesizeJson = mockSynthesizeJson([{ generationId: 'gen_1', audio: 'audio1' }]);

    const { tts, mocks } = setupTest({
      synthesizeJson,
    });

    await tts.synthesize({
      text: 'Test with preset voice ID',
      voiceId: 'voice_123',
      presetVoice: true,
      format: 'wav',
    });

    expect(mocks.synthesizeJson.mock.calls).toEqual([
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
        },
      ],
    ]);
  });

  test('pcm with voice ID and multiple generations', async () => {
    const result = {
      generations: [
        { generationId: 'gen_3', audio: 'audio3' },
        { generationId: 'gen_4', audio: 'audio4' },
        { generationId: 'gen_5', audio: 'audio5' },
      ],
    };

    const synthesizeJson = mockSynthesizeJson(result.generations);

    const { tts, mocks } = setupTest({
      synthesizeJson,
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

    expect(synthesizeJson.mock.calls).toEqual([
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
        },
      ],
    ]);

    expect(mocks.ensureDirAndWriteFile.mock.calls).toEqual([
      ['session/output/synth-gen_3.pcm', expect.any(Buffer)],
      ['session/output/synth-gen_4.pcm', expect.any(Buffer)],
      ['session/output/synth-gen_5.pcm', expect.any(Buffer)],
    ]);

    expect(mocks.playAudio).toHaveBeenCalledTimes(1);
    expect(mocks.playAudio).toHaveBeenCalledWith('session/output/synth-gen_3.pcm', undefined);
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

    const settings = {
      ...defaultSettings(),
      globalConfig: config,
      session: session,
      env: {
        HUME_API_KEY: 'key-from-env',
      },
    };

    const { tts, mocks } = setupTest({
      getSettings: mock(() => Promise.resolve(settings)),
    });

    await tts.synthesize(opts);

    expect(mocks.ensureDirAndWriteFile.mock.calls).toEqual([
      ['config/output/tts-gen_1.pcm', expect.any(Buffer)],
    ]);
    expect((settings.hume!.tts.synthesizeJson as any).mock.calls).toEqual([
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

    const synthesizeJson = mockSynthesizeJson();

    const { tts, mocks } = setupTest({
      getLastSynthesis: mock(() => Promise.resolve(lastGeneration)),
      synthesizeJson,
    });

    await tts.synthesize({
      text: 'Hello world',
      last: true,
    });

    const synthesizeCall = await synthesizeJson.mock.calls[0][0];
    expect(mocks.synthesizeJson.mock.calls).toEqual([
      [
        {
          format: expect.anything(),
          utterances: expect.anything(),
          context: { generationId: 'gen_1' },
          numGenerations: 1,
        },
      ],
    ]);
  });

  test('uses specified generation when continue is used with index', async () => {
    const lastGeneration = {
      ids: ['gen_1', 'gen_2', 'gen_3'],
      timestamp: Date.now(),
    };

    const synthesizeJson = mockSynthesizeJson();
    const { tts, mocks } = setupTest({
      getLastSynthesis: mock(() => Promise.resolve(lastGeneration)),
      synthesizeJson,
    });

    await tts.synthesize({
      text: 'Hello world',
      last: true,
      lastIndex: 2,
    });
    expect(mocks.synthesizeJson.mock.calls).toEqual([
      [
        {
          format: expect.anything(),
          utterances: expect.anything(),
          context: { generationId: 'gen_2' },
          numGenerations: 1,
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
