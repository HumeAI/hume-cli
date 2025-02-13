import { expect, test, mock, describe, type Mock } from 'bun:test';
import { Voice } from './save_voice';
import type { HumeClient } from 'hume';
import type { getSettings } from './common';
import type { ReturnVoice } from 'hume/api/resources/tts';
import type { ConfigData } from './config';

const setupTest = (result: number | null) => {
  let lastSynthesisResult: Awaited<ReturnType<Voice['getLastSynthesis']>> = null;
  if (result !== null) {
    lastSynthesisResult = {
      ids: Array.from({ length: result }, (_, i) => `gen_${i + 1}`),
      timestamp: Date.now(),
    };
  }

  const mocks = {
    getLastSynthesis: mock(() => Promise.resolve(lastSynthesisResult)) as Mock<
      Voice['getLastSynthesis']
    >,
    voiceCreate: mock(() => Promise.resolve({} as any)) as Mock<
      HumeClient['tts']['voices']['create']
    >,
  };

  const defaultSettings: Awaited<ReturnType<typeof getSettings>> = {
    reporter: {
      mode: 'pretty',
      json: mock(() => {}),
      info: mock(() => {}),
      withSpinner: mock((message, callback) => callback()),
    },
    hume: {
      tts: { voices: { create: mocks.voiceCreate } },
    } as unknown as HumeClient,
    env: { HUME_API_KEY: 'test-key' },
    session: {} as ConfigData,
    globalConfig: {} as ConfigData,
  };
  const voice = new Voice();
  voice.getSettings = mock((_opts: unknown) => Promise.resolve(defaultSettings));
  voice.getLastSynthesis = mocks.getLastSynthesis;

  return { mocks, voice };
};

describe('save voice command', () => {
  test('succeeds in the simple case', async () => {
    const { voice, mocks } = setupTest(null);

    await expect(
      voice.save({
        name: 'test-voice',
        generationId: 'gen_1',
      })
    ).resolves;

    expect(mocks.voiceCreate.mock.calls).toEqual([
      [
        {
          name: 'test-voice',
          generationId: 'gen_1',
        },
      ],
    ]);
  });
  test('succeeds with --last if there is a previous synthesis with a single generation', async () => {
    const { voice } = setupTest(1);

    await expect(
      voice.save({
        name: 'test-voice',
        last: true,
      })
    ).resolves;
  });

  test('throws error when last is used without previous generation', async () => {
    const { voice } = setupTest(null);

    await expect(
      voice.save({
        name: 'test-voice',
        last: true,
      })
    ).rejects.toThrow('No previous generation found to save as voice');
  });

  test('uses specified generation when last is used with index', async () => {
    const { mocks, voice } = setupTest(3);

    await voice.save({
      name: 'test-voice',
      last: true,
      lastIndex: 2,
    });

    expect(mocks.voiceCreate.mock.calls).toEqual([
      [
        {
          name: 'test-voice',
          generationId: 'gen_2',
        },
      ],
    ]);
  });
});
