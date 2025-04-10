import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { Voices } from './voices';
import { HumeClient } from 'hume';
import { type Page } from 'hume/core';

describe('Voices', () => {
  const mockHume = {
    tts: {
      voices: {
        create: mock(() => Promise.resolve({ name: 'test-voice', id: 'voice123' })),
        list: mock(
          (): Promise<Partial<Page<unknown>>> =>
            Promise.resolve({
              hasNextPage: () => true,
              data: [
                { name: 'voice1', id: 'id1' },
                { name: 'voice2', id: 'id2' },
              ],
            })
        ),
        delete: mock(() => Promise.resolve({ success: true })),
      },
    },
  } as unknown as HumeClient;

  // Mock reporter
  const mockReporter = {
    mode: 'pretty',
    json: mock((_: unknown) => {}),
    info: mock((_: string) => {}),
    warn: mock((_: string) => {}),
    withSpinner: mock(async (_, callback) => await callback()),
  };

  // Reset mocks before each test
  beforeEach(() => {
    (mockHume.tts.voices.create as any).mockClear();
    (mockHume.tts.voices.list as any).mockClear();
    (mockHume.tts.voices.delete as any).mockClear();
    mockReporter.info.mockClear();
    mockReporter.json.mockClear();
    mockReporter.withSpinner.mockClear();
  });

  // Mock getSettings
  const mockGetSettings = mock(() =>
    Promise.resolve({
      reporter: mockReporter,
      hume: mockHume,
      globalConfig: {},
      session: {},
      env: {},
    })
  );

  describe('list', () => {
    test('lists custom voices by default', async () => {
      const voices = new Voices();
      voices.getSettings = mockGetSettings;

      await voices.list({});

      expect(mockHume.tts.voices.list).toHaveBeenCalledTimes(1);
      expect(mockHume.tts.voices.list).toHaveBeenCalledWith({ provider: 'CUSTOM_VOICE' });
      expect(mockReporter.info.mock.calls).toEqual([
        ['voice1 (id1)'],
        ['voice2 (id2)'],
        ['There are more voices available. Use --page-number 1 to retrieve them.'],
      ]);
      expect(mockReporter.json).toHaveBeenCalledTimes(1);
    });

    test('can list Hume AI voices', async () => {
      const voices = new Voices();
      voices.getSettings = mockGetSettings;

      await voices.list({ provider: 'HUME_AI' });

      expect(mockHume.tts.voices.list).toHaveBeenCalledTimes(1);
      expect(mockHume.tts.voices.list).toHaveBeenCalledWith({ provider: 'HUME_AI' });
    });

    // No need for the sharedVoices test as we're now using provider directly
  });

  describe('delete', () => {
    test('deletes a voice by name', async () => {
      const voices = new Voices();
      voices.getSettings = mockGetSettings;

      await voices.delete({ name: 'test-voice' });

      expect(mockHume.tts.voices.delete).toHaveBeenCalledTimes(1);
      expect(mockHume.tts.voices.delete).toHaveBeenCalledWith({ name: 'test-voice' });
      expect(mockReporter.info).toHaveBeenCalledWith('Voice "test-voice" deleted successfully');
    });
  });

  describe('save', () => {
    test('saves a voice with generation ID', async () => {
      const voices = new Voices();
      voices.getSettings = mockGetSettings;

      await voices.save({
        name: 'test-voice',
        generationId: 'gen123',
      });

      expect(mockHume.tts.voices.create).toHaveBeenCalledTimes(1);
      expect(mockHume.tts.voices.create).toHaveBeenCalledWith({
        name: 'test-voice',
        generationId: 'gen123',
      });
    });

    test('succeeds with --last if there is a previous synthesis with a single generation', async () => {
      const voices = new Voices();
      voices.getSettings = mockGetSettings;
      // Mock a single generation in history
      voices.getLastSynthesis = mock(() =>
        Promise.resolve({
          ids: ['gen_1'],
          timestamp: Date.now(),
        })
      );

      await voices.save({
        name: 'test-voice',
        last: true,
      });

      expect(mockHume.tts.voices.create).toHaveBeenCalledWith({
        name: 'test-voice',
        generationId: 'gen_1',
      });
    });

    test('throws error when last is used without previous generation', async () => {
      const voices = new Voices();
      voices.getSettings = mockGetSettings;
      // Mock no previous generation
      voices.getLastSynthesis = mock(() => Promise.resolve(null));

      await expect(
        voices.save({
          name: 'test-voice',
          last: true,
        })
      ).rejects.toThrow('No previous generation found to save as voice');
    });

    test('uses specified generation when last is used with index', async () => {
      const voices = new Voices();
      voices.getSettings = mockGetSettings;
      // Mock multiple generations in history
      voices.getLastSynthesis = mock(() =>
        Promise.resolve({
          ids: ['gen_1', 'gen_2', 'gen_3'],
          timestamp: Date.now(),
        })
      );

      await voices.save({
        name: 'test-voice',
        last: true,
        lastIndex: 2,
      });

      expect(mockHume.tts.voices.create).toHaveBeenCalledWith({
        name: 'test-voice',
        generationId: 'gen_2',
      });
    });
  });
});
