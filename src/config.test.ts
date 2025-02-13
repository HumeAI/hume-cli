import { expect, test, mock, describe, beforeEach, type Mock } from 'bun:test';
import {
  showGlobalConfig,
  showSession,
  setGlobalConfig,
  setSessionConfig,
  endSession,
  resetGlobalConfig,
  type ConfigData,
} from './config';
import * as common from './common';

describe('Config management', () => {
  const mockConfig: ConfigData = {
    tts: {
      voiceName: 'test_voice',
      voiceId: 'voice123',
      outputDir: '/test/output',
      play: 'all',
      format: 'wav',
    },
    json: true,
    apiKey: 'test-api-key',
  };

  const mockSettings = {
    globalConfig: { ...mockConfig },
    session: { ...mockConfig },
    reporter: {
      json: mock((_: unknown) => {}) as unknown as Mock<common.Reporter['json']>,
      info: mock((_: unknown) => {}) as unknown as Mock<common.Reporter['info']>,
      withSpinner: mock((msg, callback) => callback()) as unknown as Mock<
        common.Reporter['withSpinner']
      >,
    },
  };

  beforeEach(() => {
    // Reset all mocks before each test
    mockSettings.reporter.json.mockReset();
    mockSettings.reporter.info.mockReset();
    mockSettings.reporter.withSpinner.mockReset();

    // Mock getSettings and makeReporter
    mock.module('./common', () => ({
      ...common,
      getSettings: () => Promise.resolve(mockSettings),
      makeReporter: () => mockSettings.reporter,
    }));
  });

  describe('show commands', () => {
    test('showGlobalConfig displays global config', async () => {
      await showGlobalConfig();
      expect(mockSettings.reporter.json).toHaveBeenCalledWith(mockConfig);
    });

    test('showSession displays session config', async () => {
      await showSession();
      expect(mockSettings.reporter.json).toHaveBeenCalledWith(mockConfig);
    });
  });

  describe('set commands', () => {
    const mockWriteFile = mock(() => Promise.resolve());
    mock.module('node:fs/promises', () => ({
      writeFile: mockWriteFile,
      readFile: mock(() => Promise.resolve(JSON.stringify(mockConfig))),
    }));

    test('setGlobalConfig updates global config', async () => {
      await setGlobalConfig({
        name: 'tts.voiceName',
        value: 'new_voice',
      });

      expect(mockSettings.reporter.info.mock.calls).toEqual([['global config updated']]);
      expect(mockSettings.reporter.json.mock.calls).toEqual([[{ 'tts.voiceName': 'new_voice' }]]);
    });

    test('setSessionConfig updates session config', async () => {
      await setSessionConfig({
        name: 'tts.format',
        value: 'mp3',
      });

      expect(mockSettings.reporter.info).toHaveBeenCalledWith('session config updated');
      expect(mockSettings.reporter.json).toHaveBeenCalledWith({
        'tts.format': 'mp3',
      });
    });

    test('setConfig validates input values', async () => {
      await expect(
        setGlobalConfig({
          name: 'tts.play',
          value: 'invalid',
        })
      ).rejects.toThrow('Invalid value for tts.play');
    });
  });

  describe('clear commands', () => {
    test('endSession clears session config', async () => {
      await endSession();
      expect(mockSettings.reporter.info).toHaveBeenCalledWith('session config cleared');
    });

    test('resetGlobalConfig clears global config', async () => {
      await resetGlobalConfig();
      expect(mockSettings.reporter.info).toHaveBeenCalledWith('global config cleared');
    });
  });
});
